# Nghiên cứu nền: desktop terminal + computer-use

> Subagent research 3 — READ-ONLY, 2026-11-22. Repo: `D:\GHITA AGENT`. Nền cho Track R1 (PTY Rust) + pattern computer-use.

## Kết luận nhanh (TL;DR)

- **PTY Rust đã có sẵn và đang chạy production** trong `apps/desktop/src-tauri/src/terminal.rs` (crate `portable-pty 0.8`, ConPTY trên Windows) — Track R1 KHÔNG cần viết PTY từ đầu, chỉ cân nhắc extract ra `crates/pty` + napi.
- **Terminal UI xterm.js đã có sẵn** (`apps/desktop/src/components/Terminal.tsx`) nối Tauri IPC qua 4 command + 2 event.
- **Agent chạy lệnh đi qua sidecar Node** (tool `run_command` — spawn buffered, KHÔNG PTY), không đi qua terminal UI.
- Hai Cargo workspace **rời nhau**: `crates/` (9 members) và `apps/desktop/src-tauri` độc lập; pattern napi chuẩn đã có ở `crates/sandbox` + `packages/native-bridge`.

---

## 1. apps/desktop

### (a) Terminal UI — ĐÃ CÓ

- `apps/desktop/src/components/Terminal.tsx` (514 dòng): xterm.js lazy-load qua dynamic import (`@xterm/xterm` ^6.0.0, `@xterm/addon-fit` ^0.10.0 — `apps/desktop/package.json:32-33`; loader Terminal.tsx:25-37).
  - `XtermPane` (Terminal.tsx:69-315): tạo PTY qua `invoke('terminal_create')` (:192-198), nghe event `terminal-data` (:210-214) + `terminal-exit` (:224-234), gửi input `terminal_write` (:244-248), resize `terminal_resize` (:251-255), kill khi unmount (:286-288). Multi-tab (:319-512), shell toggle cmd/PowerShell/bash/sh (:41-53, :350-365), low-RAM scrollback (:169), font prefs live (:93-104).
  - Mount point: `apps/desktop/src/layouts/MainLayout.tsx:392` (panel bottom, toggle `toggleTerminal`). Store: `terminalCwd`, `isTerminalOpen`, `terminalFontSize` — `apps/desktop/src/stores/appStore.ts:147-148, 293-296, 343`.
  - Tests: `apps/desktop/src/components/Terminal.test.tsx` + `Terminal.integration.test.ts`.
  - Comment kiến trúc chính thức: "Frontend (xterm.js) --Tauri IPC--> Rust PTY --> Shell" (Terminal.tsx:1-8).

### (b) Spawn shell — Rust PTY native (KHÔNG qua sidecar, KHÔNG node-pty)

- Rust: `apps/desktop/src-tauri/src/terminal.rs` (721 dòng), crate `portable-pty = "0.8"` + `dashmap = "6"` (`apps/desktop/src-tauri/Cargo.toml:39-40`). ConPTY Win10 1809+ / posix PTY (terminal.rs:2-6).
- `TerminalManager` (terminal.rs:73-129): DashMap session, generation counter chống ghost reader thread (:62-66, :278-282), kill deadlock fix Arc<Mutex<Child>> (:50-60). Reader thread buffer 8KB / 16ms flush, giữ byte thô tránh hỏng UTF-8 đa byte (:319-374, audit 3.6).
- Shell resolve: `resolve_shell` (terminal.rs:136-167) — Windows bash/sh/zsh fallback powershell.exe; cwd default USERPROFILE/HOME (:170-183).

### (c) Agent chạy lệnh đi qua đâu

- **Đường chính (sidecar Node)**: tool `run_command` — `packages/ai-engine/src/tools/workspace-tools.ts:457-553`: `spawn('cmd.exe', ['/d','/s','/c',cmd])` hoặc `/bin/sh -c` (:493-504), stdout/stderr BUFFERED (không PTY, không stream), timeout 1-300s + hard-kill taskkill /F /T (:506-517), registry `__activeChildProcs` để abort (:521-524). Approval: `globalThis.approveCommandHandler` (:478-487) → sidecar `server.mjs:285-305` emit `require_approval` qua socket.io tới desktop room (auto-reject 60s); consent bắt buộc cho run_command tại `server.mjs:2236`.
- **Đường UI/định kỳ**: Tauri command `execute_approved_command` (`lib.rs:505-606`) — native dialog approval (:537-548), blocklist `command_is_blocked` (`lib.rs:47-71`), tokio process CREATE_NO_WINDOW, gọi từ `apps/desktop/src/utils/shell.ts:170-204` (executeShellCommand) sau client-scan `assessShellCommand` (shell.ts:23-165, 20 regex CRITICAL/HIGH).
- Không thấy shell-open/plugin-shell — capability `args: true` đã bị xoá v0.6.0 (shell.ts:1-4).

### (d) Tauri commands (`lib.rs:1753-1808`)

