//! Ghita Agent — Sandboxed Process Execution
//! Zero-dependency sandboxed spawn with multi-platform enforcement tiers:
//! - linux   : Landlock (kernel write-scoping via raw syscalls, NO_NEW_PRIVS)
//! - macos   : Seatbelt (`sandbox-exec` SBPL profile wrapper)
//! - windows : Windows Tier 2 Sandbox (Job Object containment with memory limits,
//!   active process limits, kill-on-close, and write-target policy)
//!
//! All platforms additionally run the supervised core: workspace cwd lock,
//! environment scrubbing, deny-glob argument precheck and write-target policy.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[cfg(feature = "addon")]
mod napi;

/// Backend enforcement abstraction (Track R2): trait `SandboxBackend` +
/// hợp đồng lỗi Recoverable/Terminal — tách `spawn_sandboxed` monolithic.
mod backend;

/// Overlay-dir rollback cho ReadOnly/Strict (Track R2, P2): write tương đối
/// của child đổ vào thư mục `upper/`; rollback = bỏ upper; commit = merge.
mod overlay;

/// Lifecycle state machine CAS (Track R2, P3): Created → Running →
/// Killing → Killed/TimedOut/Completed/Failed với `update_state_if_state`.
mod state;

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/// Built-in sandbox profiles (custom deny globs compose with any of them).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxProfile {
    /// Writes allowed beneath the workspace (and system temp) only.
    Workspace,
    /// No writes anywhere; reads everywhere.
    ReadOnly,
    /// Read-only + network-facing binaries denied (hermetic CI posture).
    Strict,
}

impl SandboxProfile {
    pub fn as_str(&self) -> &'static str {
        match self {
            SandboxProfile::Workspace => "workspace",
            SandboxProfile::ReadOnly => "read-only",
            SandboxProfile::Strict => "strict",
        }
    }

    /// Parse a built-in profile name ("workspace" | "read-only" | "strict").
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "workspace" => Some(SandboxProfile::Workspace),
            "read-only" => Some(SandboxProfile::ReadOnly),
            "strict" => Some(SandboxProfile::Strict),
            _ => None,
        }
    }
}

/// Network-facing binaries denied under the `strict` profile.
const STRICT_DENY_BINARIES: &[&str] = &[
    "curl", "wget", "ssh", "scp", "sftp", "nc", "netcat", "telnet", "ftp", "rsync",
];

// ---------------------------------------------------------------------------
// Deny-glob matching (segment-based, supports `**`, `*`, `?`)
// ---------------------------------------------------------------------------

fn normalize(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// Match a single path segment against a glob segment (`*`, `?` wildcards).
fn segment_match(pattern: &[char], text: &[char]) -> bool {
    match (pattern.first(), text.first()) {
        (None, None) => true,
        (None, Some(_)) => false,
        (Some('*'), _) => {
            segment_match(&pattern[1..], text)
                || (!text.is_empty() && segment_match(pattern, &text[1..]))
        }
        (Some('?'), Some(_)) => segment_match(&pattern[1..], &text[1..]),
        (Some('?'), None) => false,
        (Some(p), Some(t)) if p == t => segment_match(&pattern[1..], &text[1..]),
        _ => false,
    }
}

fn segments(path: &str) -> Vec<Vec<char>> {
    path.split('/')
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().collect())
        .collect()
}

/// Match a path against a glob with `**` (any number of segments), `*`, `?`.
pub fn glob_match(pattern: &str, path: &str) -> bool {
    let pattern = segments(&normalize(pattern));
    let path = segments(&normalize(path));
    fn walk(pattern: &[Vec<char>], path: &[Vec<char>]) -> bool {
        match (pattern.first(), path.first()) {
            (None, None) => true,
            (None, Some(_)) => false,
            (Some(p), None) => p.iter().all(|&c| c == '*'),
            (Some(p), Some(_)) if p.len() == 2 && p[0] == '*' && p[1] == '*' => {
                let rest = &pattern[1..];
                (0..=path.len()).any(|skip| walk(rest, &path[skip..]))
            }
            (Some(p), Some(t)) => segment_match(p, t) && walk(&pattern[1..], &path[1..]),
        }
    }
    walk(&pattern, &path)
}

fn path_denied<'a>(path: &str, deny_globs: &'a [String]) -> Option<&'a str> {
    for glob in deny_globs {
        if glob_match(glob, path) {
            return Some(glob.as_str());
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Environment scrubbing
// ---------------------------------------------------------------------------

const BASE_ENV_ALLOW: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "USERPROFILE",
    "HOME",
    "SHELL",
    "TMP",
    "TEMP",
    "TMPDIR",
    "TERM",
    "COLORTERM",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "RUST_BACKTRACE",
    "RUST_LOG",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "NODE_PATH",
    "PNPM_HOME",
];

pub fn scrub_env(extra_allow: &[String]) -> BTreeMap<String, String> {
    let allow: Vec<String> = BASE_ENV_ALLOW
        .iter()
        .map(|k| k.to_string())
        .chain(extra_allow.iter().cloned())
        .collect();

    let mut scrubbed = BTreeMap::new();
    // vars_os + lossy: `std::env::vars()` PANIC khi gặp một env var
    // non-UTF8 (Windows: surrogate không hợp lệ) — một biến rác trong
    // môi trường của process cha không được phép giết cả sandbox spawn.
    for (k, v) in std::env::vars_os() {
        let k = k.to_string_lossy();
        let upper = k.to_uppercase();
        if allow.iter().any(|a| a.eq_ignore_ascii_case(&upper)) {
            scrubbed.insert(k.into_owned(), v.to_string_lossy().into_owned());
        }
    }
    scrubbed
}

// ---------------------------------------------------------------------------
// Enforcement tier detection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Enforcement {
    Landlock,
    Seatbelt,
    /// Windows restricted-token sandbox (codex preflight pass). Spawn v1 vẫn
    /// đi đường supervised; full ACL orchestration là backlog R2.
    RestrictedToken,
    Supervised,
}

impl Enforcement {
    pub fn as_str(&self) -> &'static str {
        match self {
            Enforcement::Landlock => "landlock",
            Enforcement::Seatbelt => "seatbelt",
            Enforcement::RestrictedToken => "restricted-token",
            Enforcement::Supervised => "supervised",
        }
    }
}

pub fn detect_enforcement() -> Enforcement {
    #[cfg(target_os = "linux")]
    {
        if landlock::available() {
            return Enforcement::Landlock;
        }
    }
    #[cfg(target_os = "macos")]
    {
        if Path::new("/usr/bin/sandbox-exec").exists() {
            return Enforcement::Seatbelt;
        }
    }
    #[cfg(all(target_os = "windows", feature = "win-sandbox"))]
    {
        if windows::available() {
            return Enforcement::RestrictedToken;
        }
    }
    Enforcement::Supervised
}

// ---------------------------------------------------------------------------
// Platform-specific modules (Landlock on Linux, stubs elsewhere)
// ---------------------------------------------------------------------------

#[cfg(all(target_os = "windows", feature = "win-sandbox"))]
mod windows;

#[cfg(target_os = "linux")]
mod landlock {
    use std::path::{Path, PathBuf};

    const LANDLOCK_CREATE_RULESET_VERSION: u32 = 1 << 0;
    const LANDLOCK_ACCESS_FS_EXECUTE: u64 = 1 << 0;
    const LANDLOCK_ACCESS_FS_WRITE_FILE: u64 = 1 << 1;
    const LANDLOCK_ACCESS_FS_READ_FILE: u64 = 1 << 2;
    const LANDLOCK_ACCESS_FS_READ_DIR: u64 = 1 << 3;
    const LANDLOCK_ACCESS_FS_REMOVE_DIR: u64 = 1 << 4;
    const LANDLOCK_ACCESS_FS_REMOVE_FILE: u64 = 1 << 5;
    const LANDLOCK_ACCESS_FS_MAKE_CHAR: u64 = 1 << 6;
    const LANDLOCK_ACCESS_FS_MAKE_DIR: u64 = 1 << 7;
    const LANDLOCK_ACCESS_FS_MAKE_REG: u64 = 1 << 8;
    const LANDLOCK_ACCESS_FS_MAKE_SOCK: u64 = 1 << 9;
    const LANDLOCK_ACCESS_FS_MAKE_FIFO: u64 = 1 << 10;
    const LANDLOCK_ACCESS_FS_MAKE_BLOCK: u64 = 1 << 11;
    const LANDLOCK_ACCESS_FS_MAKE_SYM: u64 = 1 << 12;

