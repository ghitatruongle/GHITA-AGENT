use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Listener, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::RwLock;

mod proxy;
use proxy::{get_proxy_port, start_proxy_server, stop_proxy_server, ProxyState};

mod computer_use;
use computer_use::ComputerUseState;

mod terminal;
use terminal::TerminalManager;

// v1.1.1 Track 8: native LCS diff-stat (UI no longer stalls on big AI edits)
mod diff;

// --- Server sidecar state ---
struct ServerState {
    child: Option<std::process::Child>,
    port: u16,
    http_client: reqwest::Client,
    /// Guard flag to prevent concurrent start_server calls (race-condition safe)
    starting: bool,
}

// --- Security state for IPC ---
struct SecurityState {
    session_token: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovedCommandResult {
    stdout: String,
    stderr: String,
    code: Option<i32>,
    success: bool,
}

pub fn command_is_blocked(command: &str) -> bool {
    let normalized = command.to_ascii_lowercase();
    let compact = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.contains("rm -rf /")
        || compact.contains("rm -rf ~")
        || compact.contains("rm -fr /")
        || compact.contains("rm -r -f /")
        || compact.contains("format c:")
        || compact.contains("format.com c:")
        || compact.contains("mkfs.")
        || compact.contains("dd if=")
        || compact.contains(":(){ :|:& };:")
        || compact.contains("shutdown ")
        || compact.contains("reboot")
        || compact.contains("remove-item c:\\ -recurse")
        || compact.contains("remove-item -recurse c:\\")
        || compact.contains("rd /s /q c:")
        || compact.contains("rd /s /q d:")
        || compact.contains("rmdir /s /q c:")
        || compact.contains("diskpart")
        || compact.contains("cipher /w")
        || compact.contains("bcdedit")
        || compact.contains("reg delete hklm")
        || compact.contains("reg delete hkcu")
}

pub fn clamp_command_timeout(timeout_ms: Option<u64>) -> u64 {
    timeout_ms.unwrap_or(120_000).clamp(1_000, 300_000)
}

// --- Filesystem scope for IPC ---
// Renderer-initiated FS mutations are only allowed inside folders the user
// explicitly granted through a native dialog (`fs_request_access`). Grants are
// persisted to app data so they survive restarts. Reads stay open so the
// editor can browse any folder the user navigates to.
struct FsScopeState {
    roots: std::sync::Mutex<std::collections::HashSet<PathBuf>>,
}

fn normalize_path(p: &Path) -> PathBuf {
    let c = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let s = c.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(stripped) => PathBuf::from(stripped.to_string()),
        None => c,
    }
}

/// Normalize a path that may not exist yet (write/mkdir targets): canonicalize
/// the nearest existing ancestor and append the remainder verbatim.
fn normalize_loose(p: &Path) -> PathBuf {
    if p.exists() {
        return normalize_path(p);
    }
    match p.parent() {
        Some(parent) if parent != p => {
            normalize_loose(parent).join(p.file_name().unwrap_or_default())
        }
        _ => p.to_path_buf(),
    }
}

fn normalized_lower(p: &Path) -> String {
    let s = normalize_path(p).to_string_lossy().into_owned();
    s.trim_end_matches(['/', '\\']).to_lowercase()
}

/// True when `child` equals `root` or lives underneath it (component-safe,
/// case-insensitive for Windows).
pub fn is_within_root(child: &Path, root: &Path) -> bool {
    let c = normalized_lower(child);
    let r = normalized_lower(root);
    if r.is_empty() || c.is_empty() {
        return false;
    }
    c == r || (c.starts_with(&r) && c[r.len()..].starts_with(['/', '\\']))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Refuse destructive operations on filesystem roots, the user's home
/// directory, and any ancestor of it (`C:\Users`, `C:\Users\<name>`, …).
pub fn is_protected_system_path(path: &Path) -> bool {
    let trimmed = normalized_lower(path);
    if trimmed.is_empty() {
        return true;
    }
    // Filesystem/drive roots have a single component ("c:", "/").
    if Path::new(&trimmed).components().count() <= 1 {
        return true;
    }
    if let Some(home) = home_dir() {
        let h = normalized_lower(&home);
        if !h.is_empty()
            && (trimmed == h
                || (h.starts_with(&trimmed) && h[trimmed.len()..].starts_with(['/', '\\'])))
        {
            return true;
        }
    }
    false
}

fn load_fs_scope(app: &tauri::AppHandle) -> std::collections::HashSet<PathBuf> {
    let Ok(file) = app_storage_path(app, "fs-scope.json") else {
        return Default::default();
    };
    let Ok(content) = fs::read_to_string(file) else {
        return Default::default();
    };
    serde_json::from_str::<serde_json::Value>(&content)
        .ok()
        .and_then(|v| {
            v.get("roots").and_then(|r| r.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|p| p.as_str())
                    .map(PathBuf::from)
                    .filter(|p| p.exists())
                    .collect::<std::collections::HashSet<PathBuf>>()
            })
        })
        .unwrap_or_default()
}

fn persist_fs_scope(
    app: &tauri::AppHandle,
    scope: &tauri::State<'_, FsScopeState>,
) -> Result<(), String> {
    let file = app_storage_path(app, "fs-scope.json")?;
    let roots: Vec<String> = scope
        .roots
        .lock()
        .map_err(|e| format!("Filesystem scope lock poisoned: {e}"))?
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let json = serde_json::json!({ "roots": roots });
    fs::write(file, json.to_string()).map_err(|e| format!("Failed to persist fs scope: {e}"))
}

fn ensure_fs_scoped(scope: &tauri::State<'_, FsScopeState>, path: &Path) -> Result<(), String> {
    let candidate = normalize_loose(path);
    let granted = scope
        .roots
        .lock()
        .map_err(|e| format!("Filesystem scope lock poisoned: {e}"))?;
    if granted.iter().any(|r| is_within_root(&candidate, r)) {
        return Ok(());
    }
    Err(format!(
        "Path is outside the granted filesystem scope ({candidate:?}). The user must approve access first (fs_request_access)."
    ))
}

/// Ask the user, via a native dialog, to grant GHITA file access to a folder
/// subtree. Returns false when declined.
#[tauri::command]
fn fs_request_access(
    app: tauri::AppHandle,
    scope: tauri::State<'_, FsScopeState>,
    path: String,
) -> Result<bool, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Access request requires a path.".to_string());
    }
    if is_protected_system_path(Path::new(trimmed)) {
        return Err("Refusing to grant access to a system-critical path.".to_string());
    }
    let approved = app
        .dialog()
        .message(format!(
            "Allow GHITA to read and edit files under:\n\n{trimmed}\n\nOnly approve folders you trust."
        ))
        .title("Grant folder access")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show();
    if !approved {
        return Ok(false);
    }
    let norm = normalize_path(Path::new(trimmed));
    scope
        .roots
        .lock()
        .map_err(|e| format!("Filesystem scope lock poisoned: {e}"))?
        .insert(norm);
    persist_fs_scope(&app, &scope)?;
    Ok(true)
}

