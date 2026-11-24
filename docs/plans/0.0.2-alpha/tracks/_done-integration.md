# Integration Worker — DONE: wire `choose` vào sidecar + gates tổng hợp 0.0.2-alpha

> Worker: Integration (khâu cuối v0.0.2-alpha). Ngày: 2026-11-22. Working tree only — KHÔNG commit/push/tag.
> Nhiệm vụ: (1) wire tool `choose` của S3 vào sidecar (blocker P3 của S3), (2) fix 2 lint pre-existing của R1,
> (3) gates tổng hợp toàn repo xác nhận 6 track không xung đột chéo.

## Trạng thái: HOÀN THÀNH — toàn bộ gates XANH

| Gate                                                              | Kết quả                                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck` (turbo typecheck + quality:tests)                | **44/44 tasks PASS** + `tsc -p tsconfig.json --noEmit` clean (exit 0, chạy lại lần cuối trên cây cuối) |
| `pnpm lint` (turbo lint)                                          | **43/43 tasks PASS, 0 error** (exit 0, chạy lại lần cuối trên cây cuối)                                |
| `pnpm knip`                                                       | **exit 0** — chỉ 20 configuration hints pre-existing (giống baseline S3/S4)                            |
| `pnpm turbo test --force`                                         | **44/44 tasks PASS (exit 0)** — chi tiết per-package bên dưới                                          |
| `pnpm test:root` (root tests, chạy thêm cho đủ)                   | **45 file / 707 test PASS**                                                                            |
| `cargo test --workspace` (trong crates/, toolchain pinned 1.99.0) | **20 suite, 167 passed / 0 failed** (exit 0)                                                           |

Số liệu per-package vitest từ log turbo (tất cả PASS):

| Package                       | File / Test                                                                                                                                                          |     | Package          | File / Test                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---------------- | ----------------------------------- |
| a11y                          | 1 / 47                                                                                                                                                               |     | mobile-companion | 1 / 21                              |
| agents                        | 40 / 444                                                                                                                                                             |     | monitoring       | 3 / 24                              |
| ai-engine                     | 81 / 1054                                                                                                                                                            |     | native-bridge    | 4 / 13                              |
| browser-control               | 12 / 183                                                                                                                                                             |     | notification     | 2 / 16                              |
| code-graph                    | 10 / 69                                                                                                                                                              |     | quotas           | 2 / 18                              |
| communication                 | 14 / 165                                                                                                                                                             |     | relay-server     | 1 / 21                              |
| computer-use                  | 11 / 241 pass + 13 skip (dso-integration cần Docker)                                                                                                                 |     | resource-budget  | 1 / 7                               |
| desktop (vitest)              | 27 / 220                                                                                                                                                             |     | security         | 9 / 176 (gồm 19 hashcash)           |
| desktop (node --test sidecar) | 6 file — runtime-security, run-journal, memory-journal, crew-handlers, mcp-handlers, native-screenshot + **computer-use-bridge 10/10** + **choose-bridge 8/8 (mới)** |     | skills           | 25 / 357                            |
| evals                         | 4 / 14                                                                                                                                                               |     | terminal-session | 1 / 9                               |
| gui                           | 4 / 37                                                                                                                                                               |     | voice            | 3 / 27                              |
| i18n                          | 1 / 25                                                                                                                                                               |     | vscode-extension | 1 / 26                              |
| ingest                        | 6 / 151                                                                                                                                                              |     | shared, mobile   | task PASS (không in summary vitest) |
| integration                   | 1 / 22                                                                                                                                                               |     | mcp              | 2 / 15                              |
| marketplace                   | 4 / 33                                                                                                                                                               |     | memory           | 19 / 274                            |
| migration                     | 1 / 19                                                                                                                                                               |     |                  |                                     |

cargo per-crate: codegraph 16, docloader 6, engine 2, patch 27, **pty 28** (R1), **retrieval 43** (R2), **sandbox 21** (R2 — khớp "R2 21/21"), secscan 19, store 2, tokenizer 3 → tổng 167/0.

## 1. Wire `choose` vào sidecar (blocker P3 của S3) — XONG

Đọc `_done-track-S3.md` (P3: `chooseRequestHandler` / `resolveChoose`, wire-compatible `require_approval` /
`approve_command` / `reject_command`) và `_done-track-S4.md` (bridge pattern: whitelist, timeout, id-guard,
module riêng + `node --test` e2e) rồi wire đủ chuỗi **agent path → sidecar → desktop approval UI → resume**:

- **Mới** `apps/desktop/src-tauri/sidecar/choose-bridge.mjs` — `createChooseBridge({ emitToDesktop, log, getEngine })`:
  - `handleRequest(payload)`: whitelist payload (id ≤200 ký tự, question ≤2000, options 2-8 string ≤500,
    `allowCustom` strict boolean, field lạ bị strip) rồi emit `require_approval { id, command: question, options,
allowCustom }` **chỉ vào room `desktop`** (paired-devices không bao giờ thấy/trả lời prompt quyết định —
    cùng rule với command approval).
  - `approve(id, choice)` / `reject(id)`: gọi `resolveChoose` của engine (id-guard nằm ở ToolApprovalManager —
    id lạ/đã quyết/hết hạn → `false`, không crash, không "resurrect").
  - Timeout do engine sở hữu (60s deny-default, S3) — bridge KHÔNG thêm timer thứ hai để answer muộn không thể
    hồi sinh request đã quyết.
  - `getEngine()` trả về namespace `@ghita/ai-engine` **đã load sẵn** (deliberately không trigger lazy-load —
    choose request chỉ tồn tại khi engine đang chạy, quyết định cho engine chưa load là stale → bỏ qua an toàn).
- **Sửa** `apps/desktop/src-tauri/sidecar/server.mjs`:
  - Import + tạo singleton `chooseBridge` (getEngine đọc `_aiEngine` hiện có) + `chooseBridge.install()` —
    đặt `globalThis.chooseRequestHandler` theo đúng pattern global-handler S3.
  - Handler `approve_command`: thêm `chooseBridge.approve(id, data?.choice)` (UI chọn option gửi `choice`);
    handler `reject_command`: thêm `chooseBridge.reject(id)`. Command/file-write ids (`approve_*`, `fapprove_*`)
    không bị đụng — resolve chỉ dính khi id trùng pending choose (`tc_*`).
  - System prompt ReAct: thêm 1 dòng mô tả tool `choose` (tool đã nằm trong `orchestrator.builtInTools` từ S3
    nhưng model không biết tên/khả năng thì không bao giờ gọi).
- **Sửa (conflict chéo nhỏ, rõ ràng)** `apps/desktop/src/components/chat/useChatSocket.ts` — nút **Reject** của
  modal choose đang emit `reject { toolCallId }` (rơi vào handler pair device của sidecar và bị bỏ qua lặng lẽ,
  question chỉ chết ở timeout 60s); sửa để `choose` đi cùng vocabulary `reject_command { id }` như S3 đã thiết kế.
  Nút Approve không render cho choose (S3 ẩn sẵn) nên nhánh `approve { toolCallId }` không đổi.
- **E2E** `apps/desktop/src-tauri/sidecar/choose-bridge.test.mjs` (node --test, socket.io THẬT + engine THẬT từ
  dist `@ghita/ai-engine`): **8/8 PASS** — (1) e2e happy path agent gọi `executeChoose` → UI nhận
  `require_approval` kèm options → client emit `approve_command {id, choice}` → tool resume trả JSON
  `selected/selectedIndex` đúng; (2) reject → AgentError `code 'auth'`, `retryable false`, `provider 'choose'`;
  (3) plain approve không choice → default option đầu (tương thích Approve button); (4) `allowCustom` →
  customAnswer; (5) id-guard (id lạ, quyết 2 lần → false); (6) whitelist payload lỗi → không emit;
  (7) engine chưa load → quyết định bỏ qua an toàn; (8) unit sanitize (strip field lạ, coerce option).
- **Wire test vào CI** `apps/desktop/package.json` `test`: thêm
  `src-tauri/sidecar/computer-use-bridge.test.mjs` (note còn treo của S4) + `choose-bridge.test.mjs` —
  cả 18 test bridge đều PASS trong `turbo test` tổng.

Kết quả: **tool `choose` từ agent path hoạt động end-to-end** (unit S3 + e2e bridge thật 8/8 + chạy trong
turbo tổng). Lưu ý trung thực: e2e này phủ seam tool↔socket↔UI↔resolver↔resume không cần LLM live; "1 turn
agent thật với provider live" vẫn chưa chạy được trong môi trường này (đúng hạn chế S3 đã ghi, không thay đổi).

## 2. Lint fixes — XONG (3 cụm, không đụng logic)

- **2 lỗi `prefer-const` của R1** `packages/ai-engine/src/tools/workspace-tools.ts:500-501` (`killTimer`,
  `graceTimer` trong `runViaPty`) — gộp khai báo vào điểm gán duy nhất. _(Xem mục 4 — lần sửa đầu tạo TDZ,
  đã phát hiện qua gate và sửa lại bằng mảng `timers`.)_
- **1 lỗi `prefer-const` của R1** (phát hiện thêm khi chạy gate, cùng cụm PTY):
  `packages/native-bridge/src/pty-native.test.ts:39` (`exitArgs`) → `const`. Cản gate lint toàn repo.
- **8 lỗi `@typescript-eslint/no-non-null-assertion` của S4** `packages/security/src/hashcash.ts` (dòng 100
  `bytes[i]!` → `bytes[i] ?? 0`; dòng 169-175 `parts[n]!` → destructure kèm default `''` — an toàn vì đã guard
  `parts.length === 7`, default không bao giờ kích hoạt runtime). S4 gate không chạy lint security nên lọt.

## 3. Xung đột chéo / phát hiện qua gates tổng

Không có track nào sửa cùng file theo cách mâu thuẫn. Hai vấn đề phát hiện qua `turbo test --force`
(điều kiện tải song song mà gate per-track không gặp) — đều là lỗi nhỏ rõ ràng, đã sửa:

1. **`packages/agents/src/autogpt/store.ts` — EPERM khi rename graphs.json (Windows)**: test D3 của R2
   (2 store instance ghi đồng thời) flake/fail dưới tải song song — `fs.rename(tmp, graphs.json)` dính
   EPERM/EBUSY thoáng qua trên Windows khi instance khác/AV còn giữ handle đích, lỗi thoát ra khỏi
   `saveGraph` (trái intent "không crash, không mất graph" của test). Fix nhỏ: retry có giới hạn (5 lần,
   backoff 25ms tăng dần) cho các code transient EPERM/EBUSY/EACCES; lỗi thật (ENOENT tmp…) vẫn ném như cũ;
   semantics last-writer-wins giữ nguyên. Sau fix: agents **444/444** ổn định qua 1 run turbo nữa.
2. **TDZ do chính lần sửa prefer-const của tôi (trung thực):** fake PTY addon của R1 gọi `onExit` ĐỒNG BỘ
   trong `ptySpawn` → `finish()` chạy trước khi `const graceTimer` (cuối hàm) được khởi tạo → ReferenceError
   trong closure → bị catch → `runViaPty` resolve null → rơi buffered fallback → test R1
   `workspace-tools.pty-stream.test.ts` fail ('STDOUT:' prefix). Chỉ bộc lộ khi chạy full turbo song song.
   Fix: gom 2 timer vào mảng `timers` khai báo TRƯỚC `finish` (clear cả hai, catch path clear phần đã có —
   semantics giữ nguyên 100%). Sau fix: ai-engine **1054/1054**, run turbo tổng xanh.

## 4. Blocker / hạn chế còn lại (trung thực)

- `server.bundle.mjs` (sidecar đóng gói) là artifact gitignored — cần `pnpm build:sidecar` để bundle mới
  chứa `choose-bridge.mjs` vào bản build desktop thực tế (file nguồn đã `node --check` OK; bundle không phải
  input của gates).
- e2e "1 turn agent thật" với provider live vẫn không chạy được trong môi trường này (cần API key + UI chạy
  thật) — phần pause/resume choose đã phủ: unit S3 (8 test), e2e bridge thật 8/8 (socket.io thật + engine
  dist thật + client giả UI đúng wire), và toàn bộ glue sidecar đã `node --check` + review đối chiếu wire.
- Render `reasoning` delta riêng ở UI desktop vẫn như S3 ghi nhận (chưa trong footprint "nhỏ" của S3, không
  thuộc nhiệm vụ tích hợp này).
- `turbo.json` in warning "no output files found for task X#test" cho ~24 package — cosmetic pre-existing
  (thiếu key `outputs`), không ảnh hưởng kết quả.
- `cargo` không có trên PATH của shell này — đã chạy bằng `%USERPROFILE%\.cargo\bin\cargo.exe` (toolchain
  pin 1.99.0 qua rust-toolchain.toml, không đổi).

## Files footprint (integration)

- Mới: `apps/desktop/src-tauri/sidecar/choose-bridge.mjs` (+ `choose-bridge.test.mjs`)
- Sửa: `apps/desktop/src-tauri/sidecar/server.mjs`, `apps/desktop/src/components/chat/useChatSocket.ts`,
  `apps/desktop/package.json` (test script), `packages/ai-engine/src/tools/workspace-tools.ts`,
  `packages/native-bridge/src/pty-native.test.ts`, `packages/security/src/hashcash.ts`,
  `packages/agents/src/autogpt/store.ts`
- KHÔNG đụng: `refer_project/**`, không commit/push/tag/branch, không spawn subagent.
