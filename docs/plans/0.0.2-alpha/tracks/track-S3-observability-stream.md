# Track S3 — TokenTracker + StreamObject + choose (TS)

> **Mục tiêu:** quan sát run + stream protocol + human-in-the-loop. Nguồn: `deep-dive/open-agent/01-02-*.md`, nền `_research-2-ai-engine.md`. Phụ thuộc nhẹ vào S2 (dùng AgentError/StandardRequest).

## Nền đã kiểm chứng (facts)

- **Chưa có AsyncLocalStorage nào trong repo** — TokenTracker là pattern hoàn toàn mới.
- Cost tracking nằm ở ai-engine (`cost/middleware.ts:59-112` — đã tự estimate token); monitoring KHÔNG có cost metrics.
- AIStreamChunk hiện chỉ text delta + toolCalls cuối; EventStream (ring buffer + rewind) đang **bỏ không** — nối vào là được.
- Tool approval đã có: `ToolApprovalManager.awaitDecision` + events require_approval/approve_command — choose chỉ là tái dùng.
- communication: Socket.IO + ws multiplexer (QoS/ACK); mobile nhận chat_start/chat_chunk/chat_done do sidecar broadcast — chưa có stream event protocol chuẩn.

## Thiết kế

1. **TokenUsageTracker**: AsyncLocalStorage per-run context, push/pop toolChain (`main_request` → `tool_call:<tool>`), bọc wrap async generator; hook tại `cost/middleware.ts:59-112` (nơi đã estimate token); expose cost report cuối turn → monitoring surface.
2. **StreamObject 5 loại**: thêm field `type` vào AIStreamChunk (text-delta/reasoning/tool-call/tool-result/tool-incomplete-result); sửa 4 generator; nối Orchestrator vào EventStream bus (đang bỏ không) — reasoning delta trở nên khả thi.
3. **Tool `choose`**: register vào `tools/index.ts`, tái dùng `ToolApprovalManager.awaitDecision` + events approval hiện có.
4. **Micro-batch Socket.IO**: batch 16 ký tự/10ms cho mobile chat_chunk (mẫu ds2api — clean-room).

## Files

- Create: `packages/ai-engine/src/token-tracker.ts` (mới), `packages/ai-engine/src/stream-protocol.ts` (mới)
- Modify: `packages/ai-engine/src/cost/middleware.ts`, `packages/ai-engine/src/tools/index.ts` (choose), `packages/communication` (StreamObject wire), `packages/monitoring` (cost surface), UI desktop (todo aggregation sau choose)
- KHÔNG sửa: CostTracker/BudgetManager core, StreamingPipeline hooks.

## Phases & Gates

- **P1** TokenTracker + hook middleware + cost report cuối turn + tests ALS nesting.
- **P2** StreamObject field `type` + sửa 4 generator + nối EventStream + tests protocol merge client-side.
- **P3** choose tool + tests approval flow; micro-batch mobile + tests timing.
- **Gates:** typecheck/lint/turbo test; knip; e2e smoke 1 turn agent: có cost report + reasoning delta + choose pause/resume.