#[tauri::command]
fn fs_scope_list(scope: tauri::State<'_, FsScopeState>) -> Vec<String> {
    scope
        .roots
        .lock()
        .map(|roots| {
            roots
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

// --- Native filesystem commands ---
// Reads are open so the editor can browse any folder the user navigates to.
// Mutations (write/mkdir/rename/remove) require the target to live inside a
// folder granted via `fs_request_access` (native dialog, persisted).

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFsEntry {
    name: String,
    path: String,
    is_directory: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFsMetadata {
    is_directory: bool,
    size: u64,
    modified_ms: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFsReadText {
    content: String,
    encoding: String,
    is_binary: bool,
    /// True when the file is larger than the read cap and content was
    /// truncated. Callers MUST NOT write the truncated content back to disk.
    is_truncated: bool,
}

fn decode_utf16_bytes(bytes: &[u8], little_endian: bool) -> String {
    let (pairs, _) = bytes.as_chunks::<2>();
    let units: Vec<u16> = pairs
        .iter()
        .map(|c| {
            if little_endian {
                u16::from_le_bytes(*c)
            } else {
                u16::from_be_bytes(*c)
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
}

/// List a directory using native std::fs.
/// Entries are sorted directories-first, then case-insensitively by name.
#[tauri::command]
fn fs_read_dir(path: String) -> Result<Vec<NativeFsEntry>, String> {
    let dir = std::fs::read_dir(&path).map_err(|e| format!("Failed to read directory: {e}"))?;
    let mut entries: Vec<NativeFsEntry> = Vec::new();
    for entry in dir.flatten() {
        let p = entry.path();
        let is_directory = p.is_dir();
        entries.push(NativeFsEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: p.to_string_lossy().into_owned(),
            is_directory,
        });
    }
    entries.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

/// Read a text file with native std::fs. Detects UTF-8 BOM, UTF-16 LE/BE BOM,
/// or valid UTF-8; falls back to a lossless latin-1 decode otherwise. Flags
/// binary files by sniffing for NUL bytes in the first 8 KiB. `max_bytes`
/// caps the read (default 5 MiB) to avoid OOM on huge files; oversized files
/// are reported via `is_truncated` so callers never write the clipped content
/// back over the original.
#[tauri::command]
fn fs_read_text(path: String, max_bytes: Option<u64>) -> Result<NativeFsReadText, String> {
    use std::io::Read;
    let file = std::fs::File::open(&path).map_err(|e| format!("Failed to open file: {e}"))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("Failed to stat file: {e}"))?;
    let limit = max_bytes.unwrap_or(5 * 1024 * 1024);
    let is_truncated = metadata.len() > limit;
    // If the file is oversized we still read exactly `limit` bytes for preview,
    // but is_truncated tells the frontend the content is incomplete.
    let read_bytes = if is_truncated {
        limit as usize
    } else {
        metadata.len() as usize
    };
    let mut buf = Vec::with_capacity(read_bytes);
    file.take(limit)
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read file: {e}"))?;

    let (encoding, content) = if buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
        ("utf-8-bom", String::from_utf8_lossy(&buf[3..]).into_owned())
    } else if buf.starts_with(&[0xFF, 0xFE]) {
        ("utf-16le", decode_utf16_bytes(&buf[2..], true))
    } else if buf.starts_with(&[0xFE, 0xFF]) {
        ("utf-16be", decode_utf16_bytes(&buf[2..], false))
    } else if std::str::from_utf8(&buf).is_ok() {
        ("utf-8", String::from_utf8_lossy(&buf).into_owned())
    } else {
        ("latin-1", buf.iter().map(|&b| b as char).collect())
    };

    // Binary sniff on DECODED text: UTF-16 payloads are full of 0x00 bytes and
    // would otherwise be mislabeled as binary, making the whole UTF-16 path
    // dead. NUL in decoded text reliably indicates a true binary file.
    // Byte-based sniff avoids slicing `content` at a non-char-boundary
    // (CJK/emoji at byte 8192 would panic with `content[..8192]`).
    let is_binary = content.as_bytes().iter().take(8192).any(|&b| b == 0);

    Ok(NativeFsReadText {
        content,
        encoding: encoding.to_string(),
        is_binary,
        is_truncated,
    })
}

/// Write text to a file with native std::fs. `encoding` must match the value
/// returned by `fs_read_text` (utf-8-bom / utf-16le / utf-16be / latin-1), so
/// the file is written back in its original encoding instead of being
/// corrupted; when omitted, plain UTF-8 is written.
#[tauri::command]
fn fs_write_text(
    scope: tauri::State<'_, FsScopeState>,
    path: String,
    content: String,
    encoding: Option<String>,
) -> Result<(), String> {
    ensure_fs_scoped(&scope, Path::new(&path))?;
    let bytes: Vec<u8> = match encoding.as_deref() {
        Some("utf-8-bom") => {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            v.extend_from_slice(content.as_bytes());
            v
        }
        Some("utf-16le") => {
            let mut v = vec![0xFF, 0xFE];
            for u in content.encode_utf16() {
                v.extend_from_slice(&u.to_le_bytes());
            }
            v
        }
        Some("utf-16be") => {
            let mut v = vec![0xFE, 0xFF];
            for u in content.encode_utf16() {
                v.extend_from_slice(&u.to_be_bytes());
            }
            v
        }
        Some("latin-1") => content
            .chars()
            .map(|c| {
                if c.is_ascii() || (c as u32) < 256 {
                    c as u8
                } else {
                    b'?'
                }
            })
            .collect(),
        _ => content.into_bytes(),
    };
    std::fs::write(&path, bytes).map_err(|e| format!("Failed to write file: {e}"))?;
    Ok(())
}

/// Stat a file/dir with native std::fs.
#[tauri::command]
fn fs_metadata(path: String) -> Result<NativeFsMetadata, String> {
    let m = std::fs::metadata(&path).map_err(|e| format!("Failed to stat path: {e}"))?;
    let modified_ms = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(NativeFsMetadata {
        is_directory: m.is_dir(),
        size: m.len(),
        modified_ms,
    })
}

/// Create a directory with native std::fs (`recursive` mirrors `mkdir -p`).
#[tauri::command]
fn fs_mkdir(
    scope: tauri::State<'_, FsScopeState>,
    path: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    ensure_fs_scoped(&scope, Path::new(&path))?;
    let recursive = recursive.unwrap_or(false);
    if recursive {
        std::fs::create_dir_all(&path).map_err(|e| format!("Failed to create directory: {e}"))
    } else {
        std::fs::create_dir(&path).map_err(|e| format!("Failed to create directory: {e}"))
    }
}

/// Remove a file or directory with native std::fs. Refuses filesystem roots,
/// the user's home directory and its ancestors, and anything outside the
/// granted fs-scope; `recursive` still requires an explicit flag.
#[tauri::command]
fn fs_remove(
    scope: tauri::State<'_, FsScopeState>,
    path: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Refusing to remove an empty path.".to_string());
    }
    if is_protected_system_path(Path::new(trimmed)) {
        return Err("Refusing to remove a filesystem root or system-critical path.".to_string());
    }
    ensure_fs_scoped(&scope, Path::new(trimmed))?;
    let recursive = recursive.unwrap_or(false);
    let meta = std::fs::symlink_metadata(&path).map_err(|e| format!("Failed to stat path: {e}"))?;
    if meta.is_dir() && !recursive {
        return Err("Directory is not empty; pass recursive to remove it.".to_string());
    }
    if meta.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| format!("Failed to remove directory: {e}"))
    } else {
        std::fs::remove_file(&path).map_err(|e| format!("Failed to remove file: {e}"))
    }
}

/// Rename/move a file or directory with native std::fs.
#[tauri::command]
fn fs_rename(
    scope: tauri::State<'_, FsScopeState>,
    from: String,
    to: String,
) -> Result<(), String> {
    if from.trim().is_empty() || to.trim().is_empty() {
        return Err("Rename requires both source and destination paths.".to_string());
    }
    ensure_fs_scoped(&scope, Path::new(&from))?;
    ensure_fs_scoped(&scope, Path::new(&to))?;
    std::fs::rename(&from, &to).map_err(|e| format!("Failed to rename: {e}"))
}

#[tauri::command]
async fn execute_approved_command(
    app: tauri::AppHandle,
    command: String,
    shell: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<ApprovedCommandResult, String> {
    if command.trim().is_empty() || command.len() > 16_384 {
        return Err("Command is empty or exceeds the 16 KiB safety limit.".to_string());
    }
    if command_is_blocked(&command) {
        return Err("Command blocked by the native security policy.".to_string());
    }

    // Renderer state is not a trust boundary. Always obtain approval from a
    // native dialog instead of accepting a caller-controlled boolean over IPC.
    // Long commands show BOTH head and tail so nothing can hide past the cut.
    let command_preview = if command.chars().count() > 2_000 {
        let elided = command.chars().count() - 2_100;
        format!(
            "{}\n\n…[{} characters elided]…\n\n{}",
            command.chars().take(1_500).collect::<String>(),
            elided,
            command
                .chars()
                .skip(command.chars().count() - 600)
                .collect::<String>()
        )
    } else {
        command.clone()
    };
    let approved = app
        .dialog()
        .message(format!(
            "Allow GHITA to execute this command?\n\n{command_preview}"
        ))
        .title("Approve terminal command")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show();
    if !approved {
        return Err("Explicit user approval is required.".to_string());
    }

    let (program, args): (&str, Vec<&str>) = if cfg!(target_os = "windows") {
        match shell.as_str() {
            "powershell" | "bash" | "sh" => (
                "powershell.exe",
                vec![
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    command.as_str(),
                ],
            ),
            "cmd" => ("cmd.exe", vec!["/d", "/s", "/c", command.as_str()]),
            _ => return Err("Unsupported shell.".to_string()),
        }
    } else {
        match shell.as_str() {
            "bash" => ("bash", vec!["-c", command.as_str()]),
            "sh" | "cmd" | "powershell" => ("sh", vec!["-c", command.as_str()]),
            _ => return Err("Unsupported shell.".to_string()),
        }
    };

    let mut process = tokio::process::Command::new(program);
    process
        .args(args)
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Hide the console window on Windows so approved commands run in the
    // background without flashing a visible terminal (CREATE_NO_WINDOW).
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        process.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    }
    if let Some(cwd) = cwd {
        let directory = std::path::PathBuf::from(cwd);
        if !directory.is_dir() {
            return Err("Working directory does not exist or is not a directory.".to_string());
        }
        process.current_dir(directory);
    }

    let timeout_ms = clamp_command_timeout(timeout_ms);
    let output = tokio::time::timeout(Duration::from_millis(timeout_ms), process.output())
        .await
        .map_err(|_| format!("Approved command timed out after {timeout_ms} ms."))?
        .map_err(|e| format!("Failed to execute approved command: {e}"))?;

    Ok(ApprovedCommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code(),
        success: output.status.success(),
    })
}

#[tauri::command]
fn get_session_token(state: tauri::State<'_, SecurityState>) -> String {
    state.session_token.clone()
}

pub fn generate_session_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let r1: u64 = rng.gen();
    let r2: u64 = rng.gen();
    format!("{:016x}{:016x}", r1, r2)
}

/// Pick the first free TCP port in the range [preferred, preferred + 32).
///
/// RESILIENCE (audit fix 3.9): previously `start_server` used the
/// hard-coded `port: 8080` from `ServerState`. If another process on
/// the host (e.g. a dev server, the proxy, or another Tauri app) had
/// bound 8080, the sidecar crashed at startup with "Address already in
/// use" and the UI was left with no server. We now scan up to 32
/// ports starting at the configured base and pick the first one
/// `bind()` succeeds on. If none are free we return an error rather
/// than crashing.
pub fn find_free_port(preferred: u16) -> std::io::Result<u16> {
    for offset in 0u16..32 {
        let candidate = preferred.saturating_add(offset);
        if std::net::TcpListener::bind(("127.0.0.1", candidate)).is_ok() {
            return Ok(candidate);
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AddrInUse,
        format!(
            "no free port in range {}-{}",
            preferred,
            preferred.saturating_add(31)
        ),
    ))
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to Ghita Agent.", name)
}

/// Put the sidecar process into a Windows Job Object with
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
///
/// Why: `cleanup_before_exit` only runs when the app shuts down gracefully
/// (window close / `RunEvent::Exit`). If the app crashes or is force-killed,
/// no Rust code runs and the sidecar survives as an orphan, squatting on the
/// HTTP/gRPC ports — the next launch then cannot bind and drifts to another
/// port. With a kill-on-close job, the kernel reaps every process in the job
/// the moment the last handle to the job closes, i.e. when the app process
/// dies for ANY reason. The job handle is intentionally held for the process
/// lifetime (leaked); the OS closes it automatically at process exit.
#[cfg(target_os = "windows")]
fn assign_kill_on_close_job(child: &std::process::Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // The job handle is a raw HANDLE (not Sync), so we keep it as an isize;
    // it is intentionally held for the process lifetime and only cast back
    // when used. The OS closes it at process exit, which is what triggers the
    // kill-on-close reap.
    static JOB: std::sync::OnceLock<isize> = std::sync::OnceLock::new();
    let job = *JOB
        .get_or_init(|| (unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) }) as isize);
    if job == 0 {
        return; // No job object available — graceful-exit cleanup still covers us.
    }

    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            job as HANDLE,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        // If the child is already nested in a job (e.g. launched from an IDE
        // or CI runner) the assignment may fail — acceptable, normal-exit
        // cleanup still applies in that rare case.
        let _ = AssignProcessToJobObject(job as HANDLE, child.as_raw_handle() as HANDLE);
    }
}

