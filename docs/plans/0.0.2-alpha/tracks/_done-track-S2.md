# Track S2 — DONE: ai-engine StandardRequest + AgentError + credential pool (TS)

> Worker: S2. Ngày: 2026-11-22. Repo: `D:\GHITA AGENT` — mọi thay đổi nằm ở **working tree**, KHÔNG commit/push/branch/tag.
> Clean-room: ds2api (AGPL) — chỉ dùng mô tả thiết kế, không đọc chuỗi code khi viết.

## Kết quả theo phase

### P1 — StandardRequest canonical layer (xong)

- **Create** `packages/ai-engine/src/standard-request.ts`:
  - Type canonical: `StandardRequest`, `StandardMessage`, `StandardToolCall`, `StandardToolDefinition`, `StandardToolChoice`, `StandardWireFormat` (`openai | anthropic | google | ollama`). Structurally identical với `ChatMessage` để helper cũ dùng lại không cần mapping (tránh sinh lớp message thứ 3 chồng chéo với `agents`).
  - `toStandardRequest(messages, options, config)` — builder canonical (kèm passthrough Ollama `format`/`think` → `responseFormat`/`reasoning`).
  - 4 wire renderer: `renderOpenAIChatRequest` (4 knob: `stream`/`samplingExtras`/`streamOptions`/`omitModel` phủ đúng mọi variant OpenAI-compat), `renderAnthropicMessagesRequest`, `renderGoogleGenerateContentRequest`, `renderOllamaChatRequest`.
  - `isNonEmptyChatContent` — chuẩn "empty" (no text + no toolCalls).
- **Modify** `providers/base.ts`: `wireFormat()` (mặc định `openai`) + `buildStandardRequest()` — entry chuẩn hoá trên BaseProvider.
- **Modify** `providers/openai.ts` (pilot): chat/stream build body qua canonical layer.
- **Parity tests** (`tests/standard-request.test.ts`): "old reference builders" clone đúng construction cũ + so sánh **JSON.stringify bytes chính xác** (key order included), 2 mức: renderer-vs-legacy và end-to-end qua `fetch` mock (OpenAIProvider chat + stream).

### P2 — Adapt 4 adapter + wire 3 vendor (xong)

- Adapt thêm: `providers/anthropic.ts` (wire `anthropic`), `providers/google.ts` (`google`), `providers/ollama.ts` (`ollama`, `buildRequestBody` giờ là thin wrapper), và các OpenAI-compat còn lại: `custom.ts` (giữ `stream_options.include_usage`), `base-extended.ts` (defineVendor — dùng chung cho xai/openrouter/together/perplexity/kimi/minimax/deepseek), `azure-openai.ts` (`omitModel` — deployment nằm trong URL), `groq.ts`, `mistral.ts`.
- **Modify** `registry.ts`: `kimi` → `KimiProvider`, `minimax` → `MiniMaxProvider` (trước đây rơi default throw `registry.ts:118`), `deepseek` → `DeepSeekProvider` (trước đây là shim `CustomProvider`). Unknown type vẫn throw như cũ.
- Tests: parity byte-exact cho từng variant (anthropic chat+stream, google, ollama incl. format/think, custom chat+stream, vendor chat+stream, azure chat) + end-to-end fetch-mock cho 7 provider + `tests/registry-wiring.test.ts` (5 test: 3 vendor dedicated, unknown throw, deepseek URL mặc định).

### P3 — AgentError + retry thang + credential pool (xong)

- **Modify** `errors/index.ts` (mở rộng hierarchy, KHÔNG thay thế): `AgentErrorCode` (11 code), `AgentErrorShape`, `AgentError extends AIBaseError` + `AgentError.from(error, provider?)` — canonicalize mọi error (idempotent, backfill provider; typed hierarchy trước, heuristic message/status sau; content_filter chặn trước auth).
- **Modify** `key-manager.ts`: tham số additive `getNextKey(exclude?: ReadonlySet<string>)` — hành vi cũ không đổi khi không truyền.
- **Modify** `providers/base.ts`: `switchKey(exclude?)` — chọn key khác healthy (KeyManager cooldown là nền).
- **Create** `src/credentials/key-gate.ts`: `KeyGate` — FIFO waiter + exclude-set + bounded wait (AITimeoutError) + `tryAcquire`/`release`/`abortAll`, hoạt động thuần qua public API của KeyManager (core không đụng).
- **Create** `src/orchestrator/retry-ladder.ts`: `runChatRetryLadder` + `createRetryLadderState` + `SYNTHETIC_FOLLOW_UP_PROMPT`:
  - empty (no text/no toolCalls, finish benign) → synthetic follow-up **max 1**;
  - 429 → switch-key **đúng 1 lần** (cap trong `state`, giữ nguyên qua các lần retry legacy);
  - empty + `finishReason:'error'` = content_filter → **không retry, không nudge** (throw AgentError non-retryable);
  - content_filter message → throw ngay;
  - generic error → rethrow nguyên vẹn cho legacy retry/fallback (giữ nguyên số call cũ).