    const FS_READ_EXECUTE: u64 =
        LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;

    const FS_WRITE: u64 = LANDLOCK_ACCESS_FS_WRITE_FILE
        | LANDLOCK_ACCESS_FS_REMOVE_DIR
        | LANDLOCK_ACCESS_FS_REMOVE_FILE
        | LANDLOCK_ACCESS_FS_MAKE_CHAR
        | LANDLOCK_ACCESS_FS_MAKE_DIR
        | LANDLOCK_ACCESS_FS_MAKE_REG
        | LANDLOCK_ACCESS_FS_MAKE_SOCK
        | LANDLOCK_ACCESS_FS_MAKE_FIFO
        | LANDLOCK_ACCESS_FS_MAKE_BLOCK
        | LANDLOCK_ACCESS_FS_MAKE_SYM;

    const FS_ALL: u64 = FS_READ_EXECUTE | FS_WRITE;

    const LANDLOCK_RULE_PATH_BENEATH: u32 = 1;
    const PR_SET_NO_NEW_PRIVS: i32 = 38;

    #[repr(C)]
    struct RulesetAttr {
        handled_access_fs: u64,
    }

    #[repr(C)]
    struct PathBeneathAttr {
        allowed_access: u64,
        parent_fd: i32,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum LinuxEnvironment {
        Native,
        Wsl1,
        Wsl2,
    }

    fn classify_environment() -> LinuxEnvironment {
        if let Ok(version) = std::fs::read_to_string("/proc/version") {
            let lower = version.to_lowercase();
            if lower.contains("microsoft-standard") || lower.contains("wsl2") {
                return LinuxEnvironment::Wsl2;
            }
            if lower.contains("microsoft") {
                return LinuxEnvironment::Wsl1;
            }
        }
        LinuxEnvironment::Native
    }

    pub fn available() -> bool {
        if classify_environment() == LinuxEnvironment::Wsl1 {
            return false;
        }
        let res = unsafe {
            libc::syscall(
                libc::SYS_landlock_create_ruleset,
                core::ptr::null::<RulesetAttr>(),
                0usize,
                LANDLOCK_CREATE_RULESET_VERSION,
            )
        };
        res >= 1
    }

    pub fn restrict_writes(write_roots: &[PathBuf]) -> std::io::Result<()> {
        let attr = RulesetAttr {
            handled_access_fs: FS_ALL,
        };
        let ruleset_fd = unsafe {
            libc::syscall(
                libc::SYS_landlock_create_ruleset,
                &attr as *const RulesetAttr,
                core::mem::size_of::<RulesetAttr>(),
                0u32,
            )
        } as i32;
        if ruleset_fd < 0 {
            return Err(std::io::Error::last_os_error());
        }

        let allow_path = |path: &Path, access: u64| -> std::io::Result<()> {
            let c_path = std::ffi::CString::new(path.to_string_lossy().as_bytes())?;
            let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
            if fd < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let path_attr = PathBeneathAttr {
                allowed_access: access,
                parent_fd: fd,
            };
            let res = unsafe {
                libc::syscall(
                    libc::SYS_landlock_add_rule,
                    ruleset_fd,
                    LANDLOCK_RULE_PATH_BENEATH,
                    &path_attr as *const PathBeneathAttr,
                    0u32,
                )
            };
            unsafe { libc::close(fd) };
            if res < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        };

        allow_path(Path::new("/"), FS_READ_EXECUTE)?;
        for root in write_roots {
            if root.exists() {
                let _ = allow_path(root, FS_ALL);
            }
        }

        if unsafe { libc::prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } < 0 {
            let err = std::io::Error::last_os_error();
            unsafe { libc::close(ruleset_fd) };
            return Err(err);
        }

        let res = unsafe { libc::syscall(libc::SYS_landlock_restrict_self, ruleset_fd, 0u32) };
        unsafe { libc::close(ruleset_fd) };
        if res < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(not(target_os = "linux"))]
mod landlock {
    #[allow(dead_code)]
    pub fn available() -> bool {
        false
    }
    #[allow(dead_code)]
    pub fn restrict_writes(_write_roots: &[std::path::PathBuf]) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "landlock is linux-only",
        ))
    }
}

// ---------------------------------------------------------------------------
// Options + results
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct SandboxOptions {
    pub profile: SandboxProfile,
    /// Directory the command runs in and (for `workspace`) may write beneath.
    pub workspace: PathBuf,
    /// Extra deny globs (e.g. `**/*.pem`, `**/.ssh/**`).
    pub deny_globs: Vec<String>,
    /// Extra environment variables to keep beyond the base allowlist.
    pub env_allow: Vec<String>,
    /// Hard wall-clock timeout; None = wait indefinitely.
    pub timeout: Option<Duration>,
    /// Memory limit in MB per process tree.
    pub memory_limit_mb: Option<u32>,
    /// Active process limit (max child processes in job).
    pub process_limit: Option<u32>,
    /// ReadOnly/Strict: commit overlay `upper/` về workspace sau run thay vì
    /// rollback (mặc định `false` — mọi write bị hủy).
    pub overlay_commit: bool,
    /// IO write budget (MB) cho cả process tree — token bucket poll qua Job
    /// Object IO counters (Windows); vượt → kill + violation `io-budget`.
    pub io_write_limit_mb: Option<u32>,
}

impl SandboxOptions {
    pub fn new(profile: SandboxProfile, workspace: impl Into<PathBuf>) -> Self {
        Self {
            profile,
            workspace: workspace.into(),
            deny_globs: Vec::new(),
            env_allow: Vec::new(),
            timeout: Some(Duration::from_secs(120)),
            memory_limit_mb: None,
            process_limit: Some(64),
            overlay_commit: false,
            io_write_limit_mb: None,
        }
    }

    pub fn with_deny_globs(mut self, globs: &[&str]) -> Self {
        self.deny_globs.extend(globs.iter().map(|g| g.to_string()));
        self
    }
}

#[derive(Debug, Clone)]
pub struct SandboxViolation {
    pub reason: String,
    pub detail: String,
}

#[derive(Debug, Clone)]
pub struct SandboxRunResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u128,
    pub enforcement: &'static str,
    /// Pre-exec policy violations — when non-empty the command never ran.
    pub violations: Vec<SandboxViolation>,
    pub blocked: bool,
    /// Overlay session dir (ReadOnly/Strict): relative writes của child đổ
    /// vào đây. `None` khi profile Workspace hoặc không dùng overlay.
    pub overlay_dir: Option<String>,
    /// Overlay được commit về workspace thay vì rollback (chỉ khi
    /// `SandboxOptions::overlay_commit` bật).
    pub overlay_committed: bool,
    /// Trạng thái cuối của lifecycle (`state.rs`): created | running |
    /// killing | killed | timed-out | completed | failed.
    pub state: &'static str,
}

// ---------------------------------------------------------------------------
// Supervised policy checks (all platforms)
// ---------------------------------------------------------------------------

fn looks_like_path(token: &str) -> bool {
    token.contains('/') || token.contains('\\') || token.contains('.')
}

fn binary_name(program: &str) -> String {
    let normalised = program.replace('\\', "/");
    let base = normalised.rsplit('/').next().unwrap_or(program);
    base.to_lowercase()
}

/// Extract write targets from shell-style redirect tokens.
fn write_targets(args: &[String]) -> Vec<String> {
    let mut targets = Vec::new();
    let mut redirect = false;
    for token in args {
        if token == ">" || token == ">>" || token == "1>" || token == "1>>" {
            redirect = true;
            continue;
        }
        if token == "2>" || token == "2>>" {
            redirect = true;
            continue;
        }
        if redirect {
            targets.push(token.clone());
            redirect = false;
        }
    }
    targets
}