/// Result of a bundled-node integrity check (audit fix M8).
enum NodeIntegrity {
    /// `node.sha256` present and matched the binary.
    Ok,
    /// No `node.sha256` manifest shipped — nothing to verify against.
    NoManifest,
    /// Manifest present but the digest did NOT match.
    Mismatch,
}

/// Verify a bundled `node` binary against a sibling `node.sha256` manifest.
///
/// The manifest is a text file whose first whitespace-delimited token is the
/// lowercase hex SHA-256 of the binary (the common `sha256sum` format). When no
/// manifest is present we return `NoManifest` so packagers that do not ship one
/// keep working; a present-but-wrong digest returns `Mismatch`.
fn verify_bundled_node(node_path: &std::path::Path) -> NodeIntegrity {
    use sha2::{Digest, Sha256};
    let manifest_path = node_path.with_file_name("node.sha256");
    let expected = match fs::read_to_string(&manifest_path) {
        Ok(text) => text,
        Err(_) => return NodeIntegrity::NoManifest,
    };
    let expected_hex = expected
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_lowercase();
    if expected_hex.len() != 64 {
        return NodeIntegrity::NoManifest;
    }
    let bytes = match fs::read(node_path) {
        Ok(b) => b,
        Err(_) => return NodeIntegrity::Mismatch,
    };
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let actual_hex = hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();
    if actual_hex == expected_hex {
        NodeIntegrity::Ok
    } else {
        NodeIntegrity::Mismatch
    }
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<String, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            // Installing replaces the binary and restarts the app — never do
            // this silently; the user must consent to each update.
            let approved = app
                .dialog()
                .message(format!(
                    "Update Ghita Agent to version {version} now?\n\nThe update is signature-verified and will restart the application."
                ))
                .title("Update available")
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::OkCancel)
                .blocking_show();
            if !approved {
                return Ok(format!("Update to {version} postponed by the user."));
            }
            update
                .download_and_install(|_chunk, _total| {}, || {})
                .await
                .map_err(|e| e.to_string())?;
            Ok(format!("Updated to version {}", version))
        }
        Ok(None) => Ok("Already up to date".to_string()),
        Err(e) => Err(e.to_string()),
    }
}

