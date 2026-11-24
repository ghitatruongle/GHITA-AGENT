# Nghiên cứu nền: ai-engine + communication + monitoring

> Subagent research cho Track S2 (StandardRequest/pool) và S3 (TokenTracker/StreamObject/choose).
> Chỉ đọc, không chạy build/test. Ngày: 2026-11-22. Path gốc: `packages/ai-engine`, `packages/communication`, `packages/monitoring`.

## 1. packages/ai-engine

### (a) Số provider

- Union `AIProviderType` có **58 loại** provider: `packages/shared/src/types.ts:5-59`.
- **12 class dedicated**: OpenAI, Anthropic, Google, Ollama, Custom, Groq, Mistral, XAI, OpenRouter, Together, Perplexity, AzureOpenAI (`packages/ai-engine/src/providers/index.ts:1-16`).
- **3 class via `defineVendor`** (composition trên BaseProvider): Kimi, MiniMax, DeepSeek (`providers/index.ts:18-21`, `providers/deepseek.ts:1-30`, `providers/base-extended.ts:24-33`). Lưu ý: 3 class này **không được registry dùng** — `registry.ts` map `deepseek` → CustomProvider (`src/registry.ts:100-117`) còn `kimi`/`minimax` rơi vào `default` throw (`registry.ts:118-119`).
- **15 loại OpenAI-compatible** map lại vào `CustomProvider` trong switch: opengateway, mimo, deepseek, hicap, github-models, cerebras, fireworks, cohere, replicate, voyage, ai21, sambanova, novita, opencode-zen, nvidia-nim (`registry.ts:96-117`).
- Thực tế chỉ có **4 wire format** phải adapt: OpenAI-compatible (openai/custom/vendor), Anthropic (`providers/anthropic.ts`), Google (`providers/google.ts`), Ollama (`providers/ollama.ts`).

### (b) Interface provider + request shape

- Interface `AIProvider` (`src/types.ts:12-43`): `isReady()`, `chat(messages, options) → ChatResponse`, `chatStream(messages, options) → AsyncGenerator<AIStreamChunk>`, `test()`, `embed`, `embedMany`, optional `generateImage/generateSpeech/generateVideo/transcribe`.
- Base class `BaseProvider` (`providers/base.ts:15-145`): giữ `config`, `KeyManager`, helper `getModel/getMaxTokens/getTemperature/getApiKey` (`base.ts:54-76`), `getCapabilities()` mặc định (`base.ts:132-144`). Không có method chuẩn hoá riêng — mỗi provider tự build request body.
- Request shape: `ChatMessage { role: user|assistant|system|tool, content, toolCallId?, toolCalls? }` + `ChatOptions { model, maxTokens, temperature, topP, stop, signal, agentRole, tools, toolChoice }` (`src/types.ts:60-79`). Response: `ChatResponse { content, model, provider, usage, finishReason, toolCalls? }` (`types.ts:81-89`).
- Orchestrator facade (`src/orchestrator.ts:63-494`) delegate sang `orchestrator/chat.ts`, `orchestrator/tool-calling.ts`, `orchestrator/embedding.ts`; resolve provider theo thứ tự: preferred → SmartRouter → agentRole routing → default → fallbackOrder → any (`orchestrator.ts:408-457`).

### (c) Streaming hiện tại