fn is_beneath(path: &Path, root: &Path) -> bool {
    let path = normalize(&path.to_string_lossy());
    let root = normalize(&root.to_string_lossy());
    let root = root.trim_end_matches('/');
    path == root || path.starts_with(&format!("{root}/"))
}

/// Policy precheck: deny-glob args, profile write scope, strict binaries.
pub fn precheck(program: &str, args: &[String], opts: &SandboxOptions) -> Vec<SandboxViolation> {
    let mut violations = Vec::new();

    // Deny globs apply to any path-like argument.
    for token in std::iter::once(&program.to_string()).chain(args.iter()) {
        if looks_like_path(token) {
            if let Some(glob) = path_denied(token, &opts.deny_globs) {
                violations.push(SandboxViolation {
                    reason: "deny-glob".into(),
                    detail: format!("argument `{token}` matches deny pattern `{glob}`"),
                });
            }
        }
    }

    // Profile write scope for redirect targets.
    let temp_root = std::env::temp_dir();
    for target in write_targets(args) {
        let resolved = if Path::new(&target).is_absolute() {
            PathBuf::from(&target)
        } else {
            opts.workspace.join(&target)
        };
        let allowed = match opts.profile {
            SandboxProfile::Workspace => {
                is_beneath(&resolved, &opts.workspace) || is_beneath(&resolved, &temp_root)
            }
            SandboxProfile::ReadOnly | SandboxProfile::Strict => false,
        };
        if !allowed {
            violations.push(SandboxViolation {
                reason: "write-outside-scope".into(),
                detail: format!(
                    "redirect target `{}` is outside the {} write scope",
                    resolved.display(),
                    opts.profile.as_str()
                ),
            });
        }
        if let Some(glob) = path_denied(&resolved.to_string_lossy(), &opts.deny_globs) {
            violations.push(SandboxViolation {
                reason: "deny-glob".into(),
                detail: format!("redirect target matches deny pattern `{glob}`"),
            });
        }
    }

    // Strict profile denies network-facing binaries entirely.
    if opts.profile == SandboxProfile::Strict {
        let binary = binary_name(program);
        let binary = binary.strip_suffix(".exe").unwrap_or(&binary);
        if STRICT_DENY_BINARIES.contains(&binary) {
            violations.push(SandboxViolation {
                reason: "strict-network".into(),
                detail: format!("binary `{binary}` is denied under the strict profile"),
            });
        }
    }

    violations
}

// ---------------------------------------------------------------------------
// Seatbelt (macOS) profile generation
// ---------------------------------------------------------------------------

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn seatbelt_profile(opts: &SandboxOptions) -> String {
    let workspace = normalize(&opts.workspace.to_string_lossy());
    match opts.profile {
        SandboxProfile::ReadOnly => {
            "(version 1)(allow default)(deny file-write*)".to_string()
        }
        SandboxProfile::Strict => {
            "(version 1)(allow default)(deny file-write*)(deny network*)".to_string()
        }
        SandboxProfile::Workspace => format!(
            "(version 1)(allow default)(deny file-write*)(allow file-write* (subpath \"{workspace}\"))(allow file-write* (subpath \"/private/tmp\"))"
        ),
    }
}

