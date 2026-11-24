# Track R2 — Sandbox v2: trait backend + rollback + limits (Rust)

> **Mục tiêu:** nâng crates/sandbox: tách backend qua trait, thêm rollback thật, hoàn thiện limits. Nguồn: `deep-dive/agentenv/02-*.md`, nền `_research-1-sandbox.md`.

## Nền đã kiểm chứng (facts)

- `crates/sandbox/src/lib.rs` (937 dòng): 3 profile Workspace/ReadOnly/Strict, 4 enforcement tier; `spawn_sandboxed` **monolithic** (precheck → env scrub → spawn → Job Object → timeout poll 25ms).
- `windows.rs:28-30`: no-op `Ok(())` — chặn path-level chờ provisioning codex sandbox (3 blocker upstream ghi trong doc comment); enforcement Windows thực tế = Job Object kill-on-close (`lib.rs` mod win_job 567-689, ACTIVE_PROCESS + optional memory limit).
- ⚠️ Race nhỏ hiện có: Job gán SAU spawn (quanh `lib.rs:784`) — process sống ngoài job trong khoảng nhỏ.
- Tests: 8 #[test] (profile/glob/env/precheck/spawn/enforcement-str); chưa phủ JobGuard limits, timeout-kill, seatbelt/landlock.
- **Chưa có consumer production**: chỉ `SandboxRunner` (`packages/security/src/sandbox/runner.ts`) gọi addon; packages/agents khai hook `runInSandbox` chưa wire; không ai set denyGlobs ngoài test.
- Napi expose `spawn_sandboxed` + `detect_enforcement`; loadNative('sandbox') quét `crates/sandbox/*.node`; `index.d.ts` rỗng.

## Thiết kế

1. **Trait `SandboxBackend`** (`backend.rs` mới): tách `spawn_sandboxed` monolithic thành các bước qua trait — policy/precheck giữ ở lib, enforcement đi backend; hợp đồng lỗi `Recoverable/Terminal` (mẫu AgentEnv `backend.rs:172,49-69`).
2. **State machine CAS**: lifecycle sandbox (Created→Running→Killing→Killed/Timeout...) với `update_state_if_state` chống race — đồng thời sửa race "job gán sau spawn" (gán job TRƯỚC khi kích hoạt resume).
3. **Overlay-dir rollback** (Windows): mọi write trong ReadOnly/Strict profile vào thư mục `upper/`; rollback = bỏ upper; commit = merge về base — thay cho no-op `windows.rs:28-30` (3 blocker upstream vẫn giữ làm boundary — kiểm tra lại tại P1).
4. **Job Object limits hoàn thiện**: TTL auto-kill + IO rate (token bucket) — struct fields đã khai sẵn, chỉ cần set flags + expiry index; kết hợp memory limit hiện có.
5. **Wire consumer thật**: nối `runInSandbox` (agents) → `SandboxRunner` → addon; cho phép set denyGlobs từ policy config (packages/security).

## Files

- Create: `crates/sandbox/src/{backend.rs, state.rs, overlay.rs}`
- Modify: `crates/sandbox/src/{lib.rs, windows.rs, napi.rs}` (mở rộng expose), `packages/security/src/sandbox/runner.ts`, `packages/agents` (wire runInSandbox)
- Tests mới: rollback restores, TTL kill, IO limit, state race, job-gán-trước-spawn.

## Phases & Gates

- **P1** Trait backend refactor thuần (không đổi hành vi) — cargo test hiện có 8 test phải vẫn xanh.
- **P2** Overlay rollback + tests rollback.
- **P3** Job Object TTL/IO + sửa race + tests race/limit.
- **P4** Wire consumer agents + denyGlobs config; e2e: agent chạy lệnh strict profile → rollback sạch.