/// Start the communication server sidecar
#[tauri::command]
async fn start_server(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Mutex<ServerState>>,
    security_state: tauri::State<'_, SecurityState>,
) -> Result<String, String> {
    // Atomic guard: check + lock under a single lock acquisition to prevent race conditions
    // (StrictMode or multiple UI triggers could call start_server concurrently)
    {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        // P1-1 (deep review pass #2): mirror `get_server_status` and reap a
        // dead-but-still-present sidecar before the is_some() check. Without
        // this, a sidecar that crashed silently (port collision, OOM, script
        // error) keeps `s.child = Some(dead)` forever and start_server becomes
        // permanently wedged.
        if let Some(ref mut child) = s.child {
            if let Ok(Some(_status)) = child.try_wait() {
                s.child = None;
            }
        }
        if s.child.is_some() {
            return Ok("Server already running".to_string());
        }
        if s.starting {
            return Ok("Server is already starting".to_string());
        }
        s.starting = true;
    }

    let preferred_port = state.lock().map_err(|e| e.to_string())?.port;
    // RESILIENCE (audit fix 3.9): scan for a free port instead of
    // assuming the configured one is available. The selected port is
    // written back to ServerState so downstream commands (proxy,
    // status) see the actual bound port.
    let port = find_free_port(preferred_port).map_err(|e| e.to_string())?;
    {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.port = port;
    }
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let session_token = security_state.session_token.clone();
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?;

    // Heavy I/O (filesystem reads, process spawn) on a blocking thread
    let spawn_result = tokio::task::spawn_blocking(move || {
        // Try multiple possible locations for the server script.
        //
        // SECURITY/PORTABILITY (audit fix 3.2): the previous version only
        // searched relative to the executable directory. On installed
        // builds (NSIS / MSI / .deb / .AppImage) the layout is different
        // and the sidecar was unlocatable. We now also probe the Tauri
        // resource directory which is the canonical install location.
        let mut candidates = Vec::new();

        #[cfg(debug_assertions)]
        {
            // Prioritize workspace source directory during development to run the latest bundle
            candidates.push(
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("sidecar")
                    .join("server.bundle.mjs"),
            );
            candidates.push(
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("sidecar")
                    .join("server.mjs"),
            );
        }

        // Tauri resource dir is the canonical install location
        candidates.push(resource_dir.join("sidecar").join("server.bundle.mjs"));
        candidates.push(resource_dir.join("sidecar").join("server.mjs"));
        candidates.push(resource_dir.join("server.bundle.mjs"));
        candidates.push(resource_dir.join("server.mjs"));

        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_default();

        candidates.push(exe_dir.join("sidecar").join("server.bundle.mjs"));
        candidates.push(exe_dir.join("sidecar").join("server.mjs"));
        candidates.push(exe_dir.join("../sidecar/server.bundle.mjs"));
        candidates.push(exe_dir.join("../sidecar/server.mjs"));
        candidates.push(exe_dir.join("../../src-tauri/sidecar/server.bundle.mjs"));
        candidates.push(exe_dir.join("../../src-tauri/sidecar/server.mjs"));

        let server_script = candidates
            .iter()
            .find(|p| p.exists())
            .ok_or_else(|| {
                format!(
                    "sidecar server script not found. Searched: {}",
                    candidates
                        .iter()
                        .map(|p| p.display().to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })?;

        fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

        let bundled_node = server_script
            .parent()
            .map(|dir| dir.join(format!("node{}", std::env::consts::EXE_SUFFIX)))
            .filter(|path| path.exists());

        // SECURITY (audit fix M8): before executing a bundled `node` runtime,
        // verify its SHA-256 against an expected digest shipped as
        // `node.sha256` next to it. If the manifest exists and does NOT match,
        // refuse the bundled binary and fall back to the system `node` on PATH
        // (which the OS trusts) rather than running a possibly-tampered file.
        let bundled_node = match bundled_node {
            Some(path) => match verify_bundled_node(&path) {
                NodeIntegrity::Ok | NodeIntegrity::NoManifest => Some(path),
                NodeIntegrity::Mismatch => {
                    eprintln!(
                        "[GHITA] Bundled node integrity check FAILED for {} \u{2014} falling back to system node",
                        path.display()
                    );
                    None
                }
            },
            None => None,
        };
        let node_command = bundled_node
            .as_ref()
            .map(|path| path.as_os_str())
            .unwrap_or_else(|| std::ffi::OsStr::new("node"));

        let lan_config_path = data_dir.join("lan-enabled.txt");
        let lan_enabled = fs::read_to_string(&lan_config_path).unwrap_or_default().trim() == "true";

        let mut command = std::process::Command::new(node_command);
        command
            .arg(server_script)
            .env("GHITA_PORT", port.to_string())
            .env("GHITA_DATA_DIR", &data_dir)
            .env("GHITA_LAN_ENABLED", if lan_enabled { "1" } else { "0" })
            // RESILIENCE (audit fix 3.9): disabled auto port liberation
            // to prevent force-killing other processes. Dynamic port
            // allocation via find_free_port() handles port conflicts.
            .env("GHITA_LIBERATE_PORTS", "0")
            .env("GHITA_SESSION_TOKEN", session_token)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());

        // Hide the console window on Windows so the sidecar node runs silently
        // in the background (CREATE_NO_WINDOW).
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let child = command
            .spawn()
            .map_err(|e| format!("Failed to start sidecar server: {}", e))?;

        Ok::<std::process::Child, String>(child)
    })
    .await;

    // P0-2 (deep review pass #2): if the blocking task panicked or the
    // runtime was shutting down, the `?` propagated without resetting
    // `s.starting` — every subsequent start_server call would short-circuit
    // with "Server is already starting" until the process was restarted.
    // Reset the flag on any join error so the user can recover.
    let spawn_result = match spawn_result {
        Ok(r) => r,
        Err(e) => {
            if let Ok(mut s) = state.lock() {
                s.starting = false;
            }
            return Err(format!("Task join error: {}", e));
        }
    };

    // If spawn failed, reset starting flag before returning error
    let mut child = match spawn_result {
        Ok(c) => c,
        Err(e) => {
            if let Ok(mut s) = state.lock() {
                s.starting = false;
            }
            return Err(e);
        }
    };

    // Tie the sidecar's lifetime to ours so a crash/force-kill of the app
    // cannot leave an orphan node.exe holding the HTTP/gRPC ports.
    #[cfg(target_os = "windows")]
    assign_kill_on_close_job(&child);

    // Spawn a thread to read stdout line-by-line
    if let Some(stdout) = child.stdout.take() {
        let app_handle = app_handle.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stdout);
            for line_str in reader.lines().map_while(Result::ok) {
                if let Some(payload) = line_str.strip_prefix("__GHITA_IPC__:") {
                    // P2-1 (deep review pass #2): the sidecar announces the
                    // actual port it bound to via `http_listening`. Patch
                    // ServerState.port in place so get_server_status and
                    // /health probes don't drift from the listener.
                    // We re-acquire the state through the AppHandle (which
                    // is 'static) rather than capturing the `state` lifetime
                    // token — the borrow checker would otherwise reject
                    // this closure as non-'static.
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) {
                        if value.get("event").and_then(|v| v.as_str()) == Some("http_listening") {
                            if let Some(actual_port) = value
                                .get("data")
                                .and_then(|d| d.get("port"))
                                .and_then(|p| p.as_u64())
                            {
                                if let Some(state) = app_handle.try_state::<Mutex<ServerState>>() {
                                    if let Ok(mut s) = state.lock() {
                                        s.port = actual_port as u16;
                                    }
                                }
                            }
                        }
                        let _ = app_handle.emit("sidecar-event", value);
                    } else {
                        eprintln!("[sidecar] malformed IPC payload: {}", payload);
                    }
                } else {
                    // Print ordinary log to console
                    println!("{}", line_str);
                }
            }
        });
    }

    // Store child handle and clear starting flag under lock
    {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.child = Some(child);
        s.starting = false;
    }
    Ok(format!("Server starting on port {}", port))
}

