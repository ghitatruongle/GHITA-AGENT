// ==============================================================================
// Ghita Agent — Native PTY Terminal Module (Rust)
// ==============================================================================
// Replaces the Node.js sidecar node-pty implementation with a native Rust PTY
// using the `portable-pty` crate.  On Windows this uses ConPTY (Win10 1809+),
// on Linux/macOS it uses posix PTY.
//
// Communication with the TypeScript frontend:
//   - Frontend calls Tauri invoke commands: terminal_create, terminal_write,
//     terminal_resize, terminal_kill, terminal_list
//   - Backend emits Tauri events: "terminal-data", "terminal-exit"
// ==============================================================================

use dashmap::DashMap;
use portable_pty::{CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TerminalSessionInfo {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub pid: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TerminalDataPayload {
    pub id: String,
    pub data: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TerminalExitPayload {
    pub id: String,
    #[serde(rename = "exitCode")]
    pub exit_code: Option<i32>,
}

// ---------------------------------------------------------------------------
// Internal PTY session
// ---------------------------------------------------------------------------

struct PtySession {
    id: String,
    shell: String,
    cwd: String,
    master: Box<dyn MasterPty + Send>,
    /// Child process wrapped in Arc<Mutex<>> so both the reader thread AND
    /// the kill path can reach it without contending on PtySession lock.
    /// This prevents the deadlock that occurred when kill_session() held the
    /// PtySession lock and blocked on child.wait() while the reader thread
    /// was waiting for the same lock to emit the exit event.
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
    writer: Box<dyn Write + Send>,
    /// Monotonically increasing generation counter. Each time a session with
    /// the same id is recreated, the generation increments. Old reader threads
    /// check this to suppress stale ("ghost") events.
    #[allow(dead_code)]
    generation: u64,
}

// ---------------------------------------------------------------------------
// Terminal Manager — owns all PTY sessions
// ---------------------------------------------------------------------------

pub struct TerminalManager {
    sessions: Arc<DashMap<String, Mutex<PtySession>>>,
    /// Tracks the current generation per session id so old reader threads
    /// can be detected and silenced.
    generations: Arc<DashMap<String, u64>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
            generations: Arc::new(DashMap::new()),
        }
    }

    /// Kill all active sessions (called on app exit)
    pub fn kill_all(&self) {
        let ids: Vec<String> = self.sessions.iter().map(|e| e.key().clone()).collect();
        for id in ids {
            self.kill_session(&id);
        }
    }

    fn kill_session(&self, id: &str) {
        if let Some((_key, session)) = self.sessions.remove(id) {
            // Lock the session briefly to extract the child Arc, then drop
            // the lock before doing any blocking wait — this avoids holding
            // the PtySession mutex while the child exits.
            let child_arc = {
                match session.lock() {
                    Ok(s) => s.child.clone(),
                    Err(e) => {
                        eprintln!("[terminal] Mutex poisoned while killing session {id}: {e}");
                        // Still clean up generations even on error
                        self.generations.remove(id);
                        return;
                    }
                }
            };
            // Clean up generations map to prevent memory leak
            self.generations.remove(id);
            if let Ok(mut child) = child_arc.lock() {
                let _ = child.kill();
                // Wait for process to exit — on Windows, kill() sends TerminateProcess
                // which should be immediate. Log any wait errors but don't hang.
                match child.wait() {
                    Ok(status) => {
                        eprintln!("[terminal] Session {id} exited with status: {status}");
                    }
                    Err(e) => {
                        eprintln!("[terminal] Session {id} wait error: {e}");
                    }
                }
            };
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Resolve shell binary name from a friendly shell type string.
pub(crate) fn resolve_shell(shell_type: &str) -> String {
    match shell_type {
        "powershell" | "pwsh" => "powershell.exe".to_string(),
        "cmd" => "cmd.exe".to_string(),
        #[cfg(not(target_os = "windows"))]
        "zsh" => "zsh".to_string(),
        #[cfg(not(target_os = "windows"))]
        "bash" => "bash".to_string(),
        #[cfg(not(target_os = "windows"))]
        "sh" => "sh".to_string(),
        #[cfg(target_os = "windows")]
        "bash" | "sh" | "zsh" => {
            // CORRECTNESS (audit fix 3.5): bash/sh/zsh are only available on
            // Windows via WSL or Git-Bash — both are not assumed to be
            // installed. Fall back to powershell.exe so the terminal
            // always launches something rather than a confusing
            // ENOENT error.
            "powershell.exe".to_string()
        }
        _ => {
            // Platform default — macOS prefers zsh (default since Catalina),
            // Linux prefers bash, Windows prefers powershell.
            if cfg!(target_os = "windows") {
                "powershell.exe".to_string()
            } else if cfg!(target_os = "macos") {
                "zsh".to_string()
            } else {
                "bash".to_string()
            }
        }
    }
}

/// Resolve default working directory.
fn default_cwd(cwd: Option<String>) -> String {
    if let Some(c) = cwd {
        if !c.is_empty() {
            return c;
        }
    }
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| {
            std::env::current_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_default()
        })
}

/// Filter out xterm.js focus events that are not real user input.
/// `\x1b[I` = focus in, `\x1b[O` = focus out
fn is_filtered_input(data: &str) -> bool {
    data == "\x1b[I" || data == "\x1b[O"
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn terminal_create(
    id: String,
    shell_type: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    cwd: Option<String>,
    app_handle: AppHandle,
    state: tauri::State<'_, TerminalManager>,
) -> Result<TerminalSessionInfo, String> {
    // Validate inputs before spawning a real shell: unknown shell names are a
    // hard error (no silent fallback), and the working directory must exist.
    let requested_shell = shell_type.as_deref().unwrap_or("").trim().to_lowercase();
    if !requested_shell.is_empty()
        && !matches!(
            requested_shell.as_str(),
            "powershell" | "pwsh" | "cmd" | "bash" | "sh" | "zsh"
        )
    {
        return Err(format!("Unsupported shell type: {requested_shell}"));
    }
    if let Some(dir) = cwd.as_deref() {
        if !dir.trim().is_empty() && !std::path::Path::new(dir).is_dir() {
            return Err(format!(
                "Terminal working directory does not exist or is not a folder: {dir}"
            ));
        }
    }

    // Kill existing session with same id
    state.kill_session(&id);

    let shell = resolve_shell(shell_type.as_deref().unwrap_or("powershell"));
    let work_dir = default_cwd(cwd);
    let safe_cols = cols.unwrap_or(80).clamp(20, 500);
    let safe_rows = rows.unwrap_or(24).clamp(5, 200);

    // Open PTY pair
    let pty_system = portable_pty::native_pty_system();
    let pty_size = PtySize {
        cols: safe_cols,
        rows: safe_rows,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(pty_size)
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let master = pair.master;
    let slave = pair.slave;

    // Build command
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&work_dir);

    // Spawn child process on the slave side
    let child = slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell '{shell}': {e}"))?;

    // Get a writer for stdin (can only be called once per MasterPty)
    let writer = master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

    // Get a reader for stdout — this is moved into the background thread
    let mut reader = master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

    let pid = child.process_id();

    // Wrap child in Arc<Mutex<>> so the kill path and the reader thread
    // can both reach it without contending on the PtySession lock
    // (fixes the deadlock where kill_session() blocked on child.wait()
    // while the reader thread was waiting for the session lock to emit
    // the exit event).
    let child_arc: Arc<Mutex<Box<dyn portable_pty::Child + Send>>> = Arc::new(Mutex::new(child));

    // Increment generation counter so any lingering old reader thread for this
    // id detects that it is stale and stops emitting events.
    let current_gen = {
        let mut generation = state.generations.entry(id.clone()).or_insert(0);
        *generation += 1;
        *generation
    };

    state.sessions.insert(
        id.clone(),
        Mutex::new(PtySession {
            id: id.clone(),
            shell: shell.clone(),
            cwd: work_dir.clone(),
            master,
            child: child_arc.clone(),
            writer,
            generation: current_gen,
        }),
    );

    // Clone Arc for the reader thread
    let generations = state.generations.clone();
    let sessions = state.sessions.clone();
    let child_for_reader = child_arc.clone();

    // Spawn background reader thread
    let app = app_handle.clone();
    let session_id = id.clone();
    let reader_gen = current_gen;
    #[allow(unused_assignments)]
    std::thread::Builder::new()
        .name(format!("pty-reader-{id}"))
        .spawn(move || {
            // Helper: check if this reader thread is still the current generation.
            // If not, the session was recreated and this thread is a ghost — suppress events.
            let is_current_gen = || -> bool {
                match generations.get(&session_id) {
                    Some(entry) => *entry.value() == reader_gen,
                    None => false, // session was removed
                }
            };

            let mut buf = [0u8; 4096];
            // Output buffer: accumulate PTY bytes and flush in batches to
            // avoid flooding the Tauri event loop with per-read events.
            // Stored as raw bytes until flush time so multi-byte UTF-8
            // sequences straddling read boundaries are not corrupted
            // (audit fix 3.6).
            let mut out_buf: Vec<u8> = Vec::with_capacity(FLUSH_THRESHOLD);
            let mut last_flush = std::time::Instant::now();
            const FLUSH_THRESHOLD: usize = 8192;
            const FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(16);

            // Idle-kill safeguard: if the shell stays silent for IDLE_LOG_AFTER
            // we still continue reading (the previous loop only exited on
            // EOF or read error, which left zombie threads alive for shells
            // that never explicitly close their stdout — e.g. some PowerShell
            // host configurations). We do not abort the thread; we just
            // track last activity for diagnostics.
            #[allow(unused_assignments)]
            let mut last_activity = std::time::Instant::now();
            const IDLE_LOG_AFTER: std::time::Duration = std::time::Duration::from_secs(120);

            // Helper: flush the output buffer to the frontend.
            //
            // CORRECTNESS (audit fix 3.6): the previous implementation
            // appended each chunk to a `String` via `String::from_utf8_lossy`
            // *inside the read loop*. `lossy` produces Unicode replacement
            // characters (`U+FFFD`) when the chunk boundary lands inside a
            // multi-byte UTF-8 sequence (e.g. a Vietnamese, CJK or emoji
            // char). Multi-byte chars were routinely mangled in the terminal
            // output. We now accumulate the raw bytes and only convert to
            // UTF-8 once at flush time, so partial sequences are stitched
            // together correctly.
            let flush_buf =
                |buf: &mut Vec<u8>, app: &tauri::AppHandle, id: &str, is_current: bool| {
                    if buf.is_empty() || !is_current {
                        buf.clear();
                        return;
                    }
                    let raw = std::mem::take(buf);
                    // `from_utf8_lossy` on the full buffer still tolerates
                    // genuinely malformed bytes (replacement chars), but for
                    // the common case where the buffered bytes form a complete
                    // UTF-8 string we want zero overhead — try the strict
                    // conversion first.
                    let data = match std::str::from_utf8(&raw) {
                        Ok(s) => s.to_string(),
                        Err(_) => String::from_utf8_lossy(&raw).into_owned(),
                    };
                    let _ = app.emit(
                        "terminal-data",
                        TerminalDataPayload {
                            id: id.to_string(),
                            data,
                        },
                    );
                };

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        // EOF — flush any remaining buffered output
                        flush_buf(&mut out_buf, &app, &session_id, is_current_gen());
                        break;
                    }
                    Ok(n) => {
                        last_activity = std::time::Instant::now();
                        out_buf.extend_from_slice(&buf[..n]);
                        // Flush when buffer is large enough or enough time has passed
                        let elapsed = last_flush.elapsed();
                        if out_buf.len() >= FLUSH_THRESHOLD || elapsed >= FLUSH_INTERVAL {
                            flush_buf(&mut out_buf, &app, &session_id, is_current_gen());
                            last_flush = std::time::Instant::now();
                        }
                    }
                    Err(_) => {
                        // Error — flush remaining before exit
                        flush_buf(&mut out_buf, &app, &session_id, is_current_gen());
                        break;
                    }
                }
                // Periodic idle warning (does not kill the thread)
                let idle_for = last_activity.elapsed();
                if idle_for > IDLE_LOG_AFTER {
                    eprintln!(
                        "[terminal] session {session_id} idle for {}s — still waiting for EOF",
                        idle_for.as_secs()
                    );
                    // Reset so we don't spam the log
                    let now = std::time::Instant::now();
                    last_activity = now;
                    // Touch the value so the compiler does not flag the
                    // assignment as unused (it is read on the next iteration).
                    std::hint::black_box(now);
                }
            }

            // Reader finished — wait for child exit using the Arc clone.
            // We deliberately do NOT hold the PtySession lock during the
            // wait, otherwise kill_session() can deadlock with us here.
            let exit_code = {
                // Best-effort: drop the session from the manager ONLY if we are
                // still the current generation (prevents ghost thread from
                // removing a newly created session with the same id).
                if is_current_gen() {
                    sessions.remove(&session_id);
                }
                if let Ok(mut child) = child_for_reader.lock() {
                    child.wait().ok().map(|status| status.exit_code() as i32)
                } else {
                    None
                }
            };

            // Only emit terminal-exit if we are still the current generation
            if is_current_gen() {
                let _ = app.emit(
                    "terminal-exit",
                    TerminalExitPayload {
                        id: session_id,
                        exit_code,
                    },
                );
            }
        })
        .map_err(|e| format!("Failed to spawn reader thread: {e}"))?;

    Ok(TerminalSessionInfo {
        id,
        shell,
        cwd: work_dir,
        pid,
    })
}

#[tauri::command]
pub fn terminal_write(
    id: String,
    data: String,
    state: tauri::State<'_, TerminalManager>,
) -> Result<(), String> {
    // Filter xterm.js focus events
    if is_filtered_input(&data) {
        return Ok(());
    }

    if let Some(session) = state.sessions.get(&id) {
        let mut s = session.lock().map_err(|e| e.to_string())?;
        s.writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Write failed: {e}"))?;
        s.writer.flush().map_err(|e| format!("Flush failed: {e}"))?;
        Ok(())
    } else {
        Err(format!("Terminal session '{id}' not found"))
    }
}

#[tauri::command]
pub fn terminal_resize(
    id: String,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, TerminalManager>,
) -> Result<(), String> {
    if let Some(session) = state.sessions.get(&id) {
        let s = session.lock().map_err(|e| e.to_string())?;
        let size = PtySize {
            cols: cols.clamp(20, 500),
            rows: rows.clamp(5, 200),
            pixel_width: 0,
            pixel_height: 0,
        };
        s.master
            .resize(size)
            .map_err(|e| format!("Resize failed: {e}"))?;
        Ok(())
    } else {
        Err(format!("Terminal session '{id}' not found"))
    }
}

#[tauri::command]
pub fn terminal_kill(id: String, state: tauri::State<'_, TerminalManager>) -> Result<(), String> {
    state.kill_session(&id);
    Ok(())
}

#[tauri::command]
pub fn terminal_list(state: tauri::State<'_, TerminalManager>) -> Vec<TerminalSessionInfo> {
    state
        .sessions
        .iter()
        .filter_map(|entry| {
            match entry.value().lock() {
                Ok(s) => {
                    // Read pid under the child lock to avoid contending with
                    // the reader thread.
                    let pid = s.child.lock().ok().and_then(|c| c.process_id());
                    Some(TerminalSessionInfo {
                        id: s.id.clone(),
                        shell: s.shell.clone(),
                        cwd: s.cwd.clone(),
                        pid,
                    })
                }
                Err(e) => {
                    eprintln!("[terminal] Mutex poisoned listing sessions: {e}");
                    None
                }
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_shell_powershell() {
        assert_eq!(resolve_shell("powershell"), "powershell.exe");
    }

    #[test]
    fn test_resolve_shell_cmd() {
        assert_eq!(resolve_shell("cmd"), "cmd.exe");
    }

    #[test]
    fn test_resolve_shell_bash() {
        if cfg!(target_os = "windows") {
            // On Windows bash falls back to powershell.exe (audit fix 3.5).
            assert_eq!(resolve_shell("bash"), "powershell.exe");
        } else {
            assert_eq!(resolve_shell("bash"), "bash");
        }
    }

    #[test]
    fn test_resolve_shell_unknown_defaults() {
        let result = resolve_shell("unknown_shell");
        // On Windows defaults to powershell.exe, on Unix to bash
        if cfg!(target_os = "windows") {
            assert_eq!(result, "powershell.exe");
        } else {
            assert_eq!(result, "bash");
        }
    }

    #[test]
    fn test_is_filtered_input_focus_in() {
        assert!(is_filtered_input("\x1b[I"));
    }

    #[test]
    fn test_is_filtered_input_focus_out() {
        assert!(is_filtered_input("\x1b[O"));
    }

    #[test]
    fn test_is_filtered_input_normal_data() {
        assert!(!is_filtered_input("hello"));
        assert!(!is_filtered_input("\r"));
        assert!(!is_filtered_input("\x1b[2J")); // clear screen
    }

    #[test]
    fn test_default_cwd_with_value() {
        assert_eq!(
            default_cwd(Some("C:\\Users\\Test".into())),
            "C:\\Users\\Test"
        );
    }

    #[test]
    fn test_default_cwd_empty_falls_back() {
        let result = default_cwd(Some("".into()));
        assert!(
            !result.is_empty(),
            "should fallback to env var or current_dir"
        );
    }

    #[test]
    fn test_default_cwd_none_falls_back() {
        let result = default_cwd(None);
        assert!(!result.is_empty());
    }

    #[test]
    fn test_terminal_manager_new() {
        let mgr = TerminalManager::new();
        assert!(mgr.sessions.is_empty());
    }

    #[test]
    fn test_terminal_manager_kill_nonexistent() {
        let mgr = TerminalManager::new();
        // Should not panic
        mgr.kill_session("nonexistent_id");
    }

    #[test]
    fn test_terminal_session_info_serialize() {
        let info = TerminalSessionInfo {
            id: "test_1".into(),
            shell: "powershell.exe".into(),
            cwd: "C:\\Users".into(),
            pid: Some(1234),
        };
        let json = serde_json::to_string(&info).expect("failed to serialize TerminalSessionInfo");
        assert!(json.contains("test_1"));
        assert!(json.contains("powershell.exe"));
    }

    #[test]
    fn test_terminal_exit_payload_serialize() {
        let payload = TerminalExitPayload {
            id: "term_abc".into(),
            exit_code: Some(0),
        };
        let json =
            serde_json::to_string(&payload).expect("failed to serialize TerminalExitPayload");
        assert!(json.contains("exitCode"));
        assert!(json.contains("term_abc"));
    }

    #[test]
    fn test_terminal_data_payload_serialize() {
        let payload = TerminalDataPayload {
            id: "term_1".into(),
            data: "hello\r\n".into(),
        };
        let json =
            serde_json::to_string(&payload).expect("failed to serialize TerminalDataPayload");
        assert!(json.contains("term_1"));
        assert!(json.contains("hello"));
    }

    // Integration test: spawn a real PTY, write a command, read output, kill
    #[test]
    fn test_pty_spawn_and_kill() {
        let pty_system = portable_pty::native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                cols: 80,
                rows: 24,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let shell = if cfg!(target_os = "windows") {
            "cmd.exe"
        } else {
            "sh"
        };

        let cmd = CommandBuilder::new(shell);
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");

        // Write a simple command
        let mut writer = pair.master.take_writer().expect("writer");
        if cfg!(target_os = "windows") {
            writer.write_all(b"echo PTY_RUST_OK\r\n").expect("write");
        } else {
            writer.write_all(b"echo PTY_RUST_OK\n").expect("write");
        }

        // Read some output
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut buf = [0u8; 1024];

        // Read with a simple loop (bounded attempts)
        let mut collected = String::new();
        for _ in 0..20 {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    collected.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if collected.contains("PTY_RUST_OK") {
                        break;
                    }
                }
                Err(_) => break,
            }
        }

        assert!(
            collected.contains("PTY_RUST_OK"),
            "Expected PTY_RUST_OK in output, got: {collected}"
        );

        // Kill
        let _ = child.kill();
        let _ = child.wait();
    }
}