- Chunk shape `AIStreamChunk { content, done, provider?, model?, usage?, toolCalls? }` (`packages/shared/src/types.ts:79-91`). **Chỉ có text delta**; `toolCalls` chỉ emit 1 lần ở chunk `done:true` sau khi accumulate đủ arguments (`providers/anthropic.ts:155-163, 210-224`).
- **Không có reasoning delta riêng**: Anthropic bỏ qua thinking blocks; Ollama flatten `thinking` vào content dạng text (`providers/ollama.ts:129-138, 189-192`); DeepSeek/MiniMax/Perplexity chỉ flag `reasoningTokens: true` trong capabilities, không emit chunk riêng.
- Cách surface: caller nhận AsyncGenerator trực tiếp; orchestrator stream (`orchestrator/chat.ts:60-224`) yield chunk as-is + xử lý retry/fallback. Desktop sidecar consume rồi broadcast `chat_chunk` text-only tới mobile (`apps/desktop/src-tauri/sidecar/server.mjs:2776-2783`).
- Tồn tại song song module `EventStream` pub/sub có type hoá: `StreamEventType` gồm `message.start/delta/complete`, `tool.call/result/error`, `hook.pre/post`, `error`, `session.*`, `system.heartbeat` + ring buffer + rewind (`src/stream/types.ts:5-48`, `stream/event-stream.ts:58+`) — nhưng **Orchestrator hiện KHÔNG emit vào EventStream** (grep không thấy import ở `orchestrator.ts`); nó là bus standalone chưa nối vào run loop.

### (d) Error handling + retry/fallback

- Error classes (`src/errors/index.ts`): `AIBaseError` (`errors/index.ts:1-15`), `AIAPIError{provider,status}` (:17-28), `AIValidationError`, `AITimeoutError`, `AIRateLimitError`, `AIInvalidConfigError`, `AINoProviderError`, `AIToolCallRepairError`, `AIPermissionDeniedError`, `AISecurityGuardrailError` (:30-131).
- Stream retry: `maxAttempts` (mặc định 2) với backoff tuyến tính + jitter; `isRetryableStreamError` loại 400/401/403/404/422 + từ khoá auth (`orchestrator/chat.ts:14-20, 149-153`). Guard `everEmitted` chống replay prefix khi retry/fallback; nếu đã emit thì surface `finishReason:'error'` + `partialContent` rồi throw (`chat.ts:94-97, 137-146`). Fallback provider chỉ chạy khi chưa emit gì (`chat.ts:157-206`).
- Non-stream: `executeWithFallback` = retry primary → fallback 1 lần (`orchestrator.ts:475-493`).
- Hệ gateway/fallback khác: `FallbackManager` (SQLite better-sqlite3, cost records per session, budget.yaml, fallbackChain model-level, circuit breaker `modelUnhealthyUntil`, model timeouts) (`src/gateway/fallbackManager.ts:46-98`); ngoài ra còn nhiều lớp router chồng chéo: `loadbalancer/`, `router/` (unifiedRouter, fallback, adaptive), `routing/` (smart-router, router-v2, adaptive-router, model-catalog).

### (e) Credential/API key management

- `KeyManager` per-provider (`src/key-manager.ts:36-114`): multi-key, rotation `round-robin|failover|random` (`types.ts:98`); 429 → cooldown expo 60s*2^n (cap x4) (:101-104), 401 → deactivate (:105-107), 3 lỗi liên tiếp → cooldown 30s (:108-113).
- `SecureKeyLoader` (`src/utils/secure-key-loader.ts`): load từ env var map 7 provider (:8-16), cache in-memory, redact key pattern trong log/error (:22-31, 84-102). Key do user nhập qua UI lưu ở desktop config (ngoài phạm vi 3 package). **Không có rotation theo lịch/vault** — chỉ rotation per-request + cooldown lỗi.

## 2. packages/communication

