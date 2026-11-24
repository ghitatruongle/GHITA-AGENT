//! Ghita Agent — PTY NAPI addon (Track R1 P3)
//!
//! napi surface behind the `addon` feature — loaded by @ghita/native-bridge
//! under the name `pty`. Mirrors the secscan/retrieval/codegraph/sandbox addon
//! pattern (dyn-symbols, no libnode.dll at link time).
//!
//! Purpose: give the Node sidecar (agent `run_command`) real PTY execution —
//! stream output to JS callbacks via ThreadsafeFunction (ErrorStrategy::Fatal:
//! callbacks receive values directly, no leading error argument) while the
//! shared [`PtyManager`] core owns sessions, draining and the console-aware
//! kill-tree.

#![allow(dead_code)]

use crate::{PtyEventSink, PtyExitStatus, PtyManager, SpawnOptions};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
    ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi::{Env, JsFunction, JsUnknown, Result};
use napi_derive::napi;
use std::sync::{Arc, OnceLock};

static MANAGER: OnceLock<PtyManager> = OnceLock::new();

fn manager() -> &'static PtyManager {
    MANAGER.get_or_init(PtyManager::new)
}

// ---------------------------------------------------------------------------
// JS-facing types
// ---------------------------------------------------------------------------

/// Unified exit shape (node-pty parity): `{ exitCode, signal }`.
#[napi(object)]
pub struct PtyExitOutput {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
}

#[napi(object)]
pub struct PtySpawnOutput {
    pub id: String,
    pub pid: Option<f64>,
}

#[napi(object)]
pub struct PtySessionOutput {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub pid: Option<f64>,
}

// ---------------------------------------------------------------------------
// Sink — bridges PTY core callbacks to JS ThreadsafeFunctions
// ---------------------------------------------------------------------------

struct NapiSink {
    on_data: ThreadsafeFunction<(String, String), ErrorStrategy::Fatal>,
    on_exit: ThreadsafeFunction<(String, Option<i32>, Option<i32>), ErrorStrategy::Fatal>,
}

impl PtyEventSink for NapiSink {
    fn on_data(&self, session_id: &str, data: &str) {
        let _ = self.on_data.call(
            (session_id.to_string(), data.to_string()),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    }

    fn on_exit(&self, session_id: &str, status: PtyExitStatus) {
        let _ = self.on_exit.call(
            (session_id.to_string(), status.exit_code, status.signal),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    }
}

fn unknown_from_option_i32(
    env: &Env,
    value: Option<i32>,
) -> std::result::Result<JsUnknown, napi::Error> {
    match value {
        Some(v) => Ok(env.create_int32(v)?.into_unknown()),
        None => Ok(env.get_null()?.into_unknown()),
    }
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

/// Spawn a PTY session. `command` is the program (resolved shell binary or a
/// command), `args` the argv tail. Output streams to `onData(id, data)` in
/// batches (8KB / 16ms, UTF-8 boundary-safe) and `onExit(id, exitCode, signal)`
/// fires once when the child is reaped.
#[napi]
#[allow(clippy::too_many_arguments)]
pub fn pty_spawn(
    env: &Env,
    id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: Option<f64>,
    rows: Option<f64>,
    on_data: JsFunction,
    on_exit: JsFunction,
) -> Result<PtySpawnOutput> {
    let on_data_tsfn: ThreadsafeFunction<(String, String), ErrorStrategy::Fatal> = on_data
        .create_threadsafe_function(0, |ctx: ThreadSafeCallContext<(String, String)>| {
            Ok(vec![
                ctx.env.create_string(&ctx.value.0)?.into_unknown(),
                ctx.env.create_string(&ctx.value.1)?.into_unknown(),
            ])
        })?;
    let mut on_data_tsfn = on_data_tsfn;
    // Do not keep the Node event loop alive just because a PTY is open —
    // the sidecar must be able to exit naturally.
    on_data_tsfn.unref(env)?;

    let on_exit_tsfn: ThreadsafeFunction<(String, Option<i32>, Option<i32>), ErrorStrategy::Fatal> =
        on_exit
            .create_threadsafe_function(
                0,
                |ctx: ThreadSafeCallContext<(String, Option<i32>, Option<i32>)>| {
                    let id = ctx.env.create_string(&ctx.value.0)?.into_unknown();
                    let code = unknown_from_option_i32(&ctx.env, ctx.value.1)?;
                    let sig = unknown_from_option_i32(&ctx.env, ctx.value.2)?;
                    Ok(vec![id, code, sig])
                },
            )?;
    let mut on_exit_tsfn = on_exit_tsfn;
    on_exit_tsfn.unref(env)?;

    let opts = SpawnOptions {
        shell: command,
        args,
        cwd,
        cols: cols.map(|c| c as u16).unwrap_or(80),
        rows: rows.map(|r| r as u16).unwrap_or(24),
        pixel_width: 0,
        pixel_height: 0,
    };
    let info = manager()
        .spawn(&id, opts, Arc::new(NapiSink { on_data: on_data_tsfn, on_exit: on_exit_tsfn }))
        .map_err(napi::Error::from_reason)?;
    Ok(PtySpawnOutput {
        id: info.id,
        pid: info.pid.map(|p| p as f64),
    })
}

/// Write user input to the session PTY.
#[napi]
pub fn pty_write(id: String, data: String) -> Result<()> {
    manager()
        .write(&id, &data)
        .map_err(napi::Error::from_reason)
}

/// Resize the session PTY (cell size).
#[napi]
pub fn pty_resize(id: String, cols: f64, rows: f64) -> Result<()> {
    manager()
        .resize(&id, cols as u16, rows as u16, 0, 0)
        .map_err(napi::Error::from_reason)
}

/// Kill the session (console-aware process tree on Windows — grandchildren
/// reaped too, PID-reuse race-guarded by recorded start times).
#[napi]
pub fn pty_kill(id: String) -> Result<()> {
    manager().kill_session(&id);
    Ok(())
}

/// Kill every live session (sidecar shutdown).
#[napi]
pub fn pty_kill_all() -> Result<()> {
    manager().kill_all();
    Ok(())
}

/// Snapshot of live sessions.
#[napi]
pub fn pty_list() -> Vec<PtySessionOutput> {
    manager()
        .list()
        .into_iter()
        .map(|s| PtySessionOutput {
            id: s.id,
            shell: s.shell,
            cwd: s.cwd,
            pid: s.pid.map(|p| p as f64),
        })
        .collect()
}