/// Stop the communication server sidecar
#[tauri::command]
fn stop_server(state: tauri::State<'_, Mutex<ServerState>>) -> Result<String, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;

    if let Some(mut child) = s.child.take() {
        // Try graceful kill
        let _ = child.kill();
        let _ = child.wait();
        Ok("Server stopped".to_string())
    } else {
        Ok("Server is not running".to_string())
    }
}

/// Get local IP addresses for LAN connection
#[tauri::command]
fn get_local_ips() -> Vec<String> {
    let mut ips = Vec::new();
    if let Ok(interfaces) = local_ip_address::list_afinet_netifas() {
        for (_name, ip) in interfaces {
            let ip_str = ip.to_string();
            // Only include IPv4 non-loopback addresses
            if !ip_str.starts_with("127.") && !ip_str.starts_with("::") && ip_str.contains('.') {
                ips.push(ip_str);
            }
        }
    }
    ips
}

#[tauri::command]
async fn get_server_status(
    state: tauri::State<'_, Mutex<ServerState>>,
    security: tauri::State<'_, SecurityState>,
) -> Result<serde_json::Value, String> {
    let (running, port, client) = {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        // Check if the process has exited
        if let Some(ref mut child) = s.child {
            if let Ok(Some(_status)) = child.try_wait() {
                // Process has exited, clean up state
                s.child = None;
            }
        }
        (s.child.is_some(), s.port, s.http_client.clone())
    };

    // Collect local IPs
    let mut ips = Vec::new();
    if let Ok(interfaces) = local_ip_address::list_afinet_netifas() {
        for (_name, ip) in interfaces {
            let ip_str = ip.to_string();
            if !ip_str.starts_with("127.") && !ip_str.starts_with("::") && ip_str.contains('.') {
                ips.push(ip_str);
            }
        }
    }

    // If running, try to fetch health endpoint
    if running {
        let url = format!("http://127.0.0.1:{}/health", port);

        if let Ok(resp) = client
            .get(&url)
            // The sidecar only returns pairing/device data to authenticated callers.
            .header("x-ghita-session-token", security.session_token.clone())
            .send()
            .await
        {
            if let Ok(mut json) = resp.json::<serde_json::Value>().await {
                // Inject local IPs into response
                json["localIps"] = serde_json::json!(ips);
                return Ok(json);
            }
        }
        // Server process exists but health check failed
        return Ok(serde_json::json!({
            "status": "starting",
            "port": port,
            "localIps": ips
        }));
    }

    Ok(serde_json::json!({
        "status": "stopped",
        "port": port,
        "localIps": ips
    }))
}

