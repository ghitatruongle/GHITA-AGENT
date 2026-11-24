# Track S3 — DONE: TokenTracker + StreamObject + choose (P1→P3)

> Worker: S3 (track cuối 0.0.2-alpha). Ngày: 2026-11-22. Working tree only — KHÔNG commit/push/tag.
> Spec: `track-S3-observability-stream.md` — nền: `_research-2-ai-engine.md`.

## Trạng thái: HOÀN THÀNH (không blocker)

## P1 — TokenUsageTracker (AsyncLocalStorage)

- **Mới** `packages/ai-engine/src/token-tracker.ts`:
  - `TokenUsageTracker` trên `node:async_hooks` AsyncLocalStorage; `run(fn)` mở run scope, emit `RunCostReport` khi scope kết thúc (kể cả khi fn throw).
  - Tool chain push/pop: `main_request` → `tool_call:<tool>`; frame gốc pinned; `withToolScope(tool, fn)` tự pop trong `finally`.
  - `wrapAsyncGenerator(gen, opts)` — chunk passthrough, capture usage từng chunk, estimation len/4 khi provider không trả usage, chỉ record step khi consume đủ (giữ nguyên semantics `success` của cost middleware); `onFinalize` cho middleware cắm cost/budget/telemetry.
  - Nested run: context con isolated hoàn toàn; khi con thoát, tổng của con roll-up vào cha thành 1 step `provider: 'nested-run'` — không lộ context.
  - Report emit qua callback `onReport` + `globalThis.costReportHandler` (pattern như `broadcastCostTelemetryHandler` sẵn có).
- **Hook** `packages/ai-engine/src/cost/middleware.ts` (vùng 59-112): stream middleware dùng estimator chia sẻ `estimateUsageFromLength` (cùng công thức ceil(len/4) — không đổi hành vi), gọi `tokenUsageTracker.recordStep({usage, model, provider, costUsd, estimated})` ở nhánh `success`; chat middleware (non-stream) cũng record. Không đổi logic cost/budget/telemetry cũ.
- **Cost surface monitoring**: `packages/monitoring/src/cost-surface.ts` (mới) — `CostSurface` aggregate per-turn (tokens/cost/byModel/byTurn ring) + forward vào `UsageTelemetry` (`chat.cost`, local-only); `registerCostSurface()` set/unset `globalThis.costReportHandler`. Không thêm dependency mới (structural typing, không import ai-engine).
- **Tests** `packages/ai-engine/tests/token-tracker.test.ts` (15): ALS nesting (run lồng run không lộ context, child report trước parent), push/pop chain (root pinned, pop khi throw), wrapAsyncGenerator (usage/estimation/early-break), hook middleware qua `wrapProvider` thật (byChain đúng frame `tool_call:choose` vs `main_request`), AgentError contract.

## P2 — StreamObject 5 loại

- **Mới** `packages/ai-engine/src/stream-protocol.ts`: `streamObjectType` (classify legacy chunk — không `type` → text-delta / tool-call khi có toolCalls), builders (`textDelta`/`reasoningDelta`/`toolCallChunk`/`toolResultChunk`/`toolIncompleteResultChunk`), `mergeStreamObjects` (merge client-side: text + reasoning tách riêng, dedupe toolCalls theo id hoặc name+args, toolResults + incomplete flags), wire converters `streamObjectToWire`/`streamObjectFromWire` (`content` → `text` cho mobile).
- **Shared** `packages/shared/src/types.ts`: `AIStreamChunk` thêm `type?: StreamChunkType`, `toolCallId?`, `reason?` (additive only); union `StreamChunkType` 5 loại. `packages/shared/src/constants.ts`: thêm `CHAT_CHUNK/CHAT_DONE/CHAT_ERROR` (giá trị literal trùng với sidecar đang phát).
- **4 generator wire-format** (chỉ thêm field `type` + reasoning delta, không đụng logic S2):
  - `providers/openai.ts`: content → `text-delta`; parse mới `delta.reasoning_content` / `delta.reasoning` → chunk `reasoning` (trước đây bị bỏ qua); terminal chunk `tool-call` khi có toolCalls.
  - `providers/anthropic.ts`: `thinking_delta` (trước đây bị drop) → `reasoning`; text → `text-delta`; terminal như trên.
  - `providers/google.ts`: parts `thought: true` (Gemini thinking) tách thành `reasoning` thay vì flatten vào answer; còn lại `text-delta`.
  - `providers/ollama.ts`: `thinking` → `reasoning`, `content` → `text-delta`.
