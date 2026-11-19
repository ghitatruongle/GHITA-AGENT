//! Windows restricted-token capability probe (v0.0.2-preview T3).
//!
//! v1 semantics: `available()` trả FALSE có chủ đích — codex sandbox thật
//! (ACL/restricted-token) chưa integrate được vì 3 blocker upstream đã ghi
//! nhận trong spike (`docs/t3-spike-*.log`):
//!
//! 1. tokio-tungstenite "proxy" feature chỉ có ở fork openai-oss-forks
//! 2. rama 0.3.0-alpha.4 family phải ghim nguyên bộ theo codex Cargo.lock
//! 3. codex-utils-pty không compile trên toolchain windows-GNU (chỉ MSVC)
//!
//! Full codex sandbox orchestration = backlog R2. Spawn hiện đi đường
//! supervised (Job Object containment) — hành vi cũ không đổi.

#![expect(dead_code)]

use std::path::PathBuf;

/// Capability probe — v1 luôn false (xem doc module). Khi backlog R2
/// hoàn thành (provisioning + MSVC path), hàm này hỏi preflight thật
/// của codex-windows-sandbox.
pub fn available() -> bool {
    false
}

/// v1: restrict_writes giữ no-op có chủ đích — chặn path-level thực sự cần
/// provisioning của codex sandbox (backlog R2). Spawn-level enforcement vẫn
/// là Job Object containment của đường supervised.
pub fn restrict_writes(_write_roots: &[PathBuf]) -> std::io::Result<()> {
    Ok(())
}
