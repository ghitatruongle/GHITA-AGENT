# Sandbox Windows (v0.0.2-preview T3)

**Hiện trạng:** Windows dùng tier `supervised` — spawn + Job Object containment
(kill-on-close, memory/process limits, sẵn có từ trước). `detect_enforcement`
napi + TS bridge (`tryDetectEnforcementNative`) báo tier thật.

**restricted-token (opt-in):** `Enforcement::RestrictedToken` + probe
`crates/sandbox/src/windows.rs::available()` — v1 trả FALSE có chủ đích: codex
sandbox thật cần provisioning (elevated setup) và 3 blocker upstream (tungstenite
fork, rama alpha pins, pty windows-GNU) — ghi ở doc comment của windows.rs.
Smoke 4 case đã chạy 14/11/2026 (docs/plans/2026-11-14-v0.0.2-preview-deep-integration.md
mục "Sandbox smoke results"): supervised KHÔNG chặn write-ngoài/network → theo
policy P3.5 không ship mặc định; opt-in flag `GHITA_SANDBOX=restricted-token`
chỉ có hiệu lực sau backlog R2.

**Backlog R2:** integrate `run_windows_sandbox_capture` của codex (provisioning
+ MSVC toolchain path), rồi smoke lại 4 case.
