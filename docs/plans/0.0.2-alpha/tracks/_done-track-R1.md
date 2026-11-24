# Track R1 — DONE: PTY dùng chung + kill-tree chuẩn (Rust)

> Worker R1 thực thi 2026-11-22. Repo: `D:\GHITA AGENT`. Không commit/push — chỉ working tree.
> Tình trạng: **HOÀN THÀNH P1 + P2 + P3, mọi gate XANH** (có 1 fix cần thiết ngoài footprint lõi, ghi chú bên dưới).

## Disk guard (đầu phiên)

- `crates/target` = 3.3GB (> ngưỡng 3GB), D: còn 16.2GB free — guard trigger.
- Đã hỏi user → chọn "Clean rồi làm tiếp" → xoá `crates/target` (addon `*.node` nằm ngoài target, không mất gì). Sau clean: D: ~20GB free. Build lại từ đầu trong phiên (CARGO_BUILD_JOBS=1, RUST_MIN_STACK=134217728 theo đúng BUILD NOTE).

## P1 — Extract PTY core → `crates/pty` + thin adapter

### Tạo mới

- `crates/pty/Cargo.toml` — crate `ghita-pty` (member workspace `crates/`), features: `addon` (napi 2 compat-mode/napi4/dyn-symbols — cùng pattern `crates/sandbox`), deps: portable-pty 0.8, dashmap 6, windows-sys 0.59 (gnu), libc (unix, killpg).
- `crates/pty/src/lib.rs` — core PTY platform-agnostic: `PtyManager` (DashMap sessions + generation counter chống ghost reader), `spawn` (ConPTY qua portable-pty / posix openpty), `write` (lọc focus-event xterm.js), `resize` (cols/rows + pixel), `kill_session`/`kill_all`, `list`, `resolve_shell`, `default_cwd`, `is_filtered_input`; reader thread **drain** giữ nguyên các hardened fix (batch 8KB/16ms, giữ byte thô đến flush chống hỏng UTF-8 đa byte — audit 3.6, idle-log guard); output đẩy qua trait `PtyEventSink` (on_data/on_exit) thay vì Tauri emit.
- Tests chuyển theo từ terminal.rs: resolve_shell ×4, is_filtered_input ×3, default_cwd ×3, manager ×2, PTY spawn integration (PTY_RUST_OK) + thêm integration qua manager (spawn→write→drain→resize→kill, sink-based).

### Sửa

- `apps/desktop/src-tauri/src/terminal.rs` (721 → ~250 dòng): thin adapter giữ NGUYÊN contract `terminal_create/write/resize/kill/list` (tên + signature), giữ `TerminalManager` (new/kill_all — lib.rs không đổi dòng nào), `pub use ghita_pty::resolve_shell` cho `resolve_shell_for_platform` (lib.rs:1646); DTO serde giữ nguyên tên (`TerminalSessionInfo`, `TerminalDataPayload`, `TerminalExitPayload`); sink `TauriSink` implement `PtyEventSink` emit `terminal-data`/`terminal-exit`. **Frontend Terminal.tsx KHÔNG sửa** (contract `{id, exitCode}` còn giữ; thêm field `signal` backward-compatible).
- `apps/desktop/src-tauri/Cargo.toml`: path-dep `ghita-pty = { path = "../../../crates/pty" }`.
- `crates/Cargo.toml`: thêm member `"pty"`.

### Gate P1 — XANH (có blocker đã xử lý, xem "Fix cần thiết")

- `cargo test --workspace` (crates): **154/154 pass, 0 failed** (gồm ghita-pty 28).
- `cargo test` (src-tauri): **lib 50/50 + integration ipc_e2e 7/7, exit 0**.
- Smoke UI logic: contract `terminal_*` không đổi, Terminal.tsx untouched (git status xác nhận).

## P2 — Port pattern node-pty còn thiếu

- **Kill-tree console-aware** (`crates/pty/src/windows.rs`): FreeConsole → AttachConsole(child) → GetConsoleProcessList (buf 64, grow khi count > 64 — node-pty parity `conpty_console_list.cc`) → FreeConsole → restore console (ATTACH_PARENT_PROCESS nếu có console) → TerminateProcess từng pid (trừ self + direct child — child bị kill qua handle, miễn nhiễm PID-reuse). Chạy TRƯỚC khi ConPTY master đóng (bài học từ upstream fix-271faf3/revert-fae2ee9). Serialize bằng global Mutex (1 process 1 console tại 1 thời điểm).
- **Guard race PID-reuse bằng start-time** (2 lớp):
  1. _Attach guard_: ghi creation-time (FILETIME) của child NGAY SAU spawn (`GetProcessTimes` qua pid, window race siêu nhỏ); lúc kill, so với creation-time hiện tại của pid — lệch ⇒ pid đã bị tái sử dụng ⇒ **không attach**, fallback kill đơn lẻ.
  2. _Kill guard_: mỗi pid trong console list chỉ bị terminate khi creation-time ≤ `kill_started` (ghi trước khi attach); process sinh sau điểm bắt đầu kill (impostor reuse hoặc shell vừa spawn con mới) bị bỏ qua — phía an toàn của trade-off (console teardown vẫn dọn client còn lại).
