# Track R2 — DONE: Sandbox v2 (trait backend + overlay rollback + limits + wire consumer)

> Worker R2, 2026-11-22. Spec: `track-R2-sandbox.md`, nền: `_research-1-sandbox.md`.
> Working tree only — KHÔNG commit/push. Addon đã rebuild: `crates/sandbox/sandbox.win32-x64-gnu.node` (07:12, 0 warning).

## Kết quả tổng

| Phase                    | Gate                                                             | Trạng thái |
| ------------------------ | ---------------------------------------------------------------- | ---------- |
| P1 trait backend         | `cargo test -p ghita-sandbox` 8 test cũ xanh, behavior-identical | **DONE**   |
| P2 overlay rollback      | +7 test mới → 15/15                                              | **DONE**   |
| P3 limits + race + state | +6 test mới → 21/21, timeout-kill 504ms (trước: ~29s treo drain) | **DONE**   |
| P4 wire consumer         | security 157/157, agents 444/444 (gồm 4 test e2e mới)            | **DONE**   |
| Build native             | `napi build --release --features addon` OK, 0 warning            | **DONE**   |

## P1 — Trait backend (refactor thuần)

- **Create** `crates/sandbox/src/backend.rs`: trait `SandboxBackend` (`enforcement / prepare / pre_exec_hook / creation_flags / contain`) + trait `Containment` (`activate / poll / terminate_tree`) + `PreparedCommand`. Hợp đồng lỗi `SandboxError::{Recoverable, Terminal}` theo mẫu AgentEnv (deep-dive `agentenv/02`, `SandboxCaptureError` backend.rs:49-69/172): Recoverable = môi trường nguyên vẹn có thể retry; Terminal = containment mutate → caller phải kill child.
- **Modify** `lib.rs`: `spawn_sandboxed` monolithic (precheck → seatbelt wrap → env scrub → landlock pre_exec → spawn → job assign → poll) tách thành pipeline qua `SupervisedBackend`; precheck/policy giữ ở lib. Surface napi không đổi.
- Gate: 8 test cũ xanh, không đổi hành vi (verify bằng diff output-shape: `[sandbox:spawn]`, reason `spawn-failed`… giữ nguyên).

## P2 — Overlay-dir rollback

- **Create** `crates/sandbox/src/overlay.rs`: `OverlaySession` cho ReadOnly/Strict — session dir trong temp với `upper/` (cwd của child, mọi write tương đối đổ vào đây) + `upper/base` là junction (Windows `mklink /J`, không cần admin) / symlink (unix) về workspace để giữ đường đọc; TEMP/TMP/TMPDIR redirect vào `upper/temp`; env `GHITA_SANDBOX_OVERLAY`/`GHITA_SANDBOX_BASE` expose cho process. `rollback()` = `remove_dir_all(root)` (junction-safe, không đụng workspace); `commit()` = merge upper về workspace (skip junction `base`, cross-volume fallback copy).
- `SandboxOptions` + `overlay_commit: bool` (default false = rollback). `SandboxRunResult` + `overlay_dir`/`overlay_committed`.
- **Modify** `windows.rs`: doc comment `restrict_writes` cập nhật — 3 blocker upstream **verify lại vẫn còn** (grep workspace: không có codex/tungstenite/rama dependency nào) nên hàm vẫn no-op có chủ đích; write-containment path-level giờ là overlay rollback.
- Tests: 4 unit (no-overlay workspace, missing workspace lỗi, base-link đọc + commit merge, rollback giữ nguyên workspace) + 3 spawn-level (strict rollback sạch, commit promote, workspace không overlay).

## P3 — Limits + race + state machine

- **Create** `crates/sandbox/src/state.rs`: `SandboxState` 7 trạng thái + `Lifecycle` CAS `update_state_if_state` (mẫu AgentEnv). Pipeline wire: Created→Running→(Killing)→TimedOut/Killed/Completed/Failed; `SandboxRunResult.state` báo trạng thái cuối.
- **Race fix (job-gán-sau-spawn)**: Windows spawn dùng `CREATE_SUSPENDED` → `JobGuard::assign` khi process chưa chạy dòng nào → resume main thread (Toolhelp32Snapshot + OpenThread + ResumeThread trong `Containment::activate`). Cửa sổ escape v1 (lib.rs:784 cũ) bị xóa. Test hồi quy: `job_assigned_before_resume_child_completes`.
- **TTL auto-kill**: `JOB_OBJECT_LIMIT_JOB_TIME` + `per_job_user_time_limit` = timeout. ⚠️ **Phát hiện OS**: Windows 11 build 26300 từ chối CPU time limits qua `SetInformationJobObject` (ERROR_INVALID_PARAMETER cho cả JOB_TIME/PROCESS_TIME — verify bằng probe độc lập) → **best-effort + degrade có chủ đích**: khi OS từ chối, gỡ TTL flag và set lại limits còn lại (wall-clock poll + kill-on-close vẫn chặn runaway). Test đọc lại limits qua `QueryInformationJobObject` (class 9) — class 9 query hoạt động bình thường.
- **IO write budget** (`io_write_limit_mb`, token bucket không refill): ⚠️ **Phát hiện OS thứ hai**: job-level IO accounting (class 1 `BasicAccounting`, class 10 `BasicAndIoAccounting`) **bị remove trên build 26300** — trả ERROR_BAD_LENGTH cho mọi size (probe matrix 88/96/104 byte). Chuyển sang `GetProcessIoCounters` trên duplicated child handle (probe xác nhận: đếm đúng 64MB). Giới hạn ghi rõ trong code: budget áp cho direct process, write của tiến trình cháu không được tính. Vượt budget → `TerminateJobObject` + violation `io-budget`.
- **Tree-kill**: timeout/IO-kill dùng `TerminateJobObject` (mới thêm vào trait `Containment::terminate_tree`) thay vì `child.kill()` — tiến trình cháu kế thừa stdout/stderr pipe khiến `wait_with_output` drain tới khi cháu exit (test cũ treo ~29s; giờ 504ms).
- Contain thất bại (job assign/resume) giờ là `Terminal` → kill child (trước đây bỏ qua im lặng — với child suspended sẽ treo tới timeout).

