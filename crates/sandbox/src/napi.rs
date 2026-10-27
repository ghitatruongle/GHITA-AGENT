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
    opts.timeout = Some(Duration::from_millis(
        input.timeout_ms.unwrap_or(120_000.0) as u64
    ));
    opts.memory_limit_mb = input.memory_limit_mb;
    opts.process_limit = input.process_limit.or(Some(64));

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
    })
}
