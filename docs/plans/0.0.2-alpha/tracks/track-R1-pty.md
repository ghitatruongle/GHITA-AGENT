# Track R1 — PTY dùng chung + kill-tree chuẩn (Rust)

> **Mục tiêu:** đưa PTY core về `crates/pty` dùng chung (src-tauri + napi cho sidecar), port các pattern ConPTY còn thiếu từ node-pty. Nguồn: `deep-dive/node-pty/02-*.md`, nền `_research-3-desktop-terminal.md`.

## Nền đã kiểm chứng (facts)

- **Terminal desktop đã có full-stack sẵn:** xterm.js UI (`apps/desktop/src/components/Terminal.tsx`, mount `MainLayout.tsx:392`) ↔ Tauri IPC (`terminal_create/write/resize/kill` + event `terminal-data/exit`) ↔ Rust `apps/desktop/src-tauri/src/terminal.rs` dùng **portable-pty 0.8** (ConPTY), đã hardened (UTF-8 boundary, ghost-thread guard, deadlock fix) + unit/integration test.
- Agent chạy lệnh KHÔNG qua PTY: tool `run_command` (`packages/ai-engine/src/tools/workspace-tools.ts:457-553`, sidecar Node) spawn `cmd.exe /d /s /c` **buffered** (không stream), approval qua socket.io.
- `crates/` và `src-tauri` là 2 Cargo workspace rời nhau — `crates/pty` cần path-depend từ src-tauri.
- Pattern napi chuẩn có sẵn: `crates/sandbox` + `packages/native-bridge` `loadNative`.

## Thiết kế

1. **Extract PTY core** từ `terminal.rs` → `crates/pty` (lib.rs: spawn/write/resize/kill/drain; Windows ConPTY + Unix). `terminal.rs` giữ role thin adapter giữ nguyên contract `terminal_*` — frontend không sửa.
2. **Port pattern còn thiếu** từ node-pty (terminal.rs hiện chưa có):
   - kill-tree console-aware (`FreeConsole→AttachConsole→GetConsoleProcessList`) + guard race PID-reuse (so start-time) — thay kill đơn lẻ.
   - escape commandline chuẩn `CommandLineToArgvW`.
   - resize pixel size (verify terminal.rs hiện chỉ COORD?).
   - exit thống nhất `{exitCode, signal}` (verify hiện trả gì).
     (2-phase init + drain: terminal.rs đã hardened — verify chéo pattern, không reimplement.)
3. **Napi addon `crates/pty/src/napi.rs`** cho sidecar: agent `run_command` stream thật qua PTY thay buffered cmd.exe (giữ approval flow hiện có qua `approveCommandHandler`).
4. Fallback JS: giữ `run_command` buffered hiện tại khi addon vắng.

## Files

- Create: `crates/pty/{Cargo.toml, package.json, src/lib.rs, src/windows.rs, src/napi.rs}`
- Modify: `apps/desktop/src-tauri/src/terminal.rs` (thin adapter), `apps/desktop/src-tauri/Cargo.toml` (path dep), `packages/native-bridge`, `scripts/build-native.mjs` (thêm target), `packages/ai-engine/src/tools/workspace-tools.ts` (stream mode opt-in)
- Frontend Terminal.tsx: KHÔNG sửa.

## Phases & Gates

- **P1** Extract crate + path-dep: cargo test workspace + tests terminal.rs chuyển theo; smoke UI terminal không đổi hành vi.
- **P2** Port kill-tree + escape + exit shape + tests mới (giết process tree thật, race guard).
- **P3** Napi addon + `run_command` stream mode opt-in + fallback test; knip xanh.