- **Nối Orchestrator → EventStream bus** (trước đây bỏ không): `orchestrator.ts` tạo `EventStream` (ring buffer + rewind có sẵn), expose `getEventStream()`; facade `chatStream` emit fire-and-forget `message.start` / `message.delta` (kèm `type` StreamObject — reasoning delta khả thi cho UI) / `message.complete` cho từng chunk. `orchestrator/chat.ts` (S2) KHÔNG đụng — emitting bọc ngoài facade. Export `EventStream` + types từ index.
- **Tests** `packages/ai-engine/tests/stream-protocol.test.ts` (15): vocabulary/classify/builders; merge client-side (dedupe, incomplete, done/usage); wire roundtrip; parity 4 generator qua SSE stub (mỗi generator đều gắn `type`, reasoning mới hoạt động); Orchestrator → EventStream (đúng 1 `message.start`, N delta, 1 `message.complete`, ring buffer chứa typed deltas). Kèm regression S2: `retry-ladder.test.ts` (33) + `provider-stream-tool-calling.test.ts` đều pass.

## P3 — Tool `choose` + micro-batch mobile

- **choose** trong `packages/ai-engine/src/tools/index.ts` (không tạo file mới, không đụng workspace-tools.ts):
  - Register `choose` vào `createBuiltInTools()` (schema: `question`, `options` 2-8, `allowCustom?`).
  - Tái dùng `ToolApprovalManager` (60s timeout, deny-default): `getChooseApprovalManager()`, `resolveChoose(id, approved, choice?)` — approve encode `decidedBy = 'choice:<text>'`; wire-compatible với events `require_approval`/`approve_command`/`reject_command` sẵn có.
  - Broadcast qua hook optional `globalThis.chooseRequestHandler` (host/sidecar cắm, cùng pattern global handler hiện có).
  - Kết quả: JSON `{ approved, question, options, selected, selectedIndex, customAnswer }`; plain approve không choice → default option đầu (tương thích desktop Approve button).
  - Error paths dùng **AgentError** (S2): invalid args → `code 'invalid_request'`; deny/timeout → `code 'auth'`, `retryable: false`, `provider: 'choose'`.
- **Micro-batch Socket.IO**: `packages/communication/src/chat-chunk-batcher.ts` (mới, clean-room) — flush khi đủ **16 ký tự** hoặc **10ms** (cái đến trước), dispose an toàn. `CommunicationServer`: `broadcastChatChunk(text)` (qua batcher), `broadcastStreamObject(obj)` (text-delta đi batcher; reasoning/tool-call/tool-result/tool-incomplete-result flush buffer trước rồi emit ngay để giữ thứ tự), `flushChatChunks()`; config mới `ServerConfig.chatChunkBatch.{maxChars,maxDelayMs}` (default 16/10); flush+recreate batcher trong `stop()`/`start()` (restart-safe). Export từ `communication/index.ts`.
- **UI desktop (nhỏ, todo/choose)**: `useChatSocket.ts` — `ToolApprovalRequest` thêm `chooseOptions` + kind `'choose'`; handler `require_approval` nhận payload có `options`; `handleChooseOption(option)` emit `approve_command { id, choice }` và aggregate quyết định vào chat history (message user `➡️ <option>`); `ChatToolApproval.tsx` render nút option thay parameters JSON khi choose (giữ Reject); `ChatPanel.tsx` wire prop mới.
- **Tests**: `packages/ai-engine/tests/choose-tool.test.ts` (8): registration, pause→broadcast→resolve, custom answer, plain-approve fallback, deny/timeout → AgentError auth, invalid args không broadcast. `packages/communication/tests/chat-chunk-batcher.test.ts` (12): char/time bound (fake timers), coalesce, flush/dispose, server surface với fake io (ordering text→structural, config bounds). `packages/monitoring/src/cost-surface.test.ts` (6): aggregate, byModel share, telemetry event, ring, reset, register/unregister.