- Server/sidecar: `start_server`, `stop_server`, `get_server_status`, `get_local_ips`, `check_update`, `get_session_token`.
- Shell: `execute_approved_command`.
- Computer-use: `computer_screenshot`, `computer_get_screen_size`, `computer_move_mouse`, `computer_click`, `computer_type_text`, `computer_press_key`, `computer_health_check`, `computer_window_move/focus/minimize/wait_for`.
- Terminal: `terminal_create`, `terminal_write`, `terminal_resize`, `terminal_kill`, `terminal_list`.
- FS: `fs_read_dir`, `fs_read_text`, `fs_write_text`, `fs_metadata`, `fs_mkdir`, `fs_remove`, `fs_rename`, `fs_request_access`, `fs_scope_list`.
- Proxy/API/misc: `start_proxy`, `stop_proxy`, `get_proxy_status`, `get_proxy_url`, `load_api_config`, `save_api_config`, `get_lan_enabled`, `set_lan_enabled`, `load_chat_sessions`, `save_chat_sessions`, `run_grill_session`, `diff::line_diff_stat_command`, `greet`, sandbox stubs (v2.0).

### (e) Rust sẵn có trong src-tauri

- `main.rs` (85 dòng): CLI `--headless`, panic hook + backtrace (:53-81), disable crashpad dev (:31-37).
- `lib.rs` (2039 dòng): `run()` builder (:1728), manage 5 state (ServerState, SecurityState, FsScopeState, ProxyState, ComputerUseState, TerminalManager — :1734-1752), cleanup_before_exit kill sidecar + proxy + PTY all (:1676-1701), kill-on-close Windows Job Object cho sidecar (:664-699), sidecar spawn node.exe có SHA-256 integrity check (:717-748, :902-914), headless auto-start server (:1705-1726).
- `terminal.rs` 721 dòng (trên); `computer_use.rs` 679 dòng (enigo/screenshots/window Win32 — :20-22); `proxy.rs` 982 dòng (local HTTP proxy cho API); `diff.rs` 172 dòng (LCS diff-stat).
- Sidecar dir `src-tauri/sidecar/`: node.exe bundle + `server.mjs`/`server.bundle.mjs` + crew/mcp/memory handlers + native-screenshot.mjs + runtime-security.mjs; test .mjs kèm theo.
- Rust tests: unit trong terminal.rs:537-720 (có integration spawn PTY thật :664-719), lib.rs:1986-2038 (fs-scope), `src-tauri/tests/ipc_e2e.rs`.

## 2. packages/computer-use

### (a) Hiện có gì

- **Grounding UI-TARS**: `src/uitars/bounding-box-detector.ts` (UITarsBoundingBoxDetector, 40 dòng); `src/vision/grounding.ts` GuiGrounder (82 dòng); `src/vision/analyzer.ts` VisionScreenshotAnalyzer (231 dòng — gọi vision model theo provider config, fallback gpt-4o/claude-3-5-sonnet, analyzer.ts:28-61).
- **Mouse/keyboard: KHÔNG native addon JS** — toàn bộ qua Rust Tauri: `src/operators/tauri.ts` (227 dòng) `TauriOperator` invoke `computer_*` qua `globalThis.__TAURI__.invoke` (:51-61, tránh hard-dep @tauri-apps/api); Rust dùng crate `enigo 0.2` (SendInput) + `screenshots 0.8` (GDI/DXGI ~10-30ms) — `src-tauri/src/computer_use.rs:20-22`, `Cargo.toml:33-34`. nut.js đã bị XÓA (node.ts:1-6).
- **Screenshot pipeline**: Rust capture → base64 PNG `{mimeType, data, size}` → DPI undo `undoDpiScale` (operators/utils.ts) → resize maxEdge Lanczos3 bằng image crate (tauri.ts:1-13).
- **ReAct loop**: `src/operators/reactLoop.ts` (408 dòng) `runReActLoop` — model adapter inject, max 25 iterations (:35), timeout 60s/iter, 5min/run (:36-37).
- Parser action: `src/actionParser.ts` (293 dòng) parse prediction UI-TARS (factor 1000, coords → px).
- Sandbox/guardrails: `src/sandbox/dsoOrchestrator.ts` (dockerode), `src/guardrails/` (sandboxFilter, securityLogger, configLoader), `src/scanner/headlessSearch.ts`.
- Mobile: `src/operators/mobile-adb.ts` (383 dòng) — Android qua `adb exec-out screencap`, execFile CREATE_NO_WINDOW.

### (b) Interface chính

- `ComputerUseAdapter` (src/index.ts:52-59): getScreenSize/moveMouse/click/typeText/pressKey/screenshot (tất cả optional).
- `ComputerUseController` (index.ts:97-289): wrap adapter, `executeActionText(prediction, size)` biến chuỗi UI-TARS thành click/type/hotkey (index.ts:179-288); `createComputerUseSkills` (index.ts:293-369) — 4 skills `computer.*` mặc định disabled, scopes ['desktop'].
- `Operator` interface (src/operators/types.ts:63) với kind `'tauri' | 'mobile-adb' | 'mock'` (:25); `createTauriAdapter()` (operators/tauri.ts:217-227); `isTauriAvailable()` (tauri.ts:65-80).
- Node entry `src/node.ts`: re-export TauriOperator + DSO/guardrails, `encodeCapture`.
- Consumers: sidecar lazy-load `server.mjs:45-51`, init Tauri adapter `server.mjs:1140-1152`, handler mobile_touch/mobile_type `server.mjs:2848-2920`; frontend nhận event `computer_use_step` (`apps/desktop/src/components/chat/useChatSocket.ts:461`); browser-control hybrid.ts.