- **Escape commandline chuẩn CommandLineToArgvW**: `args_to_commandline(program, args)` port từ node-pty `windowsPtyAgent.ts argsToCommandLine` (winpty origin): quote khi rỗng/chứa space-tab và chưa được quote đầy đủ; `bs*2+1` backslash trước quote trong arg; `bs*2` cho trailing backslash của arg quoted. Đã đối chiếu **battery expectation chính thức từ windowsPtyAgent.test.ts** (18 case: plain/quoted/multi-arg/real-world cmd /c powershell). Ghi chú parity: arg bắt đầu bằng `"` không round-trip qua CommandLineToArgvW thật (hành vi upstream, giữ nguyên).
- **Exit shape thống nhất `{exitCode, signal}`**: `PtyExitStatus { exit_code, signal }` trong core (Windows luôn signal=None — TerminateProcess ra exit code; portable-pty 0.8 không expose signal posix — documented limitation); `TerminalExitPayload` thêm field `signal` (frontend chỉ đọc exitCode → không phá contract).
- **Resize pixel**: core `resize(id, cols, rows, pixel_width, pixel_height)` truyền thẳng vào `PtySize` (Unix TIOCSWINSZ dùng được, Windows ConPTY bỏ qua — đúng behavior node-pty); Tauri command nhận thêm 2 optional param `pixel_width/pixel_height` (frontend chưa gửi → None → 0).
- **Tests mới**: `test_kill_session_reaps_process_tree` — kill-tree THẬT: spawn PTY cmd.exe, chạy sync cmd-copy tên unique (`ghita_pty_tree_<pid>_<time>.exe`) + ping 60s làm grandchild, xác nhận grandchild sống trước kill, sau `kill_session` grandchild biến mất (probe `tasklist` CSV); `test_kill_tree_attach_guard_rejects_wrong_start_time` — tamper start-time ⇒ attach bị chặn, child còn sống; unit guards (start-time stable, dead pid → None, now_filetime monotonic).

### Gate P2 — XANH

- `cargo test`: crates 154/154 (gồm kill-tree thật + race guard), src-tauri 50 lib + 7 integration.
- `cargo clippy -D warnings`: `ghita-pty` default ✓, `ghita-pty --features addon` ✓, src-tauri lib ✓.
- `cargo fmt --check`: ghita-pty ✓, src-tauri ✓ (sau khi apply).

## P3 — Napi addon + stream mode opt-in cho agent

- `crates/pty/src/napi.rs` (feature `addon`): `pty_spawn(id, command, args, cwd, cols, rows, onData, onExit)` — output stream qua `ThreadsafeFunction` (ErrorStrategy::Fatal, tuple → nhiều JS args; **unref ngay sau tạo** để không giữ Node event loop); `pty_write/pty_resize/pty_kill/pty_kill_all/pty_list`. Exit callback shape `(id, exitCode|null, signal|null)`.
- `crates/pty/package.json` (`@ghita/pty-native`, napi.name = "pty") — pattern sandbox.
- `scripts/build-native.mjs`: thêm `{ name: 'pty', dir: 'crates/pty', args: ['--features', 'addon'] }` vào ADDON_CRATES.
- `packages/native-bridge/src/pty-native.ts`: `tryLoadPtyNative()` qua `loadNative('pty', fallback)` → `{native, impl|null, reason}`; type `PtyNativeModule` cho surface addon; export qua `index.ts`. Tests mới `pty-native.test.ts` (3 tests: registered/missing/fail-safe + contract exit shape).
- `packages/ai-engine/src/tools/workspace-tools.ts`: **stream mode OPT-IN qua env `GHITA_AGENT_PTY_STREAM=1|true`** (env-based vì schema tool ở `tools/index.ts` — ngoài footprint): `runViaPty()` — spawn `cmd.exe /d /s /c <cmd>` (unix `/bin/sh -c`) qua addon, gộp output (PTY 1 stream), chunk streaming tới hook `globalThis.commandStreamHandler` (sidecar wiring sau — ngoài footprint), timeout → `ptyKill` (kill-tree) + note, grace window 10s chống treo, registry `globalThis.ghitaActivePtyKills` (parity `__activeChildProcs` cho abort); addon vắng/hỏng → `null` → **buffered cmd.exe fallback mặc định giữ nguyên**; approval flow (`approveCommandHandler` + `isDangerousCommand`) chạy TRƯỚC cả 2 path — giữ nguyên hành vi. Test mới `workspace-tools.pty-stream.test.ts` (5 tests: fake addon stream + hook, broken addon → fallback, default không flag → buffered dù addon có, approval chặn trước stream, **chạy addon THẬT đã build qua ConPTY**).
- Fix nhỏ TS: `Promise<string | null>` cho nhánh fallback.

