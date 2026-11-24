// ==============================================================================
// Ghita Agent — Native PTY Terminal Module (Rust) — thin Tauri adapter
// ==============================================================================
// PTY core (spawn/write/resize/kill/drain, ConPTY via portable-pty 0.8 on
// Windows / posix openpty elsewhere) lives in the shared `ghita-pty` crate
// (`crates/pty`) so the same implementation also backs the napi addon for the
// Node sidecar (agent stream mode).
//
// This module keeps the Tauri contract — frontend Terminal.tsx is untouched:
//   - Tauri invoke commands: terminal_create, terminal_write,
//     terminal_resize, terminal_kill, terminal_list
//   - Emitted Tauri events: "terminal-data", "terminal-exit"
// ==============================================================================

use ghita_pty::{PtyEventSink, PtyExitStatus, PtyManager, SessionInfo, SpawnOptions};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------
// Public types (frontend contract — do not rename)
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

/// Unified exit shape (node-pty parity). `signal` is `None` on Windows
/// (TerminateProcess surfaces as an exit code); the frontend only reads
/// `exitCode`, so the added field is backward-compatible.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TerminalExitPayload {
    pub id: String,
    #[serde(rename = "exitCode")]
    pub exit_code: Option<i32>,
    #[serde(rename = "signal")]
    pub signal: Option<i32>,
}

// Shell resolution is provided by the shared PTY core (same behaviour as the
// pre-extraction implementation, audit fixes 3.5 included).
pub use ghita_pty::resolve_shell;

// ---------------------------------------------------------------------------
// Tauri event sink — bridges the PTY core to the frontend event system
// ---------------------------------------------------------------------------

struct TauriSink {
    app: AppHandle,
}

impl PtyEventSink for TauriSink {
    fn on_data(&self, session_id: &str, data: &str) {
        let _ = self.app.emit(
            "terminal-data",
            TerminalDataPayload {
                id: session_id.to_string(),
                data: data.to_string(),
            },
        );
    }

    fn on_exit(&self, session_id: &str, status: PtyExitStatus) {
        let _ = self.app.emit(
            "terminal-exit",
            TerminalExitPayload {
                id: session_id.to_string(),
                exit_code: status.exit_code,
                signal: status.signal,
            },
        );
    }
}

fn session_info(info: SessionInfo) -> TerminalSessionInfo {
    TerminalSessionInfo {
        id: info.id,
        shell: info.shell,
        cwd: info.cwd,
        pid: info.pid,
    }
}

// ---------------------------------------------------------------------------
// Terminal Manager — thin wrapper over the shared PTY core
// ---------------------------------------------------------------------------

pub struct TerminalManager {
    inner: PtyManager,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            inner: PtyManager::new(),
        }
    }

    /// Kill all active sessions (called on app exit)
    pub fn kill_all(&self) {
        self.inner.kill_all();
    }

    fn kill_session(&self, id: &str) {
        self.inner.kill_session(id);
    }
}

// ---------------------------------------------------------------------------
// Tauri commands (contract preserved from the pre-extraction implementation)
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
    let opts = SpawnOptions {
        shell,
        args: vec![],
        cwd,
        cols: cols.unwrap_or(80),
        rows: rows.unwrap_or(24),
        // ConPTY ignores pixel hints; cell size drives the layout.
        pixel_width: 0,
        pixel_height: 0,
    };

    let sink = Arc::new(TauriSink {
        app: app_handle.clone(),
    });

    state
        .inner
        .spawn(&id, opts, sink)
        .map(session_info)
        .map_err(|e| {
            eprintln!("[terminal] Failed to create terminal session {id}: {e}");
            e
        })
}

#[tauri::command]
pub fn terminal_write(
    id: String,
    data: String,
    state: tauri::State<'_, TerminalManager>,
) -> Result<(), String> {
    state.inner.write(&id, &data)
}

#[tauri::command]
pub fn terminal_resize(
    id: String,
    cols: u16,
    rows: u16,
    // Optional pixel hints — the frontend does not send them yet; accepted so
    // pixel-aware callers (sixel/underline thickness on Unix) can use them.
    pixel_width: Option<u16>,
    pixel_height: Option<u16>,
    state: tauri::State<'_, TerminalManager>,
) -> Result<(), String> {
    state.inner.resize(
        &id,
        cols,
        rows,
        pixel_width.unwrap_or(0),
        pixel_height.unwrap_or(0),
    )
}

#[tauri::command]
pub fn terminal_kill(id: String, state: tauri::State<'_, TerminalManager>) -> Result<(), String> {
    state.kill_session(&id);
    Ok(())
}

#[tauri::command]
pub fn terminal_list(state: tauri::State<'_, TerminalManager>) -> Vec<TerminalSessionInfo> {
    state.inner.list().into_iter().map(session_info).collect()
}

// ---------------------------------------------------------------------------
// Unit tests (adapter-level; PTY core tests live in crates/pty)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_terminal_manager_new() {
        let mgr = TerminalManager::new();
        assert!(mgr.inner.list().is_empty());
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
            signal: None,
        };
        let json =
            serde_json::to_string(&payload).expect("failed to serialize TerminalExitPayload");
        assert!(json.contains("exitCode"));
        assert!(json.contains("term_abc"));
        // Unified exit shape: signal present in the wire format.
        assert!(json.contains("signal"));
    }

    #[test]
    fn test_terminal_exit_payload_signal_serialize() {
        let payload = TerminalExitPayload {
            id: "term_sig".into(),
            exit_code: None,
            signal: Some(9),
        };
        let json =
            serde_json::to_string(&payload).expect("failed to serialize TerminalExitPayload");
        assert!(json.contains("\"signal\":9"));
        assert!(json.contains("\"exitCode\":null"));
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

    #[test]
    fn test_resolve_shell_reexport_powershell() {
        // lib.rs uses terminal::resolve_shell — must remain available.
        assert_eq!(resolve_shell("powershell"), "powershell.exe");
    }
}
