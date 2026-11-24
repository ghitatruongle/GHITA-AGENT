# Track S2 — ai-engine: StandardRequest + AgentError + credential pool (TS)

> **Mục tiêu:** chuẩn hoá lớp request/error/credential của ai-engine. Nguồn: `deep-dive/ds2api/02-*.md` (clean-room — AGPL), nền `_research-2-ai-engine.md`.

## Nền đã kiểm chứng (facts)

- 58 `AIProviderType` nhưng chỉ **12 class dedicated + 3 defineVendor chưa wire** (Kimi/MiniMax/DeepSeek rơi default throw `registry.ts:118`); thực chất chỉ **4 wire format** phải adapt: OpenAI-compat / Anthropic / Google / Ollama.
- Interface `AIProvider` = chat/chatStream AsyncGenerator (`types.ts:12-43`); chunk chỉ text delta + toolCalls cuối — chưa có reasoning delta riêng.
- Error hierarchy đầy đủ (`errors/index.ts`) + retry/fallback có guard chống replay (`orchestrator/chat.ts:94-97`).
- Key: `KeyManager` rotation + cooldown 429/401 + `SecureKeyLoader` env + redaction — **đã tốt, giữ nguyên làm nền**.
- Đã có sẵn tránh làm lại: wrapProvider proxy middleware, openai-tool-calling accumulator, EventStream ring buffer + rewind (đang bỏ không), StreamingPipeline hooks batch 40ms, delta-batcher, deny-default approval flow.

## Thiết kế

1. **StandardRequest canonical layer**: chuẩn hoá message/tools/response về 1 shape; 4 adapter (OpenAI-compat/Anthropic/Google/Ollama) chỉ translate ↔ StandardRequest; Kimi/MiniMax/DeepSeek wire vào registry (sửa `registry.ts:118`).
2. **AgentError chuẩn hoá** về 1 shape duy nhất (mở rộng error hierarchy hiện có — không thay thế).
3. **Retry thang** (clean-room từ ds2api): empty → synthetic follow-up (max 1) · 429 → switch-key đúng 1 lần (KeyManager cooldown hiện có là nền) · content_filter không retry.
4. **Credential pool nâng cấp**: giữ KeyManager, thêm FIFO waiter + exclude-set khi switch (mẫu ds2api pool_acquire.go:49-92 — chỉ thiết kế).

## Files

- Create: `packages/ai-engine/src/standard-request.ts` (mới)
- Modify: 4 adapter wire format + `registry.ts` (wire 3 vendor chưa wire) + `errors/index.ts` (AgentError shape) + retry ladder trong orchestrator
- KHÔNG sửa: KeyManager core, CostTracker/BudgetManager, EventStream (thuộc S3).

## Phases & Gates

- **P1** StandardRequest type + adapt OpenAI-compat adapter (pilot) + tests parity.
- **P2** Adapt 3 adapter còn lại + wire 3 vendor vào registry + tests registry.
- **P3** AgentError + retry thang + FIFO waiter + exclude-set + tests.
- **Gates:** typecheck/lint/turbo test; test parity: cùng input → cùng request bytes theo format cũ (guard chống regress); knip xanh.