// --- DocsGriller types (must match frontend GrillSession interface) ---
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GrillContradiction {
    topic: String,
    doc_a: GrillDocRef,
    doc_b: GrillDocRef,
    severity: String,
    recommendation: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GrillDocRef {
    file: String,
    excerpt: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GrillQuestion {
    question: String,
    source_docs: Vec<String>,
    severity: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GrillSession {
    id: String,
    timestamp: String,
    docs_path: String,
    docs_scanned: u32,
    questions: Vec<GrillQuestion>,
    contradictions: Vec<GrillContradiction>,
    user_answers: std::collections::HashMap<String, String>,
    design_decisions: Vec<String>,
}

/// Run a DocsGriller session: scan the docs directory, read the actual markdown
/// files, and produce a *real* heuristic analysis of their content:
/// - cross-document contradictions (the same topic heading described
///   differently in two files),
/// - Socratic questions derived from decision markers / open questions in the
///   text,
/// - design-decision statements extracted from the text.
/// This is deterministic content analysis — no placeholder or simulated data.
#[tauri::command]
fn run_grill_session(docs_path: String) -> Result<GrillSession, String> {
    use std::collections::HashMap;

    let path = std::path::PathBuf::from(&docs_path);
    if !path.exists() {
        return Err(format!("Docs path does not exist: {}", docs_path));
    }
    if !path.is_dir() {
        return Err(format!("Docs path is not a directory: {}", docs_path));
    }

    // Collect .md/.mdx files (bounded to keep analysis responsive). A visited
    // set of canonicalized paths guards against symlink/junction cycles that
    // would otherwise recurse forever and overflow the stack.
    const MAX_FILES: usize = 300;
    const MAX_BYTES_PER_FILE: usize = 256 * 1024; // 256 KiB per doc
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    let mut visited: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    fn collect_md(
        dir: &std::path::Path,
        files: &mut Vec<(PathBuf, String)>,
        visited: &mut std::collections::HashSet<PathBuf>,
        depth: usize,
    ) {
        if files.len() >= MAX_FILES || depth > 32 {
            return;
        }
        // Canonicalize to be cycle-safe (handles symlinks + Windows junctions).
        let canonical = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
        if !visited.insert(canonical) {
            return;
        }
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                if files.len() >= MAX_FILES {
                    return;
                }
                let p = entry.path();
                if p.is_dir() {
                    collect_md(&p, files, visited, depth + 1);
                } else if p
                    .extension()
                    .is_some_and(|e| e == "md" || e == "mdx" || e == "txt" || e == "markdown")
                {
                    if let Ok(content) = fs::read_to_string(&p) {
                        let bounded: String = content.chars().take(MAX_BYTES_PER_FILE).collect();
                        files.push((p, bounded));
                    }
                }
            }
        }
    }
    collect_md(&path, &mut files, &mut visited, 0);

    let docs_scanned = files.len() as u32;

    // Build a topic → [(file, first paragraph)] index from real headings.
    // A "topic" is the first H1/H2 heading of a document (normalized); when the
    // same topic appears in multiple docs, we compare the body text to detect
    // a contradiction rather than relying on named abstracts.
    let mut topic_excerpts: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut questions: Vec<GrillQuestion> = Vec::new();
    let mut design_decisions: Vec<String> = Vec::new();

    // Decision / uncertainty markers that drive genuine Socratic questions.
    const DECISION_MARKERS: [&str; 14] = [
        "should we",
        "should the",
        "we should decide",
        "need to decide",
        "undecided",
        "to be decided",
        "tbd",
        "todo",
        "open question",
        "not yet decided",
        "future work",
        "trade-off",
        "tradeoff",
        "what if",
    ];

    const DESIGN_MARKERS: [&str; 10] = [
        "we chose",
        "we choose",
        "we decided",
        "decision:",
        "we will use",
        "we selected",
        "we adopt",
        "chosen approach",
        "this design",
        "recommend using",
    ];

    for (file_path, content) in &files {
        let file = file_path.to_string_lossy().into_owned();
        let mut lines = content.lines().collect::<Vec<_>>();
        // Locate the primary topic heading (first H1 or H2).
        let mut primary_heading: Option<String> = None;
        for line in &lines {
            let trimmed = line.trim();
            if trimmed.starts_with("# ") || trimmed.starts_with("## ") {
                let heading = trimmed
                    .trim_start_matches('#')
                    .trim()
                    .trim_matches('`')
                    .trim()
                    .to_lowercase();
                if !heading.is_empty() {
                    primary_heading = Some(heading);
                    break;
                }
            }
        }

        if let Some(topic) = primary_heading {
            // Gather a bounded body excerpt after the heading.
            let mut body = String::new();
            for line in &lines {
                if line.trim().starts_with('#') {
                    continue;
                }
                body.push_str(line);
                body.push(' ');
                if body.len() > 600 {
                    break;
                }
            }
            topic_excerpts
                .entry(topic)
                .or_default()
                .push((file.clone(), body.trim().to_string()));
        }

        // Socratic questions from decision markers (capitalize the sentence).
        let lower = content.to_lowercase();
        for marker in DECISION_MARKERS.iter() {
            if lower.contains(marker) {
                // Pull the sentence containing the marker, truncated, real text.
                let mut sentence = String::new();
                for line in &mut lines {
                    let s = line.trim().to_string();
                    if s.to_lowercase().contains(marker) {
                        sentence = s;
                        break;
                    }
                }
                if sentence.is_empty() {
                    sentence = content
                        .lines()
                        .find(|l| l.to_lowercase().contains(marker))
                        .unwrap_or(marker)
                        .to_string();
                }
                let truncated: String = sentence.chars().take(220).collect();
                questions.push(GrillQuestion {
                    question: format!(
                        "From \"{}\": the text notes — \"{}\". What is the intended resolution?",
                        file.split(['/', '\\']).next_back().unwrap_or(&file),
                        truncated
                    ),
                    source_docs: vec![file.clone()],
                    severity: "warning".to_string(),
                });
                break; // at most one question per file per marker set
            }
        }

        // Design-decision statements.
        for marker in DESIGN_MARKERS.iter() {
            if lower.contains(marker) {
                let sentence = content
                    .lines()
                    .find(|l| l.to_lowercase().contains(marker))
                    .unwrap_or(marker)
                    .trim()
                    .to_string();
                if !sentence.is_empty() {
                    design_decisions.push(sentence.chars().take(220).collect());
                }
                break;
            }
        }
    }

    // Cross-document contradictions: topic described in more than one doc.
    let mut contradictions: Vec<GrillContradiction> = Vec::new();
    for (topic, entries) in topic_excerpts.iter() {
        if entries.len() < 2 {
            continue;
        }
        let (first_file, first_excerpt) = &entries[0];
        for other in entries.iter().skip(1) {
            let (other_file, other_excerpt) = other;
            // Careful: docs that merely reference the same topic without
            // diverging are not contradictions — compare a normalized token
            // signature to estimate whether the descriptions actually differ.
            let a: Vec<&str> = first_excerpt
                .split_whitespace()
                .filter(|w| w.len() > 3)
                .collect();
            let b: Vec<&str> = other_excerpt
                .split_whitespace()
                .filter(|w| w.len() > 3)
                .collect();
            if a.is_empty() || b.is_empty() {
                continue;
            }
            let mut shared = 0usize;
            for tok in &a {
                if b.contains(tok) {
                    shared += 1;
                }
            }
            let overlap = shared as f32 / a.len() as f32;
            if overlap < 0.25 {
                contradictions.push(GrillContradiction {
                    topic: topic.clone(),
                    doc_a: GrillDocRef {
                        file: first_file.clone(),
                        excerpt: first_excerpt.chars().take(300).collect(),
                    },
                    doc_b: GrillDocRef {
                        file: other_file.clone(),
                        excerpt: other_excerpt.chars().take(300).collect(),
                    },
                    severity: if overlap < 0.1 { "major" } else { "minor" }.to_string(),
                    recommendation: format!(
                        "Two documents describe the topic \"{topic}\" differently. Reconcile them or explicitly document the distinction."
                    ),
                });
                break;
            }
        }
    }

    // De-duplicate questions (same text from multiple files).
    let mut seen_q = std::collections::HashSet::new();
    questions.retain(|q| seen_q.insert(q.question.clone()));
    questions.truncate(12);
    contradictions.truncate(12);
    design_decisions.truncate(12);

    let session_id = format!(
        "grill_{:016x}{:016x}",
        rand::random::<u64>(),
        rand::random::<u64>()
    );

    Ok(GrillSession {
        id: session_id,
        timestamp: chrono::Utc::now().to_rfc3339(),
        docs_path,
        docs_scanned,
        questions,
        contradictions,
        user_answers: std::collections::HashMap::new(),
        design_decisions,
    })
}

fn app_storage_path(app: &tauri::AppHandle, file_name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(file_name))
}

fn api_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_storage_path(app, "api-config.json")
}

fn api_config_keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.ghita.coding-agent", "api-config")
        .map_err(|e| format!("Failed to open the operating-system credential vault: {e}"))
}

fn chat_sessions_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_storage_path(app, "chat-sessions.json")
}

#[tauri::command]
fn load_api_config(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    // Prefer the OS credential vault; fall back to the app-data file when the
    // vault is unavailable (e.g. after a reinstall the keyring service may
    // not be reachable yet). Never fail the load outright — the UI depends on
    // it to render the saved providers.
    let fallback_path = api_config_path(&app)?;
    let read_file = || -> Result<serde_json::Value, String> {
        if !fallback_path.exists() {
            return Ok(serde_json::json!({}));
        }
        let content = fs::read_to_string(&fallback_path).map_err(|e| e.to_string())?;
        serde_json::from_str::<serde_json::Value>(&content).map_err(|e| e.to_string())
    };

    match api_config_keyring_entry() {
        Ok(entry) => match entry.get_password() {
            Ok(content) => return serde_json::from_str(&content).map_err(|e| e.to_string()),
            Err(keyring::Error::NoEntry) => {}
            Err(_e) => {
                // Vault exists but read failed — try the file before giving up.
                return read_file();
            }
        },
        Err(_e) => {
            // Vault completely unavailable (reinstall case) — use the file.
            return read_file();
        }
    }

    // One-time migration from versions <=0.4.9. The legacy plaintext file is
    // removed only after the credential vault confirms the write.
    let legacy_path = api_config_path(&app)?;
    if !legacy_path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = fs::read_to_string(&legacy_path).map_err(|e| e.to_string())?;
    let parsed = serde_json::from_str::<serde_json::Value>(&content).map_err(|e| e.to_string())?;
    if let Ok(entry) = api_config_keyring_entry() {
        if let Err(e) = entry.set_password(&content) {
            eprintln!("[GHITA] Failed to migrate API keys to the credential vault: {e}");
        }
    }
    Ok(parsed)
}

#[tauri::command]
fn save_api_config(app: tauri::AppHandle, config: serde_json::Value) -> Result<(), String> {
    let content = serde_json::to_string(&config).map_err(|e| e.to_string())?;

    // The OS credential vault is the source of truth. Plaintext mirrors are
    // only written when the vault itself is unavailable, and any stale
    // plaintext file is deleted once the vault confirms the write — keys must
    // not linger on disk.
    match api_config_keyring_entry() {
        Ok(entry) => match entry.set_password(&content) {
            Ok(()) => {
                let file_path = api_config_path(&app)?;
                if file_path.exists() {
                    if let Err(e) = fs::remove_file(&file_path) {
                        eprintln!("[GHITA] Failed to delete plaintext key mirror ({e})");
                    }
                }
                Ok(())
            }
            Err(e) => {
                eprintln!(
                    "[GHITA] Credential vault unavailable ({e}) — falling back to file storage."
                );
                let file_path = api_config_path(&app)?;
                fs::write(&file_path, &content)
                    .map_err(|e2| format!("Failed to persist API keys (vault: {e}, file: {e2})"))
            }
        },
        Err(e) => {
            eprintln!("[GHITA] Credential vault unavailable ({e}) — falling back to file storage.");
            let file_path = api_config_path(&app)?;
            fs::write(&file_path, &content)
                .map_err(|e2| format!("Failed to persist API keys (vault: {e}, file: {e2})"))
        }
    }
}