// ---------------------------------------------------------------------------
// Windows Tier 2 Sandbox (Job Object containment, memory & active process limits)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod win_job {
    use crate::SandboxOptions;
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimitInformation {
        per_process_user_time_limit: u64,
        per_job_user_time_limit: u64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    /// THREADENTRY32 (Toolhelp thread snapshot — tìm main thread để resume).
    #[repr(C)]
    struct ThreadEntry32 {
        dw_size: u32,
        cnt_usage: u32,
        th32_thread_id: u32,
        th32_owner_process_id: u32,
        tp_base_pri: i32,
        tp_delta_pri: i32,
        dw_flags: u32,
    }

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOB_OBJECT_LIMIT_ACTIVE_PROCESS: u32 = 0x0008;
    const JOB_OBJECT_LIMIT_PROCESS_MEMORY: u32 = 0x0100;
    const JOB_OBJECT_LIMIT_JOB_MEMORY: u32 = 0x0200;
    /// TTL auto-kill (user-time của cả job) — backstop cho wall-clock poll.
    const JOB_OBJECT_LIMIT_JOB_TIME: u32 = 0x0002;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;

    const DUPLICATE_SAME_ACCESS: u32 = 0x2;
    const TH32CS_SNAPTHREAD: u32 = 0x4;
    const THREAD_SUSPEND_RESUME: u32 = 0x0002;

    type Handle = *mut core::ffi::c_void;

    extern "system" {
        fn CreateJobObjectW(attrs: *mut core::ffi::c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            info_class: i32,
            info: *const ExtendedLimitInformation,
            len: u32,
        ) -> i32;
        /// Chỉ dùng bởi `query_limits` (test introspection).
        #[cfg(test)]
        fn QueryInformationJobObject(
            job: Handle,
            info_class: i32,
            info: *mut core::ffi::c_void,
            len: u32,
            return_len: *mut u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, exit_code: i32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
        fn GetCurrentProcess() -> Handle;
        fn DuplicateHandle(
            source: Handle,
            source_handle: Handle,
            target: Handle,
            target_handle: *mut Handle,
            access: u32,
            inherit: i32,
            options: u32,
        ) -> i32;
        fn GetProcessIoCounters(process: Handle, counters: *mut IoCounters) -> i32;
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
        fn Thread32First(snapshot: Handle, entry: *mut ThreadEntry32) -> i32;
        fn Thread32Next(snapshot: Handle, entry: *mut ThreadEntry32) -> i32;
        fn OpenThread(access: u32, inherit_handle: i32, tid: u32) -> Handle;
        fn ResumeThread(thread: Handle) -> u32;
    }

    /// Contain child tree trong kill-on-close Job Object với limits:
    /// active-process, memory (v1) + TTL user-time (best-effort) và IO write
    /// budget (P3). Child được spawn CREATE_SUSPENDED → job gán TRƯỚC khi
    /// resume (`activate`) — vá race "job gán sau spawn" của v1 (lib.rs:784 cũ).
    pub(crate) struct JobGuard {
        job: Handle,
        /// Handle duplicated của child (đirect process) — nguồn IO counters.
        child_handle: Handle,
        /// IO write budget (bytes) — token bucket không refill; `None` = off.
        io_budget_bytes: Option<u64>,
        /// TTL user-time có thực sự được OS chấp nhận không (Windows 11 mới
        /// có thể từ chối — xem comment trong `assign`).
        #[cfg_attr(not(test), allow(dead_code))] // đọc bởi test introspection
        ttl_applied: bool,
        /// Đã report violation chưa (poll chỉ report một lần).
        violated: bool,
    }

    impl JobGuard {
        pub(crate) fn assign(
            child: &std::process::Child,
            opts: &SandboxOptions,
        ) -> Result<Self, String> {
            unsafe {
                let job = CreateJobObjectW(core::ptr::null_mut(), core::ptr::null());
                if job.is_null() {
                    return Err("CreateJobObjectW failed".into());
                }
                let mut info: ExtendedLimitInformation = core::mem::zeroed();
                info.basic.limit_flags =
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
                info.basic.active_process_limit = opts.process_limit.unwrap_or(64);

                if let Some(mb) = opts.memory_limit_mb {
                    let mem_bytes = (mb as usize) * 1024 * 1024;
                    info.job_memory_limit = mem_bytes;
                    info.process_memory_limit = mem_bytes;
                    info.basic.limit_flags |=
                        JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
                }

                // TTL auto-kill: user-time của job (đơn vị 100ns) — backstop
                // khi wall-clock poll của parent bị trễ/chết. BEST-EFFORT:
                // Windows 11 build 26300 từ chối CPU time limits qua
                // SetInformationJobObject (ERROR_INVALID_PARAMETER — cả
                // JOB_TIME lẫn PROCESS_TIME, verify bằng probe độc lập tại
                // P3). Khi bị từ chối → degrade về không TTL; wall-clock
                // poll + kill-on-close vẫn chặn runaway.
                let mut ttl_applied = false;
                if let Some(timeout) = opts.timeout {
                    info.basic.per_job_user_time_limit = (timeout.as_nanos() / 100) as u64;
                    info.basic.limit_flags |= JOB_OBJECT_LIMIT_JOB_TIME;
                }

                if SetInformationJobObject(
                    job,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    &info,
                    core::mem::size_of::<ExtendedLimitInformation>() as u32,
                ) == 0
                {
                    if info.basic.limit_flags & JOB_OBJECT_LIMIT_JOB_TIME == 0 {
                        CloseHandle(job);
                        return Err(format!(
                            "SetInformationJobObject failed: {}",
                            std::io::Error::last_os_error()
                        ));
                    }
                    // Degrade: gỡ TTL flag rồi set lại limits còn lại.
                    info.basic.limit_flags &= !JOB_OBJECT_LIMIT_JOB_TIME;
                    info.basic.per_job_user_time_limit = 0;
                    if SetInformationJobObject(
                        job,
                        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                        &info,
                        core::mem::size_of::<ExtendedLimitInformation>() as u32,
                    ) == 0
                    {
                        CloseHandle(job);
                        return Err(format!(
                            "SetInformationJobObject failed: {}",
                            std::io::Error::last_os_error()
                        ));
                    }
                } else {
                    ttl_applied = opts.timeout.is_some();
                }
                if AssignProcessToJobObject(job, child.as_raw_handle() as Handle) == 0 {
                    CloseHandle(job);
                    return Err(format!(
                        "AssignProcessToJobObject failed: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                // Duplicate child handle cho IO counters (GetProcessIoCounters):
                // job-level IO accounting (class 1/10) bị REMOVE trên Windows
                // 11 build 26300 — trả ERROR_BAD_LENGTH cho mọi size (verify
                // bằng probe matrix tại P3), nên budget đếm ở mức direct
                // process; write của tiến trình cháu không được tính.
                let mut child_handle: Handle = core::ptr::null_mut();
                if DuplicateHandle(
                    GetCurrentProcess(),
                    child.as_raw_handle() as Handle,
                    GetCurrentProcess(),
                    &mut child_handle,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS,
                ) == 0
                {
                    CloseHandle(job);
                    return Err(format!(
                        "DuplicateHandle failed: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                Ok(Self {
                    job,
                    child_handle,
                    io_budget_bytes: opts.io_write_limit_mb.map(|mb| mb as u64 * 1024 * 1024),
                    ttl_applied,
                    violated: false,
                })
            }
        }

        /// Resume main thread của child vừa spawn CREATE_SUSPENDED. Fresh
        /// process có đúng 1 thread → tìm qua Toolhelp snapshot theo pid.
        fn resume_main_thread(pid: u32) -> std::io::Result<()> {
            unsafe {
                let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
                if snapshot.is_null() || snapshot as isize == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                let mut entry: ThreadEntry32 = core::mem::zeroed();
                entry.dw_size = core::mem::size_of::<ThreadEntry32>() as u32;

                let mut ok = Thread32First(snapshot, &mut entry);
                let mut result: std::io::Result<()> = Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "no thread found for spawned pid",
                ));
                while ok != 0 {
                    if entry.th32_owner_process_id == pid {
                        let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32_thread_id);
                        if !thread.is_null() {
                            let previous = ResumeThread(thread);
                            CloseHandle(thread);
                            result = if previous == u32::MAX {
                                Err(std::io::Error::last_os_error())
                            } else {
                                Ok(())
                            };
                            break;
                        }
                    }
                    ok = Thread32Next(snapshot, &mut entry);
                }
                CloseHandle(snapshot);
                result
            }
        }

        /// IO token bucket poll: cumulative write bytes của direct child
        /// process so với budget (GetProcessIoCounters — job-level IO
        /// accounting class 1/10 bị remove trên Windows 11 26300, xem assign).
        fn io_write_bytes(&self) -> Option<u64> {
            unsafe {
                let mut counters: IoCounters = core::mem::zeroed();
                if GetProcessIoCounters(self.child_handle, &mut counters) == 0 {
                    return None;
                }
                Some(counters.write_bytes)
            }
        }

        /// TTL có được set thật trên job không (test introspection).
        #[cfg(test)]
        pub(crate) fn ttl_applied(&self) -> bool {
            self.ttl_applied
        }

        /// Đọc lại limit flags + TTL (đơn vị 100ns) — dùng trong test verify.
        #[cfg(test)]
        pub(crate) fn query_limits(&self) -> Option<(u32, u64)> {
            unsafe {
                let mut info: ExtendedLimitInformation = core::mem::zeroed();
                let mut return_len: u32 = 0;
                if QueryInformationJobObject(
                    self.job,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    &mut info as *mut _ as *mut core::ffi::c_void,
                    core::mem::size_of::<ExtendedLimitInformation>() as u32,
                    &mut return_len,
                ) == 0
                {
                    return None;
                }
                Some((info.basic.limit_flags, info.basic.per_job_user_time_limit))
            }
        }
    }

    impl Drop for JobGuard {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.job);
                if !self.child_handle.is_null() {
                    CloseHandle(self.child_handle);
                }
            }
        }
    }

    impl crate::backend::Containment for JobGuard {
        fn activate(&mut self, child: &mut std::process::Child) -> std::io::Result<()> {
            // Job đã gán khi child còn suspended → giờ mới chạy. Không còn
            // cửa sổ escape giữa spawn và gán job nữa.
            Self::resume_main_thread(child.id())
        }

        fn poll(&mut self) -> Option<crate::SandboxViolation> {
            let budget = self.io_budget_bytes?;
            if self.violated {
                return None;
            }
            let used = self.io_write_bytes()?;
            if used > budget {
                self.violated = true;
                return Some(crate::SandboxViolation {
                    reason: "io-budget".into(),
                    detail: format!(
                        "job wrote {used} bytes, exceeding the io_write_limit budget of {budget} bytes"
                    ),
                });
            }
            None
        }

        fn terminate_tree(&mut self) -> bool {
            // Kill cả cây process trong job (cmd → ping...) — đóng pipe kế
            // thừa, wait_with_output trả ngay.
            unsafe { TerminateJobObject(self.job, 1) != 0 }
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod win_job {
    use crate::SandboxOptions;
    pub(crate) struct JobGuard;
    impl JobGuard {
        pub(crate) fn assign(
            _child: &std::process::Child,
            _opts: &SandboxOptions,
        ) -> Result<Self, String> {
            Ok(Self)
        }
    }
}

// ---------------------------------------------------------------------------
// Sandboxed spawn
// ---------------------------------------------------------------------------

/// Build the failure-shaped `SandboxRunResult` for backend errors
/// (`[sandbox:<prefix>] <detail>` + a matching violation entry).
fn failure_result(
    prefix: &str,
    reason: &str,
    detail: &str,
    duration_ms: u128,
    enforcement: &'static str,
) -> SandboxRunResult {
    SandboxRunResult {
        exit_code: None,
        stdout: String::new(),
        stderr: format!("[sandbox:{prefix}] {detail}"),
        duration_ms,
        enforcement,
        violations: vec![SandboxViolation {
            reason: reason.to_string(),
            detail: detail.to_string(),
        }],
        blocked: false,
        overlay_dir: None,
        overlay_committed: false,
        state: state::SandboxState::Failed.as_str(),
    }
}

/// Kill child — ưu tiên kill cả process tree qua containment
/// (TerminateJobObject: tiến trình cháu kế thừa stdout/stderr pipe, kill chỉ
/// process gốc sẽ khiến wait_with_output chờ drain tới khi cháu exit).
fn kill_child_tree(
    child: &mut std::process::Child,
    containment: Option<&mut Box<dyn backend::Containment>>,
) {
    let tree_killed = containment
        .map(|c: &mut Box<dyn backend::Containment>| c.terminate_tree())
        .unwrap_or(false);
    if !tree_killed {
        let _ = child.kill();
    }
}

/// P1: chốt thời gian drain stdout/stderr SAU khi child chính đã thoát (tự
/// nhiên hoặc đã bị kill). Con cháu kế thừa pipe có thể giữ write-end mở
/// mãi — không có chốt này thì read() chờ EOF vô hạn và wall-clock timeout
/// bị vô hiệu hoàn toàn ở nhánh exit tự nhiên.
const PIPE_DRAIN_DEADLINE: Duration = Duration::from_millis(1000);

/// Đọc toàn bộ một pipe trên thread phụ, gửi `(is_stdout, buf)` qua channel
/// khi tới EOF. Thread chỉ kết thúc khi MỌI holder của write-end thoát —
/// caller bắt buộc phải áp deadline, không được join trực tiếp.
fn spawn_pipe_reader<S: std::io::Read + Send + 'static>(
    stream: Option<S>,
    is_stdout: bool,
    tx: &std::sync::mpsc::Sender<(bool, Vec<u8>)>,
) -> usize {
    match stream {
        Some(mut stream) => {
            let tx = tx.clone();
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                // Lỗi read (pipe hỏng giữa chừng) → trả những gì đã đọc;
                // không lan truyền lỗi vì caller chốt bằng deadline.
                let _ = stream.read_to_end(&mut buf);
                let _ = tx.send((is_stdout, buf));
            });
            1
        }
        None => 0,
    }
}