- Transport chính: **Socket.IO server** (dep `socket.io ^4.8.3`, `packages/communication/package.json`) trong `src/server.ts` (942 dòng) — pairing code + auth token handshake, room `paired-devices` (`server.ts:609-631`). Song song có module **ws thuần**: `WsMultiplexer`/`WsChannel`/reconnect (`src/ws/multiplexer.ts`, `ws/channel.ts`, `ws/reconnect.ts`) với envelope `{ channel, type, payload, id, timestamp, replyTo? }` + QoS 0/1/2 + ACK (`ws/types.ts:13-38`, `ws/channel.ts:35-52`).
- Event constants `SOCKET_EVENTS` ở shared: pair/pair_confirm, command, chat, screenshot, status, approve/reject, require_approval, approve_command/reject_command, cost_telemetry, sync_language, file_change, mobile_touch/type/key, file_approval, chat_start (`packages/shared/src/constants.ts:106-141`).
- Message shape: `CommandPayload { action, params?, timestamp? }` (`communication/src/types.ts:28-33`); broadcast API: `broadcastChat/broadcastStatus/broadcast(event,data)/broadcastCostTelemetry/broadcastRequireApproval` (`server.ts:561-605`).
- Channel adapters (Telegram/Discord/Slack/WhatsApp/iMessage/telepresencePortal, `src/channels/`) theo contract `ChannelAdapter { id, sendMessage(channelId, text), onMessage, handleWebhook?, healthCheck? }` — **text-only, không streaming** (`src/channel-plugin-contract.ts:15-22`).
- Stream events: bản thân package communication **chưa có** event token/tool stream; streaming thực tế do desktop sidecar tự broadcast generic: `chat_start`/`chat_chunk` (delta text)/`chat_done` (usage + cost)/`chat_error` (`apps/desktop/src-tauri/sidecar/server.mjs:2743, 2778-2790, 2793-2817`).

## 3. packages/monitoring

Chỉ 6 module (10 file src), **KHÔNG có cost/token metrics**:

- `ErrorMonitor` (EventEmitter, capture unhandled) (`src/error-monitor.ts:43`), `ErrorGrouper` (fingerprint grouping) (`src/error-grouper.ts:10`), `SentryClient` (DSN transport opt-in) (`src/sentry-client.ts:55`), `Tracer` (span/transaction `ai.chat`…) (`src/performance-tracer.ts:21`), `AlertEngine` (rule threshold+window+cooldown) (`src/alert-rules.ts:10`), `UsageTelemetry` local-only, default `enabled:false`, category agent/skill/chat/file/terminal/browser/system (`src/telemetry.ts:3-31, 33+`).
- Cost/token tracking nằm ở **ai-engine**, không phải monitoring: `CostTracker` + bảng giá (`ai-engine/src/cost/tracker.ts:43-71`), `BudgetManager` limit + alert (`ai-engine/src/cost/budget.ts`, wire ở `orchestrator.ts:115-129`), cost middleware (`cost/middleware.ts:10-119`), `FallbackManager` SQLite cost records (`gateway/fallbackManager.ts:12-24`), `BatchCostTracker` (`batch/cost-tracker.ts:39+`), Prometheus exporter (`platform/prometheus.ts`).

## 4. Đánh giá khoảng cách so với S2/S3

### (a) StandardRequest canonical layer (N+M)

- Chạm: `ai-engine/src/types.ts` (định nghĩa `StandardRequest`), `providers/base.ts` (entry chuẩn hoá trên BaseProvider), `orchestrator/chat.ts` + `orchestrator.ts:217-229` (route qua canonical), `utils/middleware.ts` (chữ ký middleware `{messages, options}` sẽ mở rộng).
- Chỉ cần adapt **4 adapter wire-format** (openai-compat/anthropic/google/ollama); 15 loại CustomProvider + vendor dùng chung OpenAI adapter nên không phải sửa từng cái. Chuẩn hoá message đã có sẵn từng provider: `toOpenAIChatMessages`/`extractOpenAIToolCalls`/`OpenAIStreamToolAccumulator` (`providers/openai-tool-calling.ts`, import ở `custom.ts:6-11`), `toAnthropicMessages` (`anthropic.ts:103`).
- Cẩn thận: package `agents` có lớp message riêng (`agents/src/messages/message.js` — HumanMessage/AIMessage/…) → tránh sinh lớp canonical thứ 3 chồng chéo.

### (b) TokenUsageTracker AsyncLocalStorage