- **Modify** `orchestrator/chat.ts`: non-stream chạy ladder **bên trong** `executeWithFallback` (tái cấu trúc sau khi phát hiện +1 call phá legacy call-count ở `tests/unit/orchestrator.test.ts`); stream: `isRetryableStreamError` loại thêm content_filter/refusal, hold empty done-chunk → 1 synthetic follow-up stream, đảm bảo **đúng 1 done chunk** tới consumer; 429 stream → switch-key tối đa 1 lần trước backoff.
- **Modify** `orchestrator.ts`: `executeWithFallback` truyền `isRetryable` (AgentError-based: content_filter/budget/auth/hard-4xx không retry; unknown/rate/timeout/network/server giữ retry như cũ).
- **Modify** `index.ts`: export public cho standard-request, KeyGate, retry-ladder (AgentError đã có sẵn qua `export *`).

## Gates (kết quả thực chạy)

| Gate                                        | Kết quả                                                                                                                                                                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vitest @ghita/ai-engine (direct)            | **78 files / 1016 tests PASS** (baseline trước S2: 75 files / 953 tests; +63 test mới) — gồm PTY stream tests của R1 giữ xanh                                                                                                     |
| `pnpm turbo test --filter=@ghita/ai-engine` | **8/8 tasks OK** (build deps + test), 1016 tests PASS                                                                                                                                                                             |
| typecheck `tsc --noEmit`                    | PASS                                                                                                                                                                                                                              |
| lint `eslint src/`                          | **S2 footprint files: 0 error**. Còn 2 error `prefer-const` tại `src/tools/workspace-tools.ts:500-501` — **có sẵn từ code R1** (working tree đã có 134 dòng đó trước khi S2 bắt đầu; file thuộc vùng cấm của S2, không đụng được) |
| `pnpm knip`                                 | **exit 0** (chỉ Configuration hints có sẵn của knip.json, không có unused exports/files/deps)                                                                                                                                     |

## Files

- Create: `packages/ai-engine/src/standard-request.ts`, `packages/ai-engine/src/credentials/key-gate.ts`, `packages/ai-engine/src/orchestrator/retry-ladder.ts`, `packages/ai-engine/tests/standard-request.test.ts`, `packages/ai-engine/tests/registry-wiring.test.ts`, `packages/ai-engine/tests/retry-ladder.test.ts`
- Modify: `packages/ai-engine/src/errors/index.ts`, `src/key-manager.ts`, `src/registry.ts`, `src/orchestrator.ts`, `src/orchestrator/chat.ts`, `src/index.ts`, `src/providers/base.ts`, `src/providers/{openai,anthropic,google,ollama,custom,base-extended,azure-openai,groq,mistral}.ts`
- KHÔNG đụng (đúng footprint): `crates/**`, `packages/security/**`, `packages/agents/**`, `packages/communication/**`, `apps/**`, `packages/shared/**`, `src/cost/middleware.ts`, `src/tools/**` (diff `workspace-tools.ts` là của worker R1, có sẵn trong working tree), KeyManager core, CostTracker/BudgetManager, EventStream.

## Quyết định thiết kế / lưu ý trung thực

1. **KeyGate = design component**: track ghi "chỉ thiết kế" cho pool upgrade → `KeyGate` (FIFO + exclude + bounded wait) implement + test đầy đủ và export, nhưng **chưa cắm vào đường request của provider**; đường switch-key thực tế dùng `KeyManager.getNextKey(exclude)` + cooldown (non-blocking) để tránh ngồi chờ cooldown 60s trong request. Cắm `KeyGate.acquire()` có wait vào sidecar/S3 là việc sau.
2. **Byte-parity-first**: những bất nhất của format cũ được giữ nguyên có chủ đích (guarded bởi test): OpenAI stream vẫn không gửi `top_p`/`stop`; Anthropic body vẫn không có `temperature`; Ollama vẫn passthrough `tools` raw. Muốn nâng sau thì sửa renderer + cập nhật baseline, không phải sửa từng provider.
3. **429 non-stream**: có switch-key → switch 1 lần → retry 1 lần → nếu vẫn fail thì **throw** (không fallback provider trong case này — tránh đập thêm vào key đang cooldown). Không có key thay thế (single-key) → giữ nguyên legacy retry+fallback. Không phải mọi nhánh 429 đều đi fallback provider — đã cân nhắc và chọn đúng 1 switch per request.
4. **Empty + finishReason 'error'** được phân loại content_filter (không nudge/không retry) vì các provider map `content_filter`/`refusal` về finishReason `error` kèm content rỗng.
5. **Stream empty**: hold empty done-chunk + follow-up 1 lần; consumer luôn nhận đúng 1 terminal chunk (fix bug double-done phát hiện bằng test trong quá trình làm).
6. **executeWithFallback isRetryable** giờ cũng chặn retry cho budget-exceeded (trước đây retry mọi thứ trừ auth/4xx) — cải thiện nhỏ, không có test cũ phụ thuộc.
7. **deepseek registry**: đổi sang dedicated class với baseUrl mặc định `https://api.deepseek.com/v1` (trước đây CustomProvider YÊU CẦU user cấu hình baseUrl). Case user tự cấu hình baseUrl riêng: vendor class hiện dùng `spec.chatUrl` cố định (hành vi defineVendor có sẵn, không thuộc phạm vi S2).
8. Lint còn 2 lỗi **pre-existing** ở `src/tools/workspace-tools.ts` (code R1) — cần R1/S3 tự xử lý, S2 không được đụng.

## Blocker

Không có blocker. Track hoàn thành P1→P3.
