//! Ghita Agent — Sandbox NAPI addon
//! napi surface behind the `addon` feature — loaded by @ghita/native-bridge
//! under the name `sandbox`. Mirrors the secscan/retrieval/codegraph addon
//! pattern (dyn-symbols, no libnode.dll at link time).
#![expect(dead_code)]

use crate::{spawn_sandboxed as spawn_core, SandboxOptions, SandboxProfile};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::time::Duration;

#[napi(object)]
pub struct SandboxOptionsInput {
    /// "workspace" | "read-only" | "strict" (default "workspace").
    pub profile: Option<String>,
    /// Working directory / write scope root (default: process cwd).
    pub workspace: Option<String>,
    /// Extra deny globs, e.g. ["**/*.pem", "**/.ssh/**"].
    pub deny_globs: Option<Vec<String>>,
    /// Extra environment variables to keep beyond the base allowlist.
    pub env_allow: Option<Vec<String>>,
    /// Hard timeout in milliseconds (default 120_000).
    pub timeout_ms: Option<f64>,
    /// Memory limit in MB per process tree (Windows Job Object Tier 2).
    pub memory_limit_mb: Option<u32>,
    /// Active process limit (max child processes in job).
    pub process_limit: Option<u32>,
    /// ReadOnly/Strict: commit overlay upper/ về workspace sau run thay vì
    /// rollback (default false — mọi write tương đối bị hủy).
    pub overlay_commit: Option<bool>,
    /// IO write budget (MB) cho process tree — vượt → kill + violation
    /// "io-budget" (Windows Job Object IO counters).
    pub io_write_limit_mb: Option<u32>,
}

#[napi(object)]
pub struct SandboxViolationOutput {
    pub reason: String,
    pub detail: String,
}

#[napi(object)]
pub struct SandboxRunOutput {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: f64,
    /// "landlock" | "seatbelt" | "supervised" — which tier actually enforced.
    pub enforcement: String,
    pub violations: Vec<SandboxViolationOutput>,
    /// True when policy blocked the spawn (command never ran).
    pub blocked: bool,
    /// Trạng thái cuối lifecycle: created | running | killing | killed |
    /// timed-out | completed | failed.
    pub state: Option<String>,
    /// Overlay session dir (ReadOnly/Strict) — relative writes của child đổ
    /// vào đây rồi được rollback (mặc định) hoặc commit.
    pub overlay_dir: Option<String>,
    /// True khi overlay được commit về workspace thay vì rollback.
    pub overlay_committed: Option<bool>,
}

/// Spawn a command inside the sandbox. Pre-exec policy violations block the
/// spawn (`blocked: true`); OS enforcement degrades gracefully per platform.
#[napi]
pub fn spawn_sandboxed(
    command: String,
    args: Vec<String>,
    options: Option<SandboxOptionsInput>,
) -> Result<SandboxRunOutput> {
    let input = options.unwrap_or(SandboxOptionsInput {
        profile: None,
        workspace: None,
        deny_globs: None,
        env_allow: None,
        timeout_ms: None,
        memory_limit_mb: None,
        process_limit: None,
        overlay_commit: None,
        io_write_limit_mb: None,
    });
    let profile = match input.profile.as_deref() {
        None => SandboxProfile::Workspace,
        Some(name) => SandboxProfile::parse(name).ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("unknown sandbox profile: {name} (workspace|read-only|strict)"),
            )
        })?,
    };
    let workspace = input
        .workspace
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
        });
    let mut opts = SandboxOptions::new(profile, workspace);
    opts.deny_globs = input.deny_globs.unwrap_or_default();
    opts.env_allow = input.env_allow.unwrap_or_default();
    // Guard: timeout_ms NaN/negative/0 cast sang u64 saturate về 0 →
    // Duration::from_millis(0) sẽ timeout-kill child NGAY LẬP TỨC. Giá trị
    // vô nghĩa → rơi về default 120s (đúng doc của timeout_ms).
    let timeout_ms = input.timeout_ms.unwrap_or(120_000.0);
    let timeout_ms = if timeout_ms.is_finite() && timeout_ms > 0.0 {
        timeout_ms
    } else {
        120_000.0
    };
    opts.timeout = Some(Duration::from_millis(timeout_ms as u64));
    // memory_limit_mb=0 → job memory limit 0 byte (mọi allocation fail) →
    // coi như không set. process_limit=0 → AssignProcessToJobObject luôn
    // fail (child tự thân đếm vào limit) → rơi về default 64.
    opts.memory_limit_mb = input.memory_limit_mb.filter(|&mb| mb > 0);
    opts.process_limit = Some(input.process_limit.filter(|&p| p > 0).unwrap_or(64));
    opts.overlay_commit = input.overlay_commit.unwrap_or(false);
    opts.io_write_limit_mb = input.io_write_limit_mb;

    let result = spawn_core(&command, &args, &opts)
        .map_err(|err| Error::new(Status::GenericFailure, err.to_string()))?;
    Ok(SandboxRunOutput {
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        duration_ms: result.duration_ms as f64,
        enforcement: result.enforcement.to_string(),
        violations: result
            .violations
            .into_iter()
            .map(|v| SandboxViolationOutput {
                reason: v.reason,
                detail: v.detail,
            })
            .collect(),
        blocked: result.blocked,
        state: Some(result.state.to_string()),
        overlay_dir: result.overlay_dir,
        overlay_committed: Some(result.overlay_committed),
    })
}

/// Which enforcement tier would be active right now (capability probe).
/// v1 Windows: "restricted-token" chỉ khi codex sandbox provisioned — hiện
/// probe trả false (backlog R2) nên Windows luôn báo "supervised".
#[napi]
pub fn detect_enforcement() -> String {
    crate::detect_enforcement().as_str().to_string()
}