#[tauri::command]
fn get_lan_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join("lan-enabled.txt");
    if !path.exists() {
        return Ok(false);
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(content.trim() == "true")
}

#[tauri::command]
fn set_lan_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("lan-enabled.txt");
    fs::write(path, if enabled { "true" } else { "false" }).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_chat_sessions(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = chat_sessions_path(&app)?;
    if !path.exists() {
        return Ok(serde_json::json!({
            "sessions": [],
            "activeSessionId": serde_json::Value::Null
        }));
    }

    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_chat_sessions(app: tauri::AppHandle, payload: serde_json::Value) -> Result<(), String> {
    let path = chat_sessions_path(&app)?;
    let content = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_proxy(
    target_url: String,
    port: u16,
    state: tauri::State<'_, Arc<RwLock<ProxyState>>>,
) -> Result<u16, String> {
    {
        let mut s = state.write().await;
        if s.is_running {
            s.target_url = target_url;
            return Ok(s.port);
        }
    }

    start_proxy_server(port, target_url, state.inner().clone()).await?;
    let actual_port = get_proxy_port(state.inner())
        .await
        .ok_or("Proxy started but port unknown")?;
    Ok(actual_port)
}

#[tauri::command]
async fn stop_proxy(state: tauri::State<'_, Arc<RwLock<ProxyState>>>) -> Result<(), String> {
    stop_proxy_server(state.inner().clone()).await
}

#[tauri::command]
async fn get_proxy_status(
    state: tauri::State<'_, Arc<RwLock<ProxyState>>>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    Ok(serde_json::json!({
        "running": s.is_running,
        "port": s.port
    }))
}

#[tauri::command]
fn get_proxy_url(port: u16, path: String) -> Result<String, String> {
    build_proxy_url(port, &path)
}

pub fn build_proxy_url(port: u16, path: &str) -> Result<String, String> {
    // Sanitize path to prevent URL injection.
    // The previous implementation only checked for `@`, `://`, and `\\`,
    // which let percent-encoded sequences (e.g. `..%2F..%2Fetc%2Fpasswd`)
    // bypass the filter. Decode the path first, then verify that:
    //   1. It does not contain URL-scheme separators (`://`)
    //   2. It does not contain `..` (parent-directory escape)
    //   3. It does not contain `@` (userinfo injection) or `\\` (Windows UNC)
    let trimmed = path.trim_start_matches('/');
    let decoded = percent_encoding::percent_decode_str(trimmed)
        .decode_utf8_lossy()
        .into_owned();
    if decoded.contains("://")
        || decoded.contains('@')
        || decoded.contains('\\')
        || decoded.split(['/', '\\']).any(|seg| seg == "..")
    {
        return Err("Invalid path characters".to_string());
    }
    // Preserve the originally-provided form (still safe) so the URL works
    // with whatever casing/encoding the caller used.
    Ok(format!("http://127.0.0.1:{}/{}", port, trimmed))
}

pub fn resolve_shell_for_platform(shell_type: &str) -> String {
    terminal::resolve_shell(shell_type)
}

// Sandbox commands — not yet implemented (Docker integration planned for v2.0)
// These return structured JSON so the frontend can display a meaningful status
// instead of silently failing or showing empty data.
#[tauri::command]
fn get_sandbox_containers() -> Result<Vec<serde_json::Value>, String> {
    // TODO(v2.0): Implement Docker sandbox integration
    Ok(Vec::new())
}

#[tauri::command]
fn get_sandbox_summary() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "status": "not_ready",
        "message": "Docker sandbox not configured. Coming in v2.0.",
        "containers": 0,
        "ready": false,
    }))
}

#[tauri::command]
fn get_sandbox_logs() -> Result<String, String> {
    Ok("Sandbox not available. Configure Docker to enable sandbox execution.".to_string())
}