## Files (S3 footprint)

- Create: `packages/ai-engine/src/token-tracker.ts`, `packages/ai-engine/src/stream-protocol.ts`, `packages/monitoring/src/cost-surface.ts`, `packages/communication/src/chat-chunk-batcher.ts`
- Create (tests): `packages/ai-engine/tests/token-tracker.test.ts`, `packages/ai-engine/tests/stream-protocol.test.ts`, `packages/ai-engine/tests/choose-tool.test.ts`, `packages/communication/tests/chat-chunk-batcher.test.ts`, `packages/monitoring/src/cost-surface.test.ts`
- Modify: `packages/ai-engine/src/cost/middleware.ts`, `packages/ai-engine/src/tools/index.ts`, `packages/ai-engine/src/index.ts`, `packages/ai-engine/src/orchestrator.ts` (EventStream wiring, additive), `packages/ai-engine/src/providers/{openai,anthropic,google,ollama}.ts` (chỉ thêm `type`/reasoning), `packages/shared/src/{types,constants}.ts` (additive), `packages/communication/src/{server,types,index}.ts`, `packages/monitoring/src/index.ts`, `apps/desktop/src/components/ChatPanel.tsx`, `apps/desktop/src/components/chat/{useChatSocket,ChatToolApproval}.tsx`
- KHÔNG đụng (đúng ràng buộc): `apps/desktop/server.mjs`, `apps/desktop/src-tauri/sidecar/server.mjs`, `packages/computer-use/**`, `packages/security/**`, `crates/**`, `src/tools/workspace-tools.ts`, `src/orchestrator/chat.ts`, CostTracker/BudgetManager core, StreamingPipeline hooks.

## Gates

| Gate                          | Kết quả                                                                                                                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vitest `@ghita/ai-engine`     | **81 file / 1054 test PASS** (baseline 78/1016 → +3 file, +38 test)                                                                                                                                                               |
| vitest `@ghita/communication` | **14 file / 165 test PASS** (baseline 13/153 → +12 test)                                                                                                                                                                          |
| vitest `@ghita/monitoring`    | **3 file / 24 test PASS** (baseline 2/18 → +6 test)                                                                                                                                                                               |
| typecheck                     | shared, ai-engine, communication, monitoring, apps/desktop — **clean**                                                                                                                                                            |
| lint                          | communication/monitoring/desktop clean; ai-engine còn đúng **2 lỗi pre-existing** của R1 trong `src/tools/workspace-tools.ts:500-501` (prefer-const, không thuộc footprint S3 — KHÔNG đụng); token-tracker tự fix `no-this-alias` |
| knip                          | **exit 0** (chỉ configuration hints pre-existing)                                                                                                                                                                                 |

Lưu ý: đã rebuild `packages/shared` dist (cần cho communication test đọc `SOCKET_EVENTS.CHAT_CHUNK` — dist là build artifact gitignored).

## Blocker / hạn chế trung thực

- **Không chạy được e2e smoke "1 turn agent" thật** (cần provider live + sidecar): phần pause/resume choose cần sidecar gọi `resolveChoose()`/`globalThis.chooseRequestHandler` — sidecar (`server.mjs`) nằm ngoài footprint S3 nên chưa wire. Đã phủ unit-level đầy đủ: cost report cuối turn (middleware + `costReportHandler`), reasoning delta (4 generator + EventStream), choose pause/resume (approval flow test). Wire sidecar là việc kế tiếp nhỏ (set `chooseRequestHandler` + broadcast require_approval kèm `options`).
- `mergeStreamObjects` hiện là helper client-side thuần; UI desktop chưa hiển thị riêng `reasoning` (chat_chunk reasoning vẫn đến mobile/UI nhưng render chỉ gộp text) — phần render UI reasoning chưa trong footprint "nhỏ" của S3.
- Lint `ai-engine` fail do 2 lỗi pre-existing của R1 (workspace-tools.ts) — ghi nhận cho worker R1/merge, không phải của S3.