## P4 — Wire consumer

- **Create** `packages/agents/src/blocks/sandbox-hook.ts`: `createRunInSandbox(options)` → hook `BlockContext.runInSandbox` chạy code qua `node -e` với `SandboxRunner` (profile default `strict`, denyGlobs = defaults ∪ policy, rollback overlay mặc định); `SandboxRunError` mang nguyên result; `onResult` cho audit. Export từ `packages/agents/src/index.ts` (+ `@ghita/security` dep trong package.json — tsconfig reference security đã có sẵn từ trước).
- **Modify** `packages/security/src/sandbox/runner.ts`: thêm `SandboxPolicyConfig` + `DEFAULT_SANDBOX_DENY_GLOBS` (`**/*.pem`, `**/*.key`, `**/.ssh/**`, `.env*`, `id_rsa*`, …) + `resolveSandboxPolicy()` (merge, dedupe, có thể tắt defaults); enforcement union += `'restricted-token'`; result += `state`/`overlayDir`/`overlayCommitted`; `SandboxRunnerOptions` += `overlayCommit`/`ioWriteLimitMb`.
- 🐛 **Bug v1 phát hiện khi wire**: napi-rs camelCase-hóa field của `#[napi(object)]` **cả hai chiều** — runner v1 truyền keys snake_case (`deny_globs`, `timeout_ms`, `env_allow`, `memory_limit_mb`, `process_limit`) nên **tất cả option đa từ bị addon bỏ qua âm thầm từ trước đến nay** (verify A/B: snake không chặn, camel chặn). Fix: runner truyền camelCase; chú thích tại interface `SandboxNative`.
- e2e (`packages/agents/tests/sandbox-hook.test.ts`, 4 test): strict profile + node ghi file cấm + overwrite file có sẵn → workspace sạch sau rollback, `overlayDir` có giá trị, `state=completed`; denyGlobs từ policy config chặn path arg trước spawn; `resolveSandboxPolicy` merge; GraphExecutor `code_sandbox` block end-to-end (graph có input node theo validation) → `nested/leak.txt` không tồn tại. Thiếu addon → skip trung thực (fallback-js không có overlay).

## Files

- Create: `crates/sandbox/src/{backend.rs, overlay.rs, state.rs}`, `packages/agents/src/blocks/sandbox-hook.ts`, `packages/agents/tests/sandbox-hook.test.ts`
- Modify: `crates/sandbox/src/{lib.rs, windows.rs, napi.rs}`, `packages/security/src/sandbox/{runner.ts, index.ts}`, `packages/security/src/index.ts`, `packages/agents/src/index.ts`, `packages/agents/package.json`, `pnpm-lock.yaml` (pnpm install cho dep mới)
- Binary (gitignored, rebuilt): `crates/sandbox/sandbox.win32-x64-gnu.node`
- Không đụng: crates/pty, apps/desktop, packages/ai-engine, packages/evals, scripts/build-native.mjs, packages/native-bridge (các thay đổi ở đó là của worker R1), src/harness/**.

## Blocker / giới hạn còn lại (không chặn track)

1. Job-level CPU TTL + job-level IO accounting bị Windows 11 build 26300 remove — đã degrade an toàn; trên build cũ hơn TTL flag sẽ set thật (test tự thích ứng).
2. IO budget mức direct-process (xem P3) — tree-wide cần job IO accounting quay lại hoặc minifilter.
3. Write bằng đường tuyệt đối ngoài workspace vẫn lọt qua overlay (đúng dự đoán research §6b) — chặn triệt để cần ACL/restricted-token thật, vẫn đứng sau 3 blocker upstream (doc windows.rs giữ làm boundary).
4. `crates/sandbox/index.d.ts` vẫn rỗng (0 byte) như cũ — TS type do consumer tự khai (runner.ts).