### Gate P3 — XANH

- Build addon: `napi build --cwd "D:/GHITA AGENT/crates/pty" --platform --release --features addon` → **`crates/pty/pty.win32-x64-gnu.node` (1.88MB), exit 0** (build qua cùng lệnh mà build-native.mjs dùng; script root đã có `pnpm build:native` → file).
- JS fallback test: native-bridge 13/13 ✓; ai-engine suite **953/953** ✓ (gồm 5 test stream mode; case "addon vắng hoàn toàn" cover có điều kiện `isAddonBuilt` vì máy này đã build addon — contract loader được cover ở native-bridge test).
- `pnpm knip`: **exit 0** (chỉ 19 configuration hints có sẵn từ trước, không phải lỗi).
- Typecheck: ai-engine ✓, native-bridge ✓.
- Lưu ý pattern-consistency: `index.d.ts` do napi sinh ra rỗng (0 byte) — `crates/sandbox`, `crates/secscan` cũng 0 byte (native-bridge dùng interface tự viết) → không phải lệch.

## Fix cần thiết ngoài footprint lõi (đã record)

- `apps/desktop/src-tauri/.cargo/config.toml`: `/STACK:16777216` scope từ `cfg(target_os="windows")` → `cfg(all(target_os="windows", target_env="msvc"))`. **Lý do**: flag là MSVC-only (đúng như comment trong file), nhưng toolchain được `rust-toolchain.toml` pin (channel 1.99.0) trên máy này resolve sang `x86_64-pc-windows-gnu` (host default gnu, không có 1.99.0-msvc cài) → GNU ld chết IM LẶNG (`collect2: ld returned 1/5 exit status`) cho mọi unit crate-type bin trong src-tauri (build script của cả proc-macro2) ⇒ P1 gate không thể xanh. Fix giữ nguyên hành vi MSVC (CI windows runner vẫn áp flag), chỉ chặn áp sai toolchain. Không đụng `rust-toolchain.toml`/`Cargo.toml` root.

## File thay đổi (footprint)

- Create: `crates/pty/{Cargo.toml, package.json, src/lib.rs, src/windows.rs, src/napi.rs}` + addon output `crates/pty/pty.win32-x64-gnu.node`, `crates/pty/index.d.ts` (rỗng, pattern chung).
- Modify: `apps/desktop/src-tauri/src/terminal.rs`, `apps/desktop/src-tauri/Cargo.toml` (+Cargo.lock), `apps/desktop/src-tauri/.cargo/config.toml` (fix /STACK, xem trên), `crates/Cargo.toml` (+Cargo.lock), `scripts/build-native.mjs`, `packages/native-bridge/src/{index.ts, pty-native.ts, pty-native.test.ts}` (+dist rebuilt), `packages/ai-engine/src/tools/workspace-tools.ts` (+`workspace-tools.pty-stream.test.ts`).
- KHÔNG đụng: packages/agents, packages/evals, crates/sandbox, packages/ai-engine/src/cost|errors|registry, refer_project, file track/research, Terminal.tsx, main.rs/lib.rs (src-tauri) — git status các file đó là thay đổi của worker song song.

## Còn lại / khuyến nghị (không block track)

1. Sidecar chưa wire `GHITA_AGENT_PTY_STREAM` + `commandStreamHandler` vào `server.mjs` (ngoài footprint R1) — chỉ cần set env + đăng ký handler khi muốn stream tới UI.
2. Unix signal: portable-pty 0.8 không expose signal từ ExitStatus → `signal` luôn None trên Unix (Windows là platform chính). Nâng portable-pty 0.9+ nếu cần signal thật.
3. `test_commandline_roundtrip...` bị bỏ (thay bằng node-pty official suite) vì upstream argsToCommandLine không round-trip qua CommandLineToArgvW thật với arg chứa quote đầu dòng — parity đúng upstream.
4. Addon build cần `cargo` trong PATH khi gọi napi build thủ công (build-native.mjs chạy từ shell user có cargo thì OK).
5. Hai lần gặp `ld returned 5` tạm thời khi link bin app trong lần build đầu (AV/shield_ghita.exe can thiệp) — retry thành công; không phải code.