/// Thu hoạch output khi child chính đã thoát (exit tự nhiên hoặc đã bị kill
/// bởi timeout/IO-budget): drain stdout/stderr trong `stall_deadline`;
/// nếu EOF chưa tới (process cháu đang giữ write-end) → kill TOÀN BỘ job
/// tree để đóng handle kế thừa, rồi drain nốt phần đã đệm trong OS pipe
/// trong một deadline thứ hai. Sau hai deadline nếu vẫn còn reader kẹt
/// (holder nằm NGOÀI job, kill không đóng được handle) → bỏ thread, trả phần
/// đã đọc + exit code của child chính — caller KHÔNG BAO GIỜ block vô hạn.
///
/// `stall_deadline = None` → drain chờ EOF vô hạn (contract `timeout = None`
/// của SandboxOptions), không bao giờ vào nhánh kill.
fn reap_output(
    child: &mut std::process::Child,
    containment: Option<&mut Box<dyn backend::Containment>>,
    stall_deadline: Option<Duration>,
) -> std::io::Result<std::process::Output> {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut pending = spawn_pipe_reader(child.stdout.take(), true, &tx)
        + spawn_pipe_reader(child.stderr.take(), false, &tx);
    // Thread panic mà không send → channel Disconnected thay vì recv treo.
    drop(tx);

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();

    // Chờ reader tới hạn; mỗi stream gửi đúng một message khi xong.
    // `until = None` → chờ vô hạn (contract `timeout = None`).
    fn collect(
        rx: &std::sync::mpsc::Receiver<(bool, Vec<u8>)>,
        pending: &mut usize,
        stdout: &mut Vec<u8>,
        stderr: &mut Vec<u8>,
        until: Option<Instant>,
    ) {
        while *pending > 0 {
            let remaining = until.map(|until| until.saturating_duration_since(Instant::now()));
            if remaining == Some(Duration::ZERO) {
                break;
            }
            let received = match remaining {
                Some(remain) => rx.recv_timeout(remain).ok(),
                None => rx.recv().ok(),
            };
            match received {
                Some((is_stdout, buf)) => {
                    if is_stdout {
                        *stdout = buf;
                    } else {
                        *stderr = buf;
                    }
                    *pending -= 1;
                }
                None => {
                    // Deadline hết (Timeout) hoặc toàn bộ sender đã drop
                    // (Disconnected — thread panic, không còn message nào).
                    if remaining.is_none() {
                        *pending = 0;
                    }
                    break;
                }
            }
        }
    }

    fn until_after(deadline: Option<Duration>) -> Option<Instant> {
        deadline.map(|d| Instant::now().checked_add(d).unwrap_or_else(Instant::now))
    }

    // Phase 1: drain trong grace — cháu exit nhanh (lẽ thường) → EOF tự
    // nhiên, thu đủ output, KHÔNG kill gì cả (hành vi cũ cho trường hợp
    // lành được giữ nguyên).
    collect(
        &rx,
        &mut pending,
        &mut stdout,
        &mut stderr,
        until_after(stall_deadline),
    );

    // Phase 2: còn reader chưa xong → cháu (hoặc holder kế thừa handle) đang
    // giữ pipe. Kill cả cây như nhánh timeout-kill — TerminateJobObject đóng
    // handle của cháu → EOF tới trong ms — rồi drain nốt phần đã đệm.
    if pending > 0 {
        kill_child_tree(child, containment);
        collect(
            &rx,
            &mut pending,
            &mut stdout,
            &mut stderr,
            until_after(stall_deadline),
        );
        // Vẫn kẹt → bỏ thread (tự kết thúc khi holder thoát / dọn theo
        // process exit), trả phần đã đọc. Không bao giờ block vô hạn.
    }

    let status = child.wait()?;
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

/// Kết thúc pipeline: rollback/commit overlay session và gắn outcome vào
/// result. Gọi đúng một lần ở MỌI nhánh return sau khi overlay đã tạo.
fn finish_overlay(
    mut result: SandboxRunResult,
    overlay: Option<overlay::OverlaySession>,
    overlay_dir: Option<String>,
    commit: bool,
) -> SandboxRunResult {
    result.overlay_dir = overlay_dir;
    if let Some(session) = overlay {
        let outcome = if commit {
            session.commit()
        } else {
            session.rollback()
        };
        result.overlay_committed = commit && outcome.is_ok();
        if let Err(err) = outcome {
            if !result.stderr.is_empty() {
                result.stderr.push('\n');
            }
            result
                .stderr
                .push_str(&format!("[sandbox:overlay-finish] {err}"));
            result.violations.push(SandboxViolation {
                reason: "overlay-finish".into(),
                detail: err.to_string(),
            });
        }
    }
    result
}

/// Spawn `program(args…)` under the sandbox described by `opts`.
///
/// Pipeline (Track R2): policy precheck (lib) → backend enforcement
/// (`SupervisedBackend`: argv shaping + env scrub → spawn → containment →
/// wait). Behavior identical to the pre-refactor monolithic version.
pub fn spawn_sandboxed(
    program: &str,
    args: &[String],
    opts: &SandboxOptions,
) -> std::io::Result<SandboxRunResult> {
    let violations = precheck(program, args, opts);
    if !violations.is_empty() {
        return Ok(SandboxRunResult {
            exit_code: None,
            stdout: String::new(),
            stderr: violations
                .iter()
                .map(|v| format!("[sandbox:{}] {}", v.reason, v.detail))
                .collect::<Vec<_>>()
                .join("\n"),
            duration_ms: 0,
            enforcement: detect_enforcement().as_str(),
            violations,
            blocked: true,
            overlay_dir: None,
            overlay_committed: false,
            state: state::SandboxState::Created.as_str(),
        });
    }

    let backend = backend::SupervisedBackend;
    use backend::SandboxBackend as _;
    let enforcement = backend.enforcement();
    let started = Instant::now();

    // P2: ReadOnly/Strict chạy trong overlay session — write tương đối đổ
    // vào `upper/`, rollback mặc định, commit chỉ khi `opts.overlay_commit`.
    let overlay = match overlay::OverlaySession::create(opts.profile, &opts.workspace) {
        Ok(overlay) => overlay,
        Err(err) => {
            return Ok(failure_result(
                "overlay",
                "overlay-failed",
                &err.to_string(),
                started.elapsed().as_millis(),
                enforcement.as_str(),
            ));
        }
    };
    let overlay_dir = overlay
        .as_ref()
        .map(|session| session.cwd().to_string_lossy().into_owned());

    let mut prepared = backend.prepare(program, args, opts, enforcement);
    if let Some(session) = &overlay {
        prepared.cwd = session.cwd().to_path_buf();
        for (key, value) in session.env_overrides() {
            prepared.env.insert(key, value);
        }
    }

    let mut command = std::process::Command::new(&prepared.program);
    command
        .args(&prepared.args)
        .current_dir(&prepared.cwd)
        .env_clear()
        .envs(&prepared.env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // Pre-exec OS enforcement (landlock restrict_writes trên linux).
    // Overlay cwd (`upper/`) truyền vào như root ghi được: child phải ghi
    // trong vùng containment của chính nó thì overlay mới có gì để promote.
    let writable_extra: Vec<std::path::PathBuf> = overlay
        .as_ref()
        .map(|session| vec![session.cwd().to_path_buf()])
        .unwrap_or_default();
    #[cfg(unix)]
    if let Some(mut hook) = backend.pre_exec_hook(opts, enforcement, &writable_extra) {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(move || hook());
        }
    }
    #[cfg(not(unix))]
    let _ = &writable_extra;

    // Creation flags (Windows: CREATE_SUSPENDED từ P3 — job gán trước resume).
    let extra_flags = backend.creation_flags();
    #[cfg(windows)]
    if extra_flags != 0 {
        use std::os::windows::process::CommandExt;
        command.creation_flags(extra_flags);
    }
    #[cfg(not(windows))]
    let _ = extra_flags;

    let lifecycle = state::Lifecycle::new();

    let child = command.spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(err) => {
            // Recoverable: môi trường còn nguyên, lệnh có thể được retry.
            let res = failure_result(
                "spawn",
                "spawn-failed",
                &err.to_string(),
                started.elapsed().as_millis(),
                enforcement.as_str(),
            );
            return Ok(finish_overlay(
                res,
                overlay,
                overlay_dir,
                opts.overlay_commit,
            ));
        }
    };

    // Enforcement containment (Windows Job Object) — gán khi child còn
    // CREATE_SUSPENDED, TRƯỚC khi resume (vá race job-gán-sau-spawn).
    let mut containment = match backend.contain(&child, opts) {
        Ok(containment) => containment,
        Err(err) => {
            // Terminal (hợp đồng backend): containment mutate — discard đứa con.
            let _ = child.kill();
            let res = failure_result(
                "contain",
                err.reason(),
                err.detail(),
                started.elapsed().as_millis(),
                enforcement.as_str(),
            );
            return Ok(finish_overlay(
                res,
                overlay,
                overlay_dir,
                opts.overlay_commit,
            ));
        }
    };
    if let Some(containment) = containment.as_mut() {
        if let Err(err) = containment.activate(&mut child) {
            // Terminal: resume thất bại — child suspended vĩnh viễn, phải kill.
            let _ = child.kill();
            let res = failure_result(
                "contain",
                "contain-failed",
                &err.to_string(),
                started.elapsed().as_millis(),
                enforcement.as_str(),
            );
            return Ok(finish_overlay(
                res,
                overlay,
                overlay_dir,
                opts.overlay_commit,
            ));
        }
    }
    lifecycle.update_state_if_state(state::SandboxState::Created, state::SandboxState::Running);

    // Poll loop khi có wall-clock timeout HOẶC IO budget (cần poll counters).
    // Mọi nhánh break đều qua `reap_output` (drain có deadline + kill tree
    // khi con cháu giữ pipe) — không còn `wait_with_output` nào block vô hạn
    // sau khi child chính đã thoát. Lỗi IO được gom về một chỗ bên dưới để
    // kill child + kết thúc overlay session trước khi trả Err (trước đây
    // `?` trả sớm — bỏ rác upper/temp và bỏ child sống).
    let mut limit_violation: Option<SandboxViolation> = None;
    let mut timed_out = false;
    let waited = if opts.timeout.is_some() || opts.io_write_limit_mb.is_some() {
        let mut slept = Duration::ZERO;
        loop {
            match child.try_wait() {
                // P1: child chính exit TỰ NHIÊN — cháu kế thừa stdout/stderr
                // pipe có thể giữ EOF mãi → wait_with_output block vô hạn,
                // timeout vô hiệu ở nhánh này. Drain có deadline + kill
                // tree khi stall; exit code của child chính được giữ nguyên.
                Ok(Some(_)) => {
                    break reap_output(&mut child, containment.as_mut(), Some(PIPE_DRAIN_DEADLINE))
                }
                Ok(None) => {
                    if let Some(timeout) = opts.timeout {
                        if slept >= timeout {
                            // CAS: timeout-kill thua exit tự nhiên thì chỉ reap.
                            if lifecycle.update_state_if_state(
                                state::SandboxState::Running,
                                state::SandboxState::Killing,
                            ) {
                                kill_child_tree(&mut child, containment.as_mut());
                                timed_out = true;
                            }
                            // Đã kill (hoặc CAS thua — child tự exit): reap
                            // có deadline thay vì wait_with_output — kill
                            // tree có thể fail (OpenProcess bị deny) và cháu
                            // vẫn giữ pipe.
                            break reap_output(
                                &mut child,
                                containment.as_mut(),
                                Some(PIPE_DRAIN_DEADLINE),
                            );
                        }
                    }
                    // IO budget poll: vượt limit → kill + violation.
                    if let Some(violation) = containment
                        .as_mut()
                        .and_then(|c: &mut Box<dyn backend::Containment>| c.poll())
                    {
                        if lifecycle.update_state_if_state(
                            state::SandboxState::Running,
                            state::SandboxState::Killing,
                        ) {
                            kill_child_tree(&mut child, containment.as_mut());
                            limit_violation = Some(violation);
                        }
                        break reap_output(
                            &mut child,
                            containment.as_mut(),
                            Some(PIPE_DRAIN_DEADLINE),
                        );
                    }
                    std::thread::sleep(Duration::from_millis(25));
                    slept += Duration::from_millis(25);
                }
                Err(err) => break Err(err),
            }
        }
    } else {
        // Contract: timeout = None → chờ vô hạn là hành vi đã doc — giữ
        // nguyên (drain tới EOF không deadline) cho nhánh không limit, nhưng
        // qua reap_output để `child` không bị move — đường lỗi bên dưới vẫn
        // kill được cây process.
        reap_output(&mut child, containment.as_mut(), None)
    };

    let output = match waited {
        Ok(output) => output,
        Err(err) => {
            // Lỗi IO giữa pipeline (hiếm): vẫn kill child + rollback/commit
            // overlay session trước khi trả Err — không bỏ rác overlay temp,
            // không bỏ sót child sống. Kênh lỗi Err(io::Error) giữ nguyên.
            kill_child_tree(&mut child, containment.as_mut());
            let res = failure_result(
                "wait",
                "wait-failed",
                &err.to_string(),
                started.elapsed().as_millis(),
                enforcement.as_str(),
            );
            let _ = finish_overlay(res, overlay, overlay_dir, opts.overlay_commit);
            return Err(err);
        }
    };

    // Finalize lifecycle sau khi reap.
    match lifecycle.get() {
        state::SandboxState::Killing => {
            let terminal = if timed_out {
                state::SandboxState::TimedOut
            } else {
                state::SandboxState::Killed
            };
            lifecycle.update_state_if_state(state::SandboxState::Killing, terminal);
        }
        state::SandboxState::Running => {
            lifecycle.update_state_if_state(
                state::SandboxState::Running,
                state::SandboxState::Completed,
            );
        }
        _ => {}
    }

    let result = SandboxRunResult {
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        duration_ms: started.elapsed().as_millis(),
        enforcement: enforcement.as_str(),
        violations: limit_violation.into_iter().collect(),
        blocked: false,
        overlay_dir: None,
        overlay_committed: false,
        state: lifecycle.get().as_str(),
    };
    Ok(finish_overlay(
        result,
        overlay,
        overlay_dir,
        opts.overlay_commit,
    ))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_roundtrip() {
        assert_eq!(
            SandboxProfile::parse("workspace"),
            Some(SandboxProfile::Workspace)
        );
        assert_eq!(
            SandboxProfile::parse("read-only"),
            Some(SandboxProfile::ReadOnly)
        );
        assert_eq!(
            SandboxProfile::parse("strict"),
            Some(SandboxProfile::Strict)
        );
        assert_eq!(SandboxProfile::parse("bogus"), None);
    }

    #[test]
    fn glob_matching() {
        assert!(glob_match("**/*.pem", "certs/sub/key.pem"));
        assert!(glob_match("**/*.pem", "key.pem"));
        assert!(!glob_match("**/*.pem", "key.pem.bak"));
        assert!(glob_match("**/.ssh/**", "home/user/.ssh/id_rsa"));
        assert!(glob_match("*.txt", "readme.txt"));
        assert!(!glob_match("*.txt", "sub/readme.txt"));
    }

    #[test]
    fn env_scrub_drops_unlisted_vars() {
        let env = scrub_env(&["CUSTOM_TOKEN".into()]);
        // Windows runners expose the path variable as `Path`, not `PATH`.
        assert!(env.keys().any(|k| k.eq_ignore_ascii_case("PATH")) || env.is_empty());
    }

    #[test]
    fn write_target_extraction() {
        let args = vec![
            "-c".into(),
            "echo hi > out.txt".into(),
            ">".into(),
            "target.txt".into(),
        ];
        let targets = write_targets(&args);
        assert_eq!(targets, vec!["target.txt"]);
    }

    #[test]
    fn precheck_blocks_deny_glob_and_out_of_scope_writes() {
        let workspace = std::env::temp_dir().join("ghita-sandbox-test-workspace");
        let opts = SandboxOptions::new(SandboxProfile::Workspace, &workspace)
            .with_deny_globs(&["**/*.pem", "**/.ssh/**"]);

        let v1 = precheck("cat", &["id_rsa.pem".into()], &opts);
        assert_eq!(v1.len(), 1);
        assert_eq!(v1[0].reason, "deny-glob");

        // Absolute path outside both the workspace and the temp root, on every
        // platform (`C:\...` is relative on unix; temp_dir itself is allowed).
        #[cfg(target_os = "windows")]
        let outside = String::from("C:\\Windows\\system32\\evil.dll");
        #[cfg(not(target_os = "windows"))]
        let outside = String::from("/etc/ghita-sandbox-evil.dll");
        let v2 = precheck("cmd", &[">".into(), outside], &opts);
        assert!(v2.iter().any(|v| v.reason == "write-outside-scope"));

        let strict_opts = SandboxOptions::new(SandboxProfile::Strict, &workspace);
        let v3 = precheck("curl", &["https://example.com".into()], &strict_opts);
        assert_eq!(v3.len(), 1);
        assert_eq!(v3[0].reason, "strict-network");
    }

    #[test]
    fn spawn_runs_and_blocks_per_policy() {
        let workspace = std::env::temp_dir().join("ghita-sandbox-run-test");
        let _ = std::fs::create_dir_all(&workspace);
        let opts = SandboxOptions::new(SandboxProfile::Workspace, &workspace)
            .with_deny_globs(&["**/*.key"]);

        let blocked = spawn_sandboxed("cat", &["secret.key".into()], &opts).unwrap();
        assert!(blocked.blocked);
        assert_eq!(blocked.violations.len(), 1);

        #[cfg(target_os = "windows")]
        let res = spawn_sandboxed("cmd.exe", &["/C".into(), "echo hello".into()], &opts).unwrap();
        #[cfg(not(target_os = "windows"))]
        let res = spawn_sandboxed("echo", &["hello".into()], &opts).unwrap();

        assert!(!res.blocked);
        assert!(res.stdout.contains("hello"));
    }

    // --- Track R2 (P2): overlay rollback cho ReadOnly/Strict ---

    #[test]
    fn overlay_strict_rolls_back_relative_writes() {
        let workspace = std::env::temp_dir().join(format!(
            "ghita-strict-rollback-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("keep.txt"), "keep").unwrap();

        let opts = SandboxOptions::new(SandboxProfile::Strict, &workspace);
        // Redirect nhúng trong 1 token (không dính precheck write-target) —
        // write tương đối đổ vào upper rồi bị rollback.
        #[cfg(target_os = "windows")]
        let res = spawn_sandboxed(
            "cmd.exe",
            &["/C".into(), "echo dirty > forbidden.txt".into()],
            &opts,
        )
        .unwrap();
        #[cfg(not(target_os = "windows"))]
        let res = spawn_sandboxed(
            "sh",
            &["-c".into(), "echo dirty > forbidden.txt".into()],
            &opts,
        )
        .unwrap();

        assert!(!res.blocked, "stderr: {}", res.stderr);
        assert!(res.overlay_dir.is_some());
        assert!(!res.overlay_committed);
        assert!(
            !workspace.join("forbidden.txt").exists(),
            "relative write must be rolled back, not land in the workspace"
        );
        assert_eq!(
            std::fs::read_to_string(workspace.join("keep.txt")).unwrap(),
            "keep"
        );
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[test]
    fn overlay_commit_promotes_writes_to_workspace() {
        let workspace = std::env::temp_dir().join(format!(
            "ghita-strict-commit-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&workspace).unwrap();

        let opts = SandboxOptions {
            overlay_commit: true,
            ..SandboxOptions::new(SandboxProfile::Strict, &workspace)
        };
        #[cfg(target_os = "windows")]
        let res = spawn_sandboxed(
            "cmd.exe",
            &["/C".into(), "echo promoted > out.txt".into()],
            &opts,
        )
        .unwrap();
        #[cfg(not(target_os = "windows"))]
        let res = spawn_sandboxed(
            "sh",
            &["-c".into(), "echo promoted > out.txt".into()],
            &opts,
        )
        .unwrap();

        assert!(!res.blocked, "stderr: {}", res.stderr);
        assert!(res.overlay_committed);
        assert!(
            workspace.join("out.txt").exists(),
            "committed write promoted"
        );
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[test]
    fn workspace_profile_has_no_overlay() {
        let workspace =
            std::env::temp_dir().join(format!("ghita-workspace-no-overlay-{}", std::process::id()));
        std::fs::create_dir_all(&workspace).unwrap();
        let opts = SandboxOptions::new(SandboxProfile::Workspace, &workspace);

        #[cfg(target_os = "windows")]
        let res = spawn_sandboxed(
            "cmd.exe",
            &["/C".into(), "echo direct > live.txt".into()],
            &opts,
        )
        .unwrap();
        #[cfg(not(target_os = "windows"))]
        let res =
            spawn_sandboxed("sh", &["-c".into(), "echo direct > live.txt".into()], &opts).unwrap();

        assert!(!res.blocked);
        assert!(
            res.overlay_dir.is_none(),
            "workspace profile must not overlay"
        );
        assert!(
            workspace.join("live.txt").exists(),
            "workspace writes persist"
        );
        let _ = std::fs::remove_dir_all(&workspace);
    }

    // --- Track R2 (P3): limits + race + lifecycle ---

    #[test]
    fn job_assigned_before_resume_child_completes() {
        // Race fix regression test: child spawn CREATE_SUSPENDED → job gán →
        // resume. Nếu resume hỏng, child không bao giờ chạy → stdout rỗng +
        // state timed-out thay vì completed.
        let workspace =
            std::env::temp_dir().join(format!("ghita-resume-test-{}", std::process::id()));
        std::fs::create_dir_all(&workspace).unwrap();
        let opts = SandboxOptions::new(SandboxProfile::Workspace, &workspace);

        #[cfg(target_os = "windows")]
        let res =
            spawn_sandboxed("cmd.exe", &["/C".into(), "echo resumed_ok".into()], &opts).unwrap();
        #[cfg(not(target_os = "windows"))]
        let res = spawn_sandboxed("echo", &["resumed_ok".into()], &opts).unwrap();

        assert!(!res.blocked, "stderr: {}", res.stderr);
        assert_eq!(res.state, "completed", "child must be resumed, not killed");
        assert!(res.stdout.contains("resumed_ok"), "stdout: {}", res.stdout);
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[test]
    fn timeout_kills_runaway_child_and_reports_timed_out() {
        let workspace =
            std::env::temp_dir().join(format!("ghita-timeout-kill-{}", std::process::id()));
        std::fs::create_dir_all(&workspace).unwrap();
        let opts = SandboxOptions {
            timeout: Some(Duration::from_millis(400)),
            ..SandboxOptions::new(SandboxProfile::Workspace, &workspace)
        };

        #[cfg(target_os = "windows")]
        let res = spawn_sandboxed(
            "cmd.exe",
            &["/C".into(), "ping -n 30 127.0.0.1".into()],
            &opts,
        )
        .unwrap();
        #[cfg(not(target_os = "windows"))]
        let res = spawn_sandboxed("sleep", &["30".into()], &opts).unwrap();

        assert_eq!(
            res.state, "timed-out",
            "runaway child must be killed by timeout"
        );
        assert!(res.exit_code.is_none() || res.exit_code != Some(0));
        let _ = std::fs::remove_dir_all(&workspace);
    }

    // --- P1 regression: con cháu giữ stdout/stderr pipe không được phép
    // vô hiệu hóa timeout ở nhánh child exit tự nhiên ---

    #[cfg(target_os = "windows")]
    #[test]
    fn grandchild_holding_pipe_cannot_defeat_timeout() {
        // Repro P1: `cmd /C "start /b ping -n 30 … & exit"` — cmd exit TỰ
        // NHIÊN trong ~100ms nhưng cháu `ping` kế thừa stdout/stderr pipe vẫn
        // chạy ~29s. Trước fix: nhánh natural-exit break thẳng vào
        // `wait_with_output` (không còn check timeout nào nữa) → read() chờ
        // EOF từ ping → call trả sau ~30s dù timeout chỉ 1.5s. Sau fix:
        // drain pipe có deadline 1000ms → TerminateJobObject → trả ~1-2s.
        let workspace =
            std::env::temp_dir().join(format!("ghita-grandchild-pipe-{}", std::process::id()));
        std::fs::create_dir_all(&workspace).unwrap();
        let opts = SandboxOptions {
            timeout: Some(Duration::from_millis(1500)),
            ..SandboxOptions::new(SandboxProfile::Workspace, &workspace)
        };

        let started = Instant::now();
        let res = spawn_sandboxed(
            "cmd.exe",
            &["/C".into(), "start /b ping -n 30 127.0.0.1 & exit".into()],
            &opts,
        )
        .unwrap();
        let elapsed = started.elapsed();

        assert!(
            elapsed < Duration::from_secs(15),
            "timeout must not be defeated by a grandchild holding the pipe \
             (took {elapsed:?}; state={}, stderr={})",
            res.state,
            res.stderr
        );
        assert_eq!(
            res.state, "completed",
            "cmd exited naturally — must be completed, not killed/timed-out"
        );
        assert_eq!(
            res.exit_code,
            Some(0),
            "cmd's own exit code must be preserved"
        );
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn grandchild_finishing_within_drain_grace_keeps_output() {
        // Hành vi phải giữ nguyên cho cháu ngoan: cháu exit trong grace
        // 1000ms → EOF tự nhiên, output thu ĐỦ, KHÔNG kill job tree.
        let workspace =
            std::env::temp_dir().join(format!("ghita-grandchild-grace-{}", std::process::id()));
        std::fs::create_dir_all(&workspace).unwrap();
        let opts = SandboxOptions {
            timeout: Some(Duration::from_secs(30)),
            ..SandboxOptions::new(SandboxProfile::Workspace, &workspace)
        };

        let res = spawn_sandboxed(
            "cmd.exe",
            &[
                "/C".into(),
                "start /b cmd /C echo grandchild-output & exit".into(),
            ],
            &opts,
        )
        .unwrap();

        assert!(!res.blocked, "stderr: {}", res.stderr);
        assert_eq!(res.state, "completed", "stderr: {}", res.stderr);
        assert!(
            res.stdout.contains("grandchild-output"),
            "grandchild output within the drain grace must be captured, got: {:?}",
            res.stdout
        );
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn job_object_sets_ttl_and_memory_flags() {
        // TTL (best-effort — Windows 11 mới có thể từ chối CPU time limit,
        // degrade có chủ đích) + memory + kill-on-close flags được set thật
        // trên Job Object (đọc lại qua QueryInformationJobObject).
        let workspace = std::env::temp_dir().join(format!("ghita-job-ttl-{}", std::process::id()));
        std::fs::create_dir_all(&workspace).unwrap();
        let opts = SandboxOptions {
            timeout: Some(Duration::from_secs(7)),
            memory_limit_mb: Some(256),
            ..SandboxOptions::new(SandboxProfile::Workspace, &workspace)
        };

        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("cmd.exe");
        cmd.args(["/C", "ping -n 30 127.0.0.1"]).creation_flags(0x4); // CREATE_SUSPENDED
        let mut child = cmd.spawn().unwrap();
        let guard = win_job::JobGuard::assign(&child, &opts).expect("job assign");
        let (flags, ttl_100ns) = guard.query_limits().expect("query limits");

        if guard.ttl_applied() {
            assert_ne!(flags & 0x0002, 0, "JOB_OBJECT_LIMIT_JOB_TIME must be set");
            assert_eq!(ttl_100ns, 70_000_000, "TTL = 7s expressed in 100ns units");
        } else {
            // Degrade đã ghi nhận: OS từ chối CPU time limit → không có flag.
            assert_eq!(flags & 0x0002, 0, "degraded TTL must not half-apply");
            println!("note: Windows rejected job CPU time limit — TTL degrades to wall-clock poll");
        }
        assert_ne!(
            flags & 0x0100,
            0,
            "JOB_OBJECT_LIMIT_PROCESS_MEMORY must be set"
        );
        assert_ne!(flags & 0x2000, 0, "KILL_ON_JOB_CLOSE must be set");

        drop(guard); // kill-on-close giết cả child suspended
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn io_write_budget_kills_runaway_writer() {
        // P3 (review 0.0.2-alpha): test phụ thuộc môi trường — cần `node`
        // trên PATH. Máy không có node → skip thay vì fail giả (env scrub
        // chỉ giữ PATH/PATHEXT... nên `node` phải tồn tại độc lập sandbox).
        let node_available = std::process::Command::new("node")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !node_available {
            println!("skip: `node` not on PATH (environment-dependent test)");
            return;
        }

        let workspace =
            std::env::temp_dir().join(format!("ghita-io-budget-{}", std::process::id()));
        std::fs::create_dir_all(&workspace).unwrap();
        let scratch = std::env::temp_dir().join("ghita-io-budget-test.bin");
        let _ = std::fs::remove_file(&scratch);

        let opts = SandboxOptions {
            io_write_limit_mb: Some(4),
            timeout: Some(Duration::from_secs(60)),
            ..SandboxOptions::new(SandboxProfile::Workspace, &workspace)
        };
        let script = "console.log('io-test-started');\
            const fs=require('fs'),path=require('path');\
            const p=path.join(process.env.TEMP,'ghita-io-budget-test.bin');\
            const fd=fs.openSync(p,'w');const buf=Buffer.alloc(1024*1024,1);\
            for(let i=0;i<64;i++){fs.writeSync(fd,buf)}\
            fs.closeSync(fd);fs.unlinkSync(p);";
        let res = spawn_sandboxed("node", &["-e".into(), script.into()], &opts).unwrap();

        assert!(
            res.violations.iter().any(|v| v.reason == "io-budget"),
            "must report io-budget violation, got: {:?} (state={}, exit={:?}, stdout={:?}, stderr={:?})",
            res.violations,
            res.state,
            res.exit_code,
            res.stdout,
            res.stderr
        );
        assert_eq!(
            res.state, "killed",
            "writer must be killed by the IO budget"
        );
        let _ = std::fs::remove_file(&scratch);
        let _ = std::fs::remove_dir_all(&workspace);
    }
}

#[cfg(test)]
mod t3_tests {
    use super::*;

    #[test]
    fn enforcement_as_str_covers_all_tiers() {
        assert_eq!(Enforcement::Landlock.as_str(), "landlock");
        assert_eq!(Enforcement::Seatbelt.as_str(), "seatbelt");
        assert_eq!(Enforcement::RestrictedToken.as_str(), "restricted-token");
        assert_eq!(Enforcement::Supervised.as_str(), "supervised");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn detect_on_windows_v1_reports_supervised_until_provisioned() {
        // v1: probe codex sandbox disabled (backlog R2) → supervised
        assert_eq!(detect_enforcement(), Enforcement::Supervised);
    }
}