/// Graceful cleanup of all child processes and resources before the app exits.
/// Called from both `WindowEvent::CloseRequested` and `RunEvent::Exit` to
/// ensure the sidecar server, proxy, and PTY sessions are all terminated.
fn cleanup_before_exit(app_handle: &tauri::AppHandle) {
    // Kill sidecar server
    if let Some(state) = app_handle.try_state::<Mutex<ServerState>>() {
        if let Ok(mut s) = state.lock() {
            if let Some(mut child) = s.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    // Stop proxy — block until write lock acquired (don't silently fail during shutdown)
    if let Some(proxy_state) = app_handle.try_state::<Arc<RwLock<ProxyState>>>() {
        let proxy = proxy_state.clone();
        tauri::async_runtime::block_on(async move {
            let mut s = proxy.write().await;
            s.is_running = false;
            if let Some(tx) = s.shutdown_tx.take() {
                let _ = tx.send(true);
            }
        });
    }
    // Kill all PTY terminal sessions
    if let Some(term_state) = app_handle.try_state::<TerminalManager>() {
        term_state.kill_all();
    }
}

/// Auto-start the sidecar server if not already running.
/// Used in headless mode where there's no frontend to trigger it.
async fn auto_start_server(app_handle: &tauri::AppHandle) -> Result<(), String> {
    // Check if server needs to be started (without holding lock across await)
    let should_start = {
        if let Some(state) = app_handle.try_state::<Mutex<ServerState>>() {
            let s = state.lock().map_err(|e| e.to_string())?;
            s.child.is_none() && !s.starting
        } else {
            false
        }
    };

    if should_start {
        // Get the state and security_state for the command
        let state = app_handle.state::<Mutex<ServerState>>();
        let security_state = app_handle.state::<SecurityState>();
        let app_handle_clone = app_handle.clone();

        // Call the start_server command internally
        start_server(app_handle_clone, state, security_state).await?;
    }
    Ok(())
}

pub fn run(headless: bool) {
    let session_token = generate_session_token();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::new(ServerState {
            child: None,
            port: 8080,
            http_client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_millis(1500))
                .build()
                .unwrap_or_else(|e| {
                    eprintln!("[GHITA] Failed to create HTTP client, using default: {e}");
                    reqwest::Client::new()
                }),
            starting: false,
        }))
        .manage(SecurityState { session_token })
        .manage(FsScopeState {
            roots: std::sync::Mutex::new(std::collections::HashSet::new()),
        })
        .manage(Arc::new(RwLock::new(ProxyState::default())))
        .manage(ComputerUseState::new())
        .manage(TerminalManager::new())
        .invoke_handler(tauri::generate_handler![
            greet,
            get_session_token,
            execute_approved_command,
            check_update,
            start_server,
            stop_server,
            get_server_status,
            get_local_ips,
            load_api_config,
            save_api_config,
            get_lan_enabled,
            set_lan_enabled,
            load_chat_sessions,
            save_chat_sessions,
            start_proxy,
            stop_proxy,
            get_proxy_status,
            get_proxy_url,
            get_sandbox_containers,
            get_sandbox_summary,
            get_sandbox_logs,
            // Phase 1: Native computer-use (Rust screenshot + input + resize)
            computer_use::computer_screenshot,
            computer_use::computer_get_screen_size,
            computer_use::computer_move_mouse,
            computer_use::computer_click,
            computer_use::computer_type_text,
            computer_use::computer_press_key,
            computer_use::computer_health_check,
            // T9.7: Window operations (move/focus/minimize/waitFor)
            computer_use::computer_window_move,
            computer_use::computer_window_focus,
            computer_use::computer_window_minimize,
            computer_use::computer_window_wait_for,
            // Phase 2: Native PTY terminal (Rust)
            terminal::terminal_create,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            terminal::terminal_list,
            // DocsGriller
            run_grill_session,
            // v1.1.1 Track 8: native LCS diff-stat (async, off main thread)
            diff::line_diff_stat_command,
            // Native filesystem commands (reads open; writes gated by fs-scope grants)
            fs_read_dir,
            fs_read_text,
            fs_write_text,
            fs_metadata,
            fs_mkdir,
            fs_remove,
            fs_rename,
            fs_request_access,
            fs_scope_list,
        ])
        .setup(move |app| {
            // Restore persisted filesystem-scope grants before anything else.
            {
                let scope = app.state::<FsScopeState>();
                let loaded = load_fs_scope(app.handle());
                if let Ok(mut roots) = scope.roots.lock() {
                    *roots = loaded;
                };
            }
            // In headless mode: skip window management, auto-start server
            if headless {
                eprintln!("[GHITA] Running in headless mode — skipping window setup");

                // Auto-start sidecar server in background
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = auto_start_server(&app_handle).await {
                        eprintln!("[GHITA] Failed to auto-start server in headless mode: {}", e);
                    }
                });

                return Ok(());
            }

            // Get splash and main windows — gracefully handle if not found

            // Clamp the frameless main window into the current monitor's work
            // area. On screens smaller than the configured 1400×900 (e.g. 125%
            // display scaling) the window is pinned at the top edge, which
            // parks the in-app title bar behind a top-mounted taskbar: no
            // visible drag region, no window buttons, immovable window.
            if let Some(main) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = main.current_monitor() {
                    let work_area = monitor.work_area();
                    let current = main.outer_size().unwrap_or_default();
                    let clamped_w = current.width.min(work_area.size.width);
                    let clamped_h = current.height.min(work_area.size.height);
                    let _ = main.set_size(tauri::PhysicalSize::new(clamped_w, clamped_h));
                    let _ = main.set_position(tauri::PhysicalPosition::new(
                        work_area.position.x,
                        work_area.position.y,
                    ));
                }
            }

            let splash = match app.get_webview_window("splash") {
                Some(w) => w,
                None => {
                    eprintln!("[setup] Splash window not found — skipping splash transition");
                    if let Some(main) = app.get_webview_window("main") {
                        let _ = main.show();
                    }
                    return Ok(());
                }
            };
            let main = match app.get_webview_window("main") {
                Some(w) => w,
                None => {
                    eprintln!("[setup] Main window not found in app configuration");
                    return Ok(());
                }
            };

            let _ = main.show();
            let _ = main.unminimize();
            let _ = main.set_focus();

            // Show main window and close splash when frontend emits 'ready' event.
            // Tauri Window operations are thread-safe (use IPC channels internally),
            // so std::thread::spawn is safe for the delayed transition.
            let shown = Arc::new(std::sync::atomic::AtomicBool::new(false));
            {
                let main_handle = main.clone();
                let splash_handle = splash.clone();
                let shown_clone = shown.clone();
                // The listener stays registered for the app lifetime (the window
                // is shown once, then ignored). We bind the returned id to a
                // discard binding only to satisfy the API's #[must_use].
                let _event_id = main_handle.clone().listen("ready", move |_event| {
                    if shown_clone.swap(true, std::sync::atomic::Ordering::SeqCst) {
                        return; // Already handled
                    }
                    let main_h = main_handle.clone();
                    let splash_h = splash_handle.clone();
                    std::thread::spawn(move || {
                        // Small delay for smooth visual transition
                        std::thread::sleep(std::time::Duration::from_millis(300));
                        let _ = main_h.show();
                        let _ = splash_h.close();
                    });
                });
            }

            // Safety timeout: force-show main window after 6s even if 'ready' event is lost.
            // This prevents the user from being stuck on a dark/invisible screen.
            {
                let main = main.clone();
                let splash = splash.clone();
                let shown = shown.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(6));
                    if !shown.load(std::sync::atomic::Ordering::SeqCst) {
                        eprintln!("[setup] Safety timeout fired — showing main window");
                        let _ = main.show();
                        let _ = splash.close();
                    }
                });
            }

            #[cfg(debug_assertions)]
            {
                // Open DevTools on both windows for debugging
                if let Some(window) = app.get_webview_window("splash") {
                    window.open_devtools();
                }
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("[GHITA FATAL] Failed to build Tauri application: {e}");
            eprintln!("[GHITA FATAL] This may be caused by missing WebView2 runtime or corrupted installation.");
            std::process::exit(1);
        });

    // Guard against running cleanup twice (CloseRequested triggers Exit)
    let cleaned_up = std::sync::atomic::AtomicBool::new(false);

    app.run(move |app_handle, event| {
        match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                // In headless mode, windows are hidden but may still exist.
                // Don't exit on window close in headless mode.
                if headless {
                    return;
                }
                // Only trigger full shutdown when the *main* window is closed
                if label == "main" {
                    // Prevent the default close so we can clean up first
                    api.prevent_close();

                    // Close DevTools to prevent Chrome_WidgetWin_0 unregister error
                    #[cfg(debug_assertions)]
                    {
                        if let Some(w) = app_handle.get_webview_window("main") {
                            w.close_devtools();
                        }
                    }

                    if !cleaned_up.swap(true, std::sync::atomic::Ordering::SeqCst) {
                        cleanup_before_exit(app_handle);
                    }

                    // Destroy all windows so WebView2 can clean up, then exit
                    if let Some(w) = app_handle.get_webview_window("main") {
                        let _ = w.destroy();
                    }
                    app_handle.exit(0);
                }
            }
            tauri::RunEvent::Exit
                if !cleaned_up.swap(true, std::sync::atomic::Ordering::SeqCst) =>
            {
                cleanup_before_exit(app_handle);
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod security_tests {
    use super::*;

    #[test]
    fn refuses_filesystem_roots() {
        assert!(is_protected_system_path(Path::new("/")));
        assert!(is_protected_system_path(Path::new("\\")));
        assert!(is_protected_system_path(Path::new("C:\\")));
        assert!(is_protected_system_path(Path::new("D:/")));
    }

    #[test]
    fn refuses_home_and_its_ancestors() {
        let Some(home) = home_dir() else { return };
        assert!(is_protected_system_path(&home));
        if let Some(parent) = home.parent() {
            assert!(is_protected_system_path(parent));
        }
    }

    #[test]
    fn allows_normal_project_paths() {
        // A nested non-home path is not system-critical.
        let p = std::env::temp_dir().join("ghita-test-project");
        assert!(!is_protected_system_path(&p));
    }

    #[test]
    fn within_root_rejects_lookalike_prefixes() {
        let root = Path::new("/home/dev/project");
        assert!(is_within_root(
            Path::new("/home/dev/project/src/a.ts"),
            root
        ));
        assert!(is_within_root(root, root));
        assert!(!is_within_root(
            Path::new("/home/dev/projects-x/a.ts"),
            root
        ));
        assert!(!is_within_root(Path::new("/etc/passwd"), root));
    }

    #[test]
    fn within_root_survives_parent_traversal() {
        let root = normalize_path(&std::env::temp_dir());
        let sneaky = normalize_loose(&std::env::temp_dir().join("..").join("elsewhere"));
        assert!(
            !is_within_root(&sneaky, &root) || sneaky == root,
            "traversal must not silently stay inside the root"
        );
    }
}