### (c) Tests

- 10 file `packages/computer-use/tests/`: grounding.test.ts (verifyCoordinate/withActionRetry/annotateAction), operators.test.ts, mobile-adb.test.ts, dso.test.ts + dso-extended + dso-integration, sandbox-validation, security.test.ts + security-paths.security.test.ts, headlessSearch.test.ts, deny-default.test.ts. Config vitest riêng.

### (d) Lưu ý gap phát hiện

- `createTauriAdapter` trong sidecar Node yêu cầu `globalThis.__TAURI__` nhưng **không có chỗ nào inject** vào process node.exe (chỉ đọc tại `packages/computer-use/dist/operators/tauri.js:36`; grep toàn repo source không thấy gán). Thực tế sidecar luôn rơi vào catch `server.mjs:1149-1152` → `ComputerUseController()` rỗng → mobile_touch/computer skills từ sidecar sẽ fail "adapter is not available". Native thật chỉ hoạt động khi gọi từ WebView. Đây là điểm computer-use cần cầu nối (tương tự bài toán PTY cho agent).

## 3. Khoảng cách cho Track R1 (crates/pty + napi + Tauri command)

- **Tồn tại song song 2 Cargo workspace**: `crates/Cargo.toml` members = secscan, retrieval, codegraph, sandbox, tokenizer, docloader, store, patch, engine (không có pty); `apps/desktop/src-tauri/Cargo.toml` ĐỘC LẬP (Cargo.lock riêng, không thuộc workspace crates). Thêm `crates/pty` → để src-tauri dùng được cần path-dependency hoặc move code.
- **Điểm nối tự nhiên nhất**:
  1. Render stream: `Terminal.tsx` `XtermPane` đã tiêu thụ event `terminal-data`/`terminal-exit` + invoke 4 command — giữ nguyên contract `terminal_create/write/resize/kill/list` thì frontend KHÔNG phải sửa.
  2. Command spawn: `terminal_create` (terminal.rs:195-451) — extract body sang `crates/pty` (core PTY không phụ thuộc Tauri: openpty/spawn/reader/kill, trả callback/channel), src-tauri giữ thin wrapper command + state manager.
  3. Napi addon: chỉ cần nếu **agent (sidecar node.exe) muốn PTY thật** — vì sidecar không gọi được Tauri command. Pattern chuẩn đã có: `crates/sandbox` feature `addon` (napi 2, napi4, dyn-symbols — `crates/sandbox/Cargo.toml:13-21`) + loader `packages/native-bridge/src/index.ts` `loadNative(name)` resolve `crates/<name>/target/release/index.node` với JS fallback (index.ts:1-28). Nếu R1 muốn agent stream output qua PTY: thêm binding napi trong crates/pty + integrate qua native-bridge, thay/áo cho `run_command` (workspace-tools.ts:457, hiện buffered spawn).
  4. Lựa chọn rẻ hơn cho agent: sidecar emit stream qua socket.io tới desktop rồi Rust PTY phục vụ — nhưng phải thêm bridge sidecar↔Rust (hiện chỉ có IPC stdout `__GHITA_IPC__` một chiều `lib.rs:991-1015`, chưa có RPC ngược).
- **Có cần đụng sidecar không?** Terminal UI: KHÔNG (đi Tauri IPC thẳng). Agent stream PTY: CÓ (sidecar là process Node riêng — bắt buộc napi addon hoặc cầu RPC mới).

## 4. Sẵn có — tránh làm lại

- PTY Rust hoàn chỉnh + hardened: terminal.rs (generation guard, UTF-8 boundary, deadlock fix, idle log, unit + integration test) — reuse, đừng viết mới.
- xterm.js UI hoàn chỉnh + 2 test files; store wiring `terminalCwd` sync từ chat (`useChatSocket.ts:104,155-157`).
- `@ghita/terminal-session` (`packages/terminal-session/src/index.ts:1-13`): buffer serialize/restore (addon-serialize style), flow control XOFF/XON, resize pixel — sẵn cho restore session desktop/mobile.
- Security gates: `command_is_blocked` (lib.rs:47-71), `assessShellCommand` (shell.ts:23-165), fs-scope grant persist (lib.rs:77-254).
- Pattern napi + loader fallback: crates/sandbox + packages/native-bridge (đã build được addon `index.node`).
- Computer-use native Rust: computer_use.rs (screenshot/click/type/hotkey/window ops) + TauriOperator + ReAct + UI-TARS parser/grounding + 10 test files.
- Cleanup lifecycle PTY (kill_all khi exit — lib.rs:1698-1700) và kill-on-close Job Object — đã xử lý zombie.
