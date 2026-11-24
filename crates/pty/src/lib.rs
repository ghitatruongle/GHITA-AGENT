//! Ghita Agent — Shared PTY core (Track R1)
//!
//! Platform-agnostic PTY session core extracted from
//! `apps/desktop/src-tauri/src/terminal.rs` so both the desktop app (thin Tauri
//! adapter) and the napi addon (agent stream mode) drive the same implementation.
//!
//! - Windows: ConPTY via `portable-pty` 0.8 (Win10 1809+)
//! - Linux/macOS: posix PTY via `portable-pty`
//!
//! Contract: [`PtyManager`] owns sessions keyed by caller-supplied ids;
//! output is drained on a background reader thread (batched 8KB / 16ms,
//! raw bytes buffered to the flush boundary so multi-byte UTF-8 sequences
//! survive) and delivered through [`PtyEventSink`].

use dashmap::DashMap;
use portable_pty::{CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

// Windows-only helpers (kill-tree, commandline escape) — ported from node-pty.
#[cfg(target_os = "windows")]
pub mod windows;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Summary of a live PTY session.
#[derive(Clone, Debug)]
pub struct SessionInfo {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub pid: Option<u32>,
}

/// Unified exit shape (node-pty parity): `exit_code` is `Some` on normal
/// termination, `signal` is `Some` when the process died from a signal.
/// Windows never reports signals (TerminateProcess surfaces as an exit code);
/// portable-pty 0.8 does not expose the posix signal publicly, so Unix
/// signal numbers are best-effort `None` (documented upstream limitation).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PtyExitStatus {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
}

impl PtyExitStatus {
    pub fn from_code(code: Option<i32>) -> Self {
        Self {
            exit_code: code,
            signal: None,
        }
    }
}

/// Consumer of PTY output. The Tauri adapter emits `terminal-data` /
/// `terminal-exit` events; the napi addon forwards to JS callbacks.
pub trait PtyEventSink: Send + Sync + 'static {
    /// Raw output converted to UTF-8 at flush boundaries (lossy only for
    /// genuinely malformed bytes — see reader thread below).
    fn on_data(&self, session_id: &str, data: &str);
    /// Emitted once when the reader thread observes EOF / read error and the
    /// child has been reaped.
    fn on_exit(&self, session_id: &str, status: PtyExitStatus);
}

/// Options for [`PtyManager::spawn`].
#[derive(Clone, Debug)]
pub struct SpawnOptions {
    /// Resolved shell/program binary (call [`resolve_shell`] for friendly
    /// shell-type names, or pass a full command program directly).
    pub shell: String,
    /// Extra argv elements appended after the program.
    pub args: Vec<String>,
    /// Working directory (falls back to [`default_cwd`] when empty/absent).
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// Pixel size hints (used by Unix TIOCSWINSZ; ConPTY ignores them).
    pub pixel_width: u16,
    pub pixel_height: u16,
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
    /// check this to suppress stale ("ghost") events and to keep their
    /// remove_if cleanup from deleting a newer session with the same id.
    generation: u64,
    /// Creation time of the child process (Windows: FILETIME as u64) recorded
    /// right after spawn — the PID-reuse race guard for kill-tree.
    #[allow(dead_code)]
    pid_start_time: Option<u64>,
}

// ---------------------------------------------------------------------------
// PTY Manager — owns all PTY sessions
// ---------------------------------------------------------------------------

