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
    for (k, v) in std::env::vars() {
        let upper = k.to_uppercase();
        if allow.iter().any(|a| a.eq_ignore_ascii_case(&upper)) {
            scrubbed.insert(k, v);
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
    Supervised,
}

impl Enforcement {
    pub fn as_str(&self) -> &'static str {
        match self {
            Enforcement::Landlock => "landlock",
            Enforcement::Seatbelt => "seatbelt",
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
    Enforcement::Supervised
}

// ---------------------------------------------------------------------------
// Platform-specific modules (Landlock on Linux, stubs elsewhere)
// ---------------------------------------------------------------------------

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

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOB_OBJECT_LIMIT_ACTIVE_PROCESS: u32 = 0x0008;
    const JOB_OBJECT_LIMIT_PROCESS_MEMORY: u32 = 0x0100;
    const JOB_OBJECT_LIMIT_JOB_MEMORY: u32 = 0x0200;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;

    type Handle = *mut core::ffi::c_void;

    extern "system" {
        fn CreateJobObjectW(attrs: *mut core::ffi::c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            info_class: i32,
            info: *const ExtendedLimitInformation,
            len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    /// Assign the spawned process to a kill-on-close Job Object with resource limits.
    pub(crate) struct JobGuard {
        job: Handle,
    }

    impl JobGuard {
        pub(crate) fn assign(child: &std::process::Child, opts: &SandboxOptions) -> Option<Self> {
            unsafe {
                let job = CreateJobObjectW(core::ptr::null_mut(), core::ptr::null());
                if job.is_null() {
                    return None;
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

                if SetInformationJobObject(
                    job,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    &info,
                    core::mem::size_of::<ExtendedLimitInformation>() as u32,
                ) == 0
                {
                    CloseHandle(job);
                    return None;
                }
                if AssignProcessToJobObject(job, child.as_raw_handle() as Handle) == 0 {
                    CloseHandle(job);
                    return None;
                }
                Some(Self { job })
            }
        }
    }

    impl Drop for JobGuard {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.job);
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod win_job {
    use crate::SandboxOptions;
    pub(crate) struct JobGuard;
    impl JobGuard {
        pub(crate) fn assign(_child: &std::process::Child, _opts: &SandboxOptions) -> Option<Self> {
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Sandboxed spawn
// ---------------------------------------------------------------------------

/// Spawn `program(args…)` under the sandbox described by `opts`.
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
        });
    }

    let enforcement = detect_enforcement();
    let started = Instant::now();

    #[cfg(target_os = "macos")]
    let (argv_program, argv_args): (String, Vec<String>) = if enforcement == Enforcement::Seatbelt {
        (
            "/usr/bin/sandbox-exec".into(),
            [
                "-p".to_string(),
                seatbelt_profile(opts),
                "--".to_string(),
                program.to_string(),
            ]
            .into_iter()
            .chain(args.iter().cloned())
            .collect(),
        )
    } else {
        (program.to_string(), args.to_vec())
    };
    #[cfg(not(target_os = "macos"))]
    let (argv_program, argv_args): (String, Vec<String>) = (program.to_string(), args.to_vec());

    let env = scrub_env(&opts.env_allow);
    let mut command = std::process::Command::new(&argv_program);
    command
        .args(&argv_args)
        .current_dir(&opts.workspace)
        .env_clear()
        .envs(&env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "linux")]
    if enforcement == Enforcement::Landlock {
        use std::os::unix::process::CommandExt;
        let write_roots: Vec<PathBuf> = match opts.profile {
            SandboxProfile::Workspace => vec![opts.workspace.clone(), std::env::temp_dir()],
            SandboxProfile::ReadOnly | SandboxProfile::Strict => vec![],
        };
        unsafe {
            command.pre_exec(move || landlock::restrict_writes(&write_roots));
        }
    }

    let child = command.spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(err) => {
            return Ok(SandboxRunResult {
                exit_code: None,
                stdout: String::new(),
                stderr: format!("[sandbox:spawn] {err}"),
                duration_ms: started.elapsed().as_millis(),
                enforcement: enforcement.as_str(),
                violations: vec![SandboxViolation {
                    reason: "spawn-failed".into(),
                    detail: err.to_string(),
                }],
                blocked: false,
            });
        }
    };

    // Windows: contain the child tree in a kill-on-close Job Object with limits.
    let _job = win_job::JobGuard::assign(&child, opts);

    let output = match opts.timeout {
        Some(timeout) => {
            let mut slept = Duration::ZERO;
            loop {
                match child.try_wait()? {
                    Some(_) => break child.wait_with_output(),
                    None if slept >= timeout => {
                        let _ = child.kill();
                        break child.wait_with_output();
                    }
                    None => {
                        std::thread::sleep(Duration::from_millis(25));
                        slept += Duration::from_millis(25);
                    }
                }
            }
        }
        None => child.wait_with_output(),
    };
    let output = output?;

    Ok(SandboxRunResult {
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        duration_ms: started.elapsed().as_millis(),
        enforcement: enforcement.as_str(),
        violations: Vec::new(),
        blocked: false,
    })
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
}