- **Chưa có AsyncLocalStorage nào** trong ai-engine/agents/monitoring (grep 0 kết quả).
- Hook điểm tự nhiên: (1) `cost/middleware.ts:59-112` — đã aggregate `finalUsage` + tự estimate len/4 khi provider không trả usage, trong `finally` của stream; (2) `orchestrator/chat.ts:104-120` — vòng for-await nơi usage từng chunk được gom; (3) run loop ReAct `agents/src/react/agent.ts` (llmCall) để gom per-run; sidecar đã gom per-chat (`server.mjs:2784-2806`). Shape `TokenUsage` đã có (`ai-engine/src/types.ts:91-95`); attribution per-session hiện chỉ ở FallbackManager SQLite.

### (c) StreamObject protocol 5 loại

- `AIStreamChunk` chưa có field `type` (`shared/src/types.ts:79-91`) → phải thêm enum (text/tool-call/reasoning/usage/error) + sửa 4 generator provider (anthropic phải emit `thinking` delta thay vì bỏ qua; ollama tách `thinking` khỏi content; openai parse reasoning nếu có).
- Engine side: có thể tái dùng `EventStream` (`stream/event-stream.ts`) làm bus chuẩn hoá — đã có type `tool.call/tool.result/error`; cần nối Orchestrator emit vào bus (hiện chưa nối).
- Communication side: thêm event `SOCKET_EVENTS` (vd `stream_event`) hoặc kênh riêng; envelope `WsChannelMessage` + QoS sẵn sàng làm transport (`ws/types.ts:13-38`); có sẵn `delta-batcher` để batch token (`agents/src/runtime/delta-batcher.ts`). Mobile hiện chỉ hiểu chat_chunk/chat_done — cần extend.

### (d) Tool `choose` human-in-the-loop

- Hook vào tool registry: đăng ký builtin mới trong `createBuiltInTools` (`ai-engine/src/tools/index.ts:34-175` — hiện 8 tool: web_search, web_fetch, list_dir, read_file, write_file, replace_file_content, grep_search, run_command; chưa có `choose`) hoặc qua `ToolRegistry.register` (`tools/registry.ts:84+`).
- **Hạ tầng HITL đã có gần đủ**: `ToolApprovalManager` request/approve/deny/`awaitDecision`(timeout 60s)/`decideAll`, deny-default (`ai-engine/src/tool-calling/approvals.ts:27-137`); `PermissionManager` (`security/permissions.ts`, wire `orchestrator.ts:113`); event approve qua mobile `REQUIRE_APPROVAL`/`APPROVE_COMMAND` (`communication/src/server.ts:602-605, 688-696`); sidecar emit `action_required` (`server.mjs:2726-2741`); ReAct có `ToolPolicyRequest` + pending actions confirmation (`agents/src/react/agent.ts:64-112`). `choose` chỉ cần: tạo pending approval + broadcast + `awaitDecision` rồi trả option user chọn về cho model.

## 5. Sẵn có — tránh làm lại

1. Chuẩn hoá message/tool-call per-provider: `openai-tool-calling.ts` (accumulator + extractor) — nền cho StandardRequest adapter.
2. Proxy middleware `wrapProvider`/`wrapLanguageModel` (`utils/middleware.ts:32, 280`) — chỗ cắm canonical layer + token tracker không cần sửa provider.
3. Retry/fallback stream có guard replay + partialContent (`orchestrator/chat.ts`) — đừng viết lại.
4. `KeyManager` rotation/cooldown + `SecureKeyLoader` redaction — giữ nguyên, StandardRequest chỉ đọc key qua `getApiKey()`.
5. `EventStream` + ring buffer + rewind + replay filter (`stream/`) — nền StreamObject protocol phía engine.
6. `ToolApprovalManager.awaitDecision` + events require_approval/approve_command — nền tool `choose`.
7. Cost middleware tự estimate token khi provider không trả usage (`cost/middleware.ts:85-95`) — tái dùng cho TokenUsageTracker.
8. `StreamingPipeline` hooks post-chunk batch 40ms (`hooks/streaming.ts:148-184`) + `delta-batcher` — đừng viết batcher mới.
9. `UsageTelemetry.trackTimed` + `Tracer` spans (`op: 'ai.chat'`) — gắn metric runtime vào đây thay vì tạo hệ metrics mới trong monitoring.