pub struct PtyManager {
    sessions: Arc<DashMap<String, Mutex<PtySession>>>,
    /// Tracks the current generation per session id so old reader threads
    /// can be detected and silenced.
    generations: Arc<DashMap<String, u64>>,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
            generations: Arc::new(DashMap::new()),
        }
    }

    /// Spawn a PTY session. Output is drained by a background reader thread
    /// that calls `sink.on_data(...)` in batches; on child exit the session is
    /// removed and `sink.on_exit(...)` fires (suppressed for stale ghosts).
    pub fn spawn(
        &self,
        id: &str,
        opts: SpawnOptions,
        sink: Arc<dyn PtyEventSink>,
    ) -> Result<SessionInfo, String> {
        let work_dir = default_cwd(opts.cwd.clone());
        let safe_cols = opts.cols.clamp(20, 500);
        let safe_rows = opts.rows.clamp(5, 200);

        // Open PTY pair
        let pty_system = portable_pty::native_pty_system();
        let pty_size = PtySize {
            cols: safe_cols,
            rows: safe_rows,
            pixel_width: opts.pixel_width,
            pixel_height: opts.pixel_height,
        };

        let pair = pty_system
            .openpty(pty_size)
            .map_err(|e| format!("Failed to open PTY: {e}"))?;

        let master = pair.master;
        let slave = pair.slave;

        // Build command
        let mut cmd = CommandBuilder::new(&opts.shell);
        cmd.cwd(&work_dir);
        for arg in &opts.args {
            cmd.arg(arg);
        }

        // Spawn child process on the slave side
        let child = slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell '{}': {e}", opts.shell))?;

        // Get a writer for stdin (can only be called once per MasterPty)
        let writer = master
            .take_writer()
            .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

        // Get a reader for stdout — this is moved into the background thread
        let mut reader = master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

        let pid = child.process_id();

        // Record the child's start time immediately after spawn — the
        // PID-reuse guard used by the console-aware kill-tree. The race window
        // here is negligible (the child was just created and is alive).
        let pid_start_time = pid.and_then(process_start_time_by_pid);

        // Wrap child in Arc<Mutex<>> so the kill path and the reader thread
        // can both reach it without contending on the PtySession lock
        // (fixes the deadlock where kill_session() blocked on child.wait()
        // while the reader thread was waiting for the session lock to emit
        // the exit event).
        let child_arc: Arc<Mutex<Box<dyn portable_pty::Child + Send>>> =
            Arc::new(Mutex::new(child));

        // Increment generation counter so any lingering old reader thread for
        // this id detects that it is stale and stops emitting events.
        let current_gen = {
            let mut generation = self.generations.entry(id.to_string()).or_insert(0);
            *generation += 1;
            *generation
        };

        self.sessions.insert(
            id.to_string(),
            Mutex::new(PtySession {
                id: id.to_string(),
                shell: opts.shell.clone(),
                cwd: work_dir.clone(),
                master,
                child: child_arc.clone(),
                writer,
                generation: current_gen,
                pid_start_time,
            }),
        );

        // Clone Arcs for the reader thread
        let generations = self.generations.clone();
        let sessions = self.sessions.clone();
        let child_for_reader = child_arc.clone();

        // Spawn background reader thread
        let session_id = id.to_string();
        let reader_gen = current_gen;
        std::thread::Builder::new()
            .name(format!("pty-reader-{id}"))
            .spawn(move || {
                drain_reader(
                    &mut reader,
                    &mut drain::Env {
                        sink,
                        generations,
                        sessions,
                        child_for_reader,
                        session_id,
                        reader_gen,
                    },
                );
            })
            .map_err(|e| {
                // Roll back the half-registered session: without a reader
                // thread nothing drains output or removes the session, so
                // write/resize/kill by id would hit an undead entry.
                self.sessions.remove(id);
                self.generations.remove(id);
                format!("Failed to spawn reader thread: {e}")
            })?;

        Ok(SessionInfo {
            id: id.to_string(),
            shell: opts.shell,
            cwd: work_dir,
            pid,
        })
    }

    /// Write user input to the session's PTY (filters xterm.js focus events).
    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        if is_filtered_input(data) {
            return Ok(());
        }

        if let Some(session) = self.sessions.get(id) {
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

    /// Resize the session PTY (cell size + optional pixel hints).
    pub fn resize(
        &self,
        id: &str,
        cols: u16,
        rows: u16,
        pixel_width: u16,
        pixel_height: u16,
    ) -> Result<(), String> {
        if let Some(session) = self.sessions.get(id) {
            let s = session.lock().map_err(|e| e.to_string())?;
            let size = PtySize {
                cols: cols.clamp(20, 500),
                rows: rows.clamp(5, 200),
                pixel_width,
                pixel_height,
            };
            s.master
                .resize(size)
                .map_err(|e| format!("Resize failed: {e}"))?;
            Ok(())
        } else {
            Err(format!("Terminal session '{id}' not found"))
        }
    }

    /// Kill one session (process tree on Windows, process/group on Unix).
    pub fn kill_session(&self, id: &str) {
        if let Some((_key, session)) = self.sessions.remove(id) {
            // Lock the session briefly to extract the child Arc, then drop
            // the lock before doing any blocking wait — this avoids holding
            // the PtySession mutex while the child exits.
            let (child_arc, pid, pid_start_time) = {
                match session.lock() {
                    Ok(s) => (
                        s.child.clone(),
                        s.child.lock().ok().and_then(|c| c.process_id()),
                        s.pid_start_time,
                    ),
                    Err(e) => {
                        eprintln!("[pty] Mutex poisoned while killing session {id}: {e}");
                        // Still clean up generations even on error
                        self.generations.remove(id);
                        return;
                    }
                }
            };
            // Clean up generations map to prevent memory leak — but only
            // when no session with this id was re-spawned concurrently:
            // deleting a racing spawn's counter would silence its reader
            // thread forever (stale-ghost detection) and leak the session.
            if self.sessions.get(id).is_none() {
                self.generations.remove(id);
            }

            // Kill the process tree first (console-aware on Windows) so
            // grandchildren (e.g. `start`ed programs) are not orphaned.
            kill_process_tree(&child_arc, pid, pid_start_time);

            if let Ok(mut child) = child_arc.lock() {
                let _ = child.kill();
                // Wait for process to exit — on Windows, kill() sends TerminateProcess
                // which should be immediate. Log any wait errors but don't hang.
                match child.wait() {
                    Ok(status) => {
                        eprintln!("[pty] Session {id} exited with status: {status}");
                    }
                    Err(e) => {
                        eprintln!("[pty] Session {id} wait error: {e}");
                    }
                }
            };
        }
    }

    /// Kill all active sessions (called on app exit).
    pub fn kill_all(&self) {
        let ids: Vec<String> = self.sessions.iter().map(|e| e.key().clone()).collect();
        for id in ids {
            self.kill_session(&id);
        }
    }

    /// Snapshot of all live sessions.
    pub fn list(&self) -> Vec<SessionInfo> {
        self.sessions
            .iter()
            .filter_map(|entry| {
                match entry.value().lock() {
                    Ok(s) => {
                        // Read pid under the child lock to avoid contending with
                        // the reader thread.
                        let pid = s.child.lock().ok().and_then(|c| c.process_id());
                        Some(SessionInfo {
                            id: s.id.clone(),
                            shell: s.shell.clone(),
                            cwd: s.cwd.clone(),
                            pid,
                        })
                    }
                    Err(e) => {
                        eprintln!("[pty] Mutex poisoned listing sessions: {e}");
                        None
                    }
                }
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Reader-thread drain (batched output, UTF-8 boundary handling, ghost guard)
// ---------------------------------------------------------------------------

mod drain {
    use super::{PtyEventSink, PtySession};
    use dashmap::DashMap;
    use std::sync::{Arc, Mutex};

    pub struct Env {
        pub sink: Arc<dyn PtyEventSink>,
        pub generations: Arc<DashMap<String, u64>>,
        pub sessions: Arc<DashMap<String, Mutex<PtySession>>>,
        pub child_for_reader: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
        pub session_id: String,
        pub reader_gen: u64,
    }
}

/// Length of the longest prefix of `buf` that may be emitted as UTF-8 text
/// right now:
/// - fully valid buffer → whole length;
/// - trailing INCOMPLETE multi-byte sequence (`error_len() == None`) → only
///   the valid prefix (`valid_up_to()`); `0` when the buffer is nothing but
///   an incomplete head, so the caller keeps buffering;
/// - genuinely malformed bytes → whole length (caller converts lossily);
/// - `at_eof` / buffer over `cap` → whole length (an incomplete tail can
///   never complete — emit it through the lossy path instead of holding it).
fn utf8_flushable_len(buf: &[u8], at_eof: bool, cap: usize) -> usize {
    if at_eof || buf.len() >= cap {
        return buf.len();
    }
    match std::str::from_utf8(buf) {
        Ok(_) => buf.len(),
        Err(err) if err.error_len().is_none() => err.valid_up_to(),
        Err(_) => buf.len(),
    }
}

/// Blocking read loop for one PTY session. Extracted verbatim (behaviour
/// parity) from the original `terminal.rs` reader thread.
fn drain_reader(reader: &mut Box<dyn Read + Send>, env: &mut drain::Env) {
    let drain::Env {
        sink,
        generations,
        sessions,
        child_for_reader,
        session_id,
        reader_gen,
    } = env;

    let sink = sink.clone();
    let session_id = session_id.clone();
    let reader_gen = *reader_gen;

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
    // avoid flooding the event sink with per-read events.
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
    #[allow(unused_assignments)] // initializer is overwritten before read in Ok(n) path
    let mut last_activity = std::time::Instant::now();
    const IDLE_LOG_AFTER: std::time::Duration = std::time::Duration::from_secs(120);

    // Helper: flush the output buffer to the sink.
    //
    // CORRECTNESS (audit fix 3.6): the previous implementation
    // appended each chunk to a `String` via `String::from_utf8_lossy`
    // *inside the read loop*. `lossy` produces Unicode replacement
    // characters (`U+FFFD`) when the chunk boundary lands inside a
    // multi-byte UTF-8 sequence (e.g. a Vietnamese, CJK or emoji
    // char). Multi-byte chars were routinely mangled in the terminal
    // output. We now accumulate the raw bytes and only convert to
    // UTF-8 once at flush time.
    //
    // Follow-up: the 16 ms interval flush can still land INSIDE a
    // multi-byte sequence (slow writer). Converting the whole buffer
    // with `from_utf8_lossy` at that boundary emitted U+FFFD and DROPPED
    // the incomplete tail — the remainder arriving in the next chunk
    // then produced a second U+FFFD. The flush therefore only drains
    // the longest VALID UTF-8 prefix and keeps the incomplete tail
    // buffered so the next read stitches the sequence back together.
    // At EOF (or when a pathological writer keeps the buffer capped at
    // 4x the flush threshold) the tail can never complete — flush
    // everything through `from_utf8_lossy` (upstream parity).
    let flush_buf =
        |buf: &mut Vec<u8>, sink: &dyn PtyEventSink, id: &str, is_current: bool, at_eof: bool| {
            if buf.is_empty() || !is_current {
                buf.clear();
                return;
            }
            const CAP: usize = 4 * FLUSH_THRESHOLD;
            let flush_len = utf8_flushable_len(buf, at_eof, CAP);
            if flush_len == 0 {
                // Only an incomplete trailing sequence so far — wait for
                // the bytes that complete it before emitting anything.
                return;
            }
            let raw = buf.drain(..flush_len).collect::<Vec<u8>>();
            // `from_utf8_lossy` on the drained prefix still tolerates
            // genuinely malformed bytes (replacement chars), but for
            // the common case where the drained bytes form a complete
            // UTF-8 string we want zero overhead — try the strict
            // conversion first.
            let data = match std::str::from_utf8(&raw) {
                Ok(s) => s,
                Err(_) => &String::from_utf8_lossy(&raw),
            };
            sink.on_data(id, data);
        };

    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                // EOF — flush any remaining buffered output (the tail can
                // never complete now → lossy).
                flush_buf(
                    &mut out_buf,
                    sink.as_ref(),
                    &session_id,
                    is_current_gen(),
                    true,
                );
                break;
            }
            Ok(n) => {
                last_activity = std::time::Instant::now();
                out_buf.extend_from_slice(&buf[..n]);
                // Flush when buffer is large enough or enough time has passed
                let elapsed = last_flush.elapsed();
                if out_buf.len() >= FLUSH_THRESHOLD || elapsed >= FLUSH_INTERVAL {
                    // Keep an incomplete trailing UTF-8 sequence buffered so
                    // the flush boundary cannot split a multi-byte char.
                    flush_buf(
                        &mut out_buf,
                        sink.as_ref(),
                        &session_id,
                        is_current_gen(),
                        false,
                    );
                    last_flush = std::time::Instant::now();
                }
            }
            Err(_) => {
                // Error — flush remaining before exit (no more reads → lossy).
                flush_buf(
                    &mut out_buf,
                    sink.as_ref(),
                    &session_id,
                    is_current_gen(),
                    true,
                );
                break;
            }
        }
        // Periodic idle warning (does not kill the thread)
        let idle_for = last_activity.elapsed();
        if idle_for > IDLE_LOG_AFTER {
            eprintln!(
                "[pty] session {session_id} idle for {}s — still waiting for EOF",
                idle_for.as_secs()
            );
            // Reset so we don't spam the log
            let now = std::time::Instant::now();
            last_activity = now;
            // Touch the value so the compiler does not flag the
            // assignment as unused (it is read on the next iteration).
            std::hint::black_box(&last_activity);
        }
    }

    // Reader finished — wait for child exit using the Arc clone.
    // We deliberately do NOT hold the PtySession lock during the
    // wait, otherwise kill_session() can deadlock with us here.
    //
    // The "am I stale" test and the map cleanup are made atomic via
    // remove_if + the session's generation stamp: the previous
    // check-then-remove (`if is_current_gen() { sessions.remove(..) }`)
    // raced a spawn of the same id in between and could delete the NEW
    // session. remove_if skips the entry when the generation moved on.
    // The generations entry is also removed here (previously only
    // kill_session cleaned it up) so normally-exited sessions don't leak
    // a counter per id.
    let was_current = is_current_gen();
    if was_current {
        sessions.remove_if(&session_id, |_, s| {
            s.lock()
                .map(|s| s.generation == reader_gen)
                .unwrap_or(false)
        });
        generations.remove_if(&session_id, |_, g| *g == reader_gen);
    }
    let code = if let Ok(mut child) = child_for_reader.lock() {
        child.wait().ok().map(|s| s.exit_code() as i32)
    } else {
        None
    };
    let status = PtyExitStatus::from_code(code);

    // Only emit terminal-exit if we were the current generation when the
    // reader finished (captured before the cleanup above).
    if was_current {
        sink.on_exit(&session_id, status);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Resolve shell binary name from a friendly shell type string.
pub fn resolve_shell(shell_type: &str) -> String {
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
pub fn default_cwd(cwd: Option<String>) -> String {
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
pub fn is_filtered_input(data: &str) -> bool {
    data == "\x1b[I" || data == "\x1b[O"
}

// ---------------------------------------------------------------------------
// Kill-tree plumbing
// ---------------------------------------------------------------------------

/// Kill the process tree rooted at the session's child.
/// Windows: console-aware tree kill (see `windows::kill_console_process_tree`)
/// guarded against PID-reuse via recorded start times.
/// Unix: SIGKILL to the child's process group (portable-pty puts the child in
/// its own session via setsid, so pgid == child pid initially), then the
/// direct child kill happens in the caller.
fn kill_process_tree(
    _child_arc: &Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
    _pid: Option<u32>,
    _pid_start_time: Option<u64>,
) {
    #[cfg(target_os = "windows")]
    {
        if let Some(pid) = _pid {
            windows::kill_console_process_tree(pid, _pid_start_time);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Best-effort process-group kill: the shell was started with setsid
        // (own session/pgid), so killing the group takes descendants down.
        if let Some(pid) = _pid {
            unsafe {
                libc::killpg(pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }
}

/// Query a process's creation time by PID (Windows: FILETIME as u64;
/// other platforms: None). Used for the PID-reuse race guard.
#[cfg(target_os = "windows")]
fn process_start_time_by_pid(pid: u32) -> Option<u64> {
    windows::process_start_time_by_pid(pid)
}

#[cfg(not(target_os = "windows"))]
fn process_start_time_by_pid(_pid: u32) -> Option<u64> {
    None
}

// ---------------------------------------------------------------------------
// Tests (moved from apps/desktop/src-tauri/src/terminal.rs)
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
        // Platform default — must match the `_ =>` arm of `resolve_shell`:
        // Windows → powershell.exe, macOS → zsh (default since Catalina),
        // everything else → bash.
        if cfg!(target_os = "windows") {
            assert_eq!(result, "powershell.exe");
        } else if cfg!(target_os = "macos") {
            assert_eq!(result, "zsh");
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
    fn test_pty_manager_new() {
        let mgr = PtyManager::new();
        assert!(mgr.list().is_empty());
    }

    #[test]
    fn test_pty_manager_kill_nonexistent() {
        let mgr = PtyManager::new();
        // Should not panic
        mgr.kill_session("nonexistent_id");
    }

    #[test]
    fn test_session_info_clone_debug() {
        let info = SessionInfo {
            id: "test_1".into(),
            shell: "powershell.exe".into(),
            cwd: "C:\\Users".into(),
            pid: Some(1234),
        };
        let cloned = info.clone();
        assert_eq!(cloned.id, "test_1");
        assert!(format!("{cloned:?}").contains("powershell.exe"));
    }

    #[test]
    fn test_exit_status_shape() {
        let status = PtyExitStatus::from_code(Some(0));
        assert_eq!(status.exit_code, Some(0));
        assert_eq!(status.signal, None);
        let status = PtyExitStatus {
            exit_code: None,
            signal: Some(9),
        };
        assert_eq!(status.signal, Some(9));
    }

    // --- UTF-8 flush boundary (batch/time flush must not split multibyte) ---

    #[test]
    fn test_utf8_flushable_len_valid_and_incomplete_tail() {
        let cap = 4096;
        // Fully valid ASCII → flush everything.
        assert_eq!(utf8_flushable_len(b"hello", false, cap), 5);
        // Valid ASCII prefix + COMPLETE multibyte char → flush everything.
        let vi = "aẽ".as_bytes(); // ẽ = 3-byte char
        assert_eq!(utf8_flushable_len(vi, false, cap), vi.len());
        // ASCII prefix + INCOMPLETE tail → only the valid prefix flushes.
        let mut split = b"a".to_vec();
        split.extend_from_slice(&"ẽ".as_bytes()[..2]); // first 2 of 3 bytes
        assert_eq!(utf8_flushable_len(&split, false, cap), 1);
        // Buffer is ONLY an incomplete head → flush nothing, keep buffering.
        let head = &"ẽ".as_bytes()[..1];
        assert_eq!(utf8_flushable_len(head, false, cap), 0);
        // The tail completes at the next flush → whole sequence emitted.
        let mut complete = split.clone();
        complete.extend_from_slice(&"ẽ".as_bytes()[2..]);
        assert_eq!(utf8_flushable_len(&complete, false, cap), complete.len());
    }

    #[test]
    fn test_utf8_flushable_len_malformed_and_eof() {
        let cap = 4096;
        // Genuinely malformed bytes (overlong 0xC0 0x80) → whole buffer goes
        // through the lossy path (replacement chars), nothing retained.
        assert_eq!(utf8_flushable_len(&[b'a', 0xC0, 0x80, b'b'], false, cap), 4);
        // Incomplete tail at EOF can never complete → flush everything lossy.
        let mut split = b"a".to_vec();
        split.extend_from_slice(&"ẽ".as_bytes()[..2]);
        assert_eq!(utf8_flushable_len(&split, true, cap), split.len());
        // Pathological writer keeps the buffer at the cap → flush lossy to
        // bound memory instead of buffering an unterminated sequence forever
        // (cap 3 == buffer length 3 → `len >= cap` forces the lossy flush).
        assert_eq!(utf8_flushable_len(&split, false, 3), split.len());
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

    // Integration test through the manager: spawn via PtyManager, collect
    // output through the event sink, kill via manager.
    #[test]
    fn test_manager_spawn_write_drain_kill() {
        use std::sync::mpsc;

        struct MpscSink {
            tx: mpsc::Sender<String>,
        }
        impl PtyEventSink for MpscSink {
            fn on_data(&self, _session_id: &str, data: &str) {
                let _ = self.tx.send(data.to_string());
            }
            fn on_exit(&self, _session_id: &str, _status: PtyExitStatus) {
                let _ = self.tx.send("\x01__EXIT__".to_string());
            }
        }

        let mgr = PtyManager::new();
        let (tx, rx) = mpsc::channel::<String>();
        let shell = if cfg!(target_os = "windows") {
            "cmd.exe"
        } else {
            "sh"
        };

        let info = mgr
            .spawn(
                "mgr_test_1",
                SpawnOptions {
                    shell: shell.to_string(),
                    args: vec![],
                    cwd: None,
                    cols: 80,
                    rows: 24,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                Arc::new(MpscSink { tx }),
            )
            .expect("spawn");

        assert_eq!(info.id, "mgr_test_1");
        assert!(info.pid.is_some());

        // Give the shell a moment to boot before the first probe write.
        std::thread::sleep(std::time::Duration::from_millis(500));
        let probe = if cfg!(target_os = "windows") {
            "echo MANAGER_PTY_OK\r\n"
        } else {
            "echo MANAGER_PTY_OK\n"
        };

        // Collect the marker, re-sending the probe on a quiet window.
        //
        // Two separate flakes made this test fail on macOS runners while the
        // PTY itself worked fine:
        //
        //  1. Breaking out on the first `recv_timeout` (200 ms of silence)
        //     truncated the capture to the bare prompt ("sh-3.2$ e") — the
        //     loop now waits for a wall-clock deadline instead.
        //  2. A single write sent before the shell finished initialising is
        //     DISCARDED: an interactive shell flushes pending terminal input
        //     when it takes over the tty (`tcsetattr(TCSAFLUSH)`), so a cold
        //     runner that needs >500 ms to reach the prompt silently ate the
        //     command — the loop then waited the full deadline for output that
        //     was never going to arrive (10.86 s run, marker absent). The probe
        //     is therefore re-sent after each quiet window until it lands.
        //
        // The extra lines are harmless for the assertion: it only checks that
        // the marker appears, and an already-running shell just echoes them.
        let mut collected = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        let mut wrote = false;
        while std::time::Instant::now() < deadline {
            if !wrote {
                mgr.write("mgr_test_1", probe).expect("write");
                wrote = true;
            }
            match rx.recv_timeout(std::time::Duration::from_millis(500)) {
                Ok(data) => {
                    collected.push_str(&data);
                    if collected.contains("MANAGER_PTY_OK") {
                        break;
                    }
                }
                // Quiet window — the shell may still be booting (or dropped
                // the earlier probe), so re-send and keep polling.
                Err(mpsc::RecvTimeoutError::Timeout) => wrote = false,
                // Sink dropped: no further events can arrive.
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        assert!(
            collected.contains("MANAGER_PTY_OK"),
            "Expected MANAGER_PTY_OK in output, got: {collected}"
        );

        // Resize should not error on a live session.
        mgr.resize("mgr_test_1", 100, 30, 0, 0).expect("resize");

        mgr.kill_session("mgr_test_1");
        assert!(
            mgr.list().iter().all(|s| s.id != "mgr_test_1"),
            "session must be removed after kill"
        );
    }
}
