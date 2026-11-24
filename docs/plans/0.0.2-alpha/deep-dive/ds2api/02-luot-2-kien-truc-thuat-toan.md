# ds2api — Lượt 2: Kiến trúc & thuật toán

> **Dự án:** CJackHwang/ds2api v4.6.1 (Go, AGPL-3.0, ARCHIVED) · clone: `refer_project/ai-framework/ds2api`
> **Phương pháp:** 2 subagent đọc sâu song song 22/11/2026, chỉ đọc mã nguồn (không chạy code; AGPL → chỉ học thiết kế theo clean-room).

## Tóm tắt nhanh (tổng hợp)

- **Kiến trúc 3 tầng thực thi nghiêm ngặt:** surface adapters (`internal/httpapi/{openai,claude,gemini,ollama}`) chỉ parse/render; mọi business ở kernel `promptcompat` (StandardRequest `standard_request.go:5-26`) + `completionruntime` + `assistantturn`; ranh giới ràng buộc bằng AGENTS.md của repo. Luồng end-to-end 12 bước có trace file:line: route → auth/pool acquire → normalize → session/PoW/completion → SSE pump → tool sieve → delta chuẩn.
- **Abstraction:** `DeepSeekCaller` interface (nonstream.go:20-25), `FailureKind` taxonomy (client/errors.go:8), pool round-robin + waiter channel, retry empty-output/switch-account tập trung.
- **Thuật toán đáng học:** PoW SHA3-256 bỏ round 0, pre-absorb prefix 1 lần, hot-loop zero-alloc (stack buffers + so target 4×uint64, `pow/deepseek_pow.go:31-118`); SSE scanner 64KB → JSON-patch parser (workaround `</think>` split) → micro-batch 16 rune/10ms với 3 buffer (text/thinking/toolDetection) + timer stop-drain-reset; replay dedupe HasPrefix 2 chiều; pool rotate-on-acquire + FIFO waiter close-channel + cap per-account/global + exclude-set; retry thang: empty → synthetic follow-up (max 1), 429 → switch-account đúng 1 lần, content_filter không retry; auto-continue io.Pipe splice ≤8 round, nuốt `[DONE]` giữa stream; uTLS HelloSafari_Auto + ghi đè ALPN h1.1.
- **Test strategy đáng học:** fixture SSE chia sẻ Go↔Node, raw stream replay byte-level từ capture thật, sieve song song Go/Node, CI cross-build + line-gate 300 dòng.
- **Điểm yếu:** trùng lặp code Go/JS trên Vercel, `map[string]any` + handleStreamWithRetry ~15 tham số rời (mất type-safety), vòng phụ thuộc pool↔auth↔client khởi tạo muộn (router.go:50-54).

---

# ds2api — Subagent 1: Kiến trúc

Repo: `D:\GHITA AGENT\refer_project\ai-framework\ds2api` (CJackHwang/ds2api, Go 1.26, chi router, AGPL-3.0, ARCHIVED). 368 file `.go` (232 source + 136 test). Kiến trúc 3 tầng: **N protocol surface → 1 StandardRequest canonical → 1 completion path**.

## 1. Bản đồ module

| Thành phần       | Đường dẫn                                                                                                                      | Vai trò                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry            | `cmd/ds2api/`, `app/handler.go`, `api/index.go` (Vercel Go), `api/chat-stream.js` (Vercel Node)                                | Boot `server.NewApp()`                                                                                                                                                                        |
| Router/gateway   | `internal/server/router.go:44-131`                                                                                             | Wire App{Store, Pool, Resolver, DS}; routes `/v1/*`, `/models`, Claude/Gemini/Ollama, `/admin`, CORS (279-306), log redact (183-261)                                                          |
| Protocol surface | `internal/httpapi/{openai/{chat,responses,embeddings,files,history,shared}, claude, gemini, ollama, admin/*}`                  | Parse/render từng protocol; surface KHÔNG giữ business logic (ràng buộc trong `AGENTS.md` — "Protocol Adapter Boundary")                                                                      |
| Canonical kernel | `internal/promptcompat/`                                                                                                       | `StandardRequest` (standard_request.go:5-26), normalize từng surface (request_normalize.go:15, 60), build prompt (prompt_build.go:11-30), tool prompt, thinking injection, history transcript |
| Shared execution | `internal/completionruntime/`                                                                                                  | `StartCompletion` + retry non-stream (nonstream.go:50-192), retry stream (stream_retry.go:39-147)                                                                                             |
| Turn model       | `internal/assistantturn/`                                                                                                      | `Turn`, usage, `ShouldRetryEmptyOutput` (turn.go:227), `FinalizeTurn` (234) — ngôn ngữ trung gian của kết quả                                                                                 |
| Account pool     | `internal/account/`                                                                                                            | round-robin + waiter channel + inflight limits (pool_core.go:10-20, pool_acquire.go:15-47, pool_waiters.go)                                                                                   |
| Auth             | `internal/auth/request.go`                                                                                                     | Resolver caller-key vs account quản lý; refresh/switch token                                                                                                                                  |
| DeepSeek client  | `internal/deepseek/{client,protocol,transport}`                                                                                | Login/session/PoW/completion/upload; `protocol/constants_shared.json` chia sẻ header cho cả Go lẫn JS; transport fingerprint + fallback (transport.go)                                        |
| PoW              | `pow/deepseek_pow.go`                                                                                                          | Solver pure-Go DeepSeekHashV1 (Keccak, zero-alloc, SolvePow:27+)                                                                                                                              |
| SSE kernel       | `internal/sse/`                                                                                                                | Parser line/chunk (parser.go:71, line.go:21), pump (stream.go:35), collect (consumer.go:28), dedupe, citation, content-filter                                                                 |
| Stream engine    | `internal/stream/engine.go:45-139`                                                                                             | `ConsumeSSE` event-loop: keepalive, idle timeout, StopReason (11-20)                                                                                                                          |
| Tool             | `internal/toolcall/` (parse offline), `internal/toolstream/` (sieve streaming DSML/XML)                                        | Trích tool-call từ text thuần                                                                                                                                                                 |
| Mirror JS        | `internal/js/{chat-stream, helpers/stream-tool-sieve, shared}`                                                                 | Bản JS song song cho Vercel Node runtime                                                                                                                                                      |
| Hạ tầng phụ      | `internal/{config, chathistory, responsehistory, rawsample, devcapture, webui, textclean, util, translatorcliproxy}`, `webui/` | Config store, lịch sử chat, capture raw stream, admin UI React                                                                                                                                |

**Ranh giới surface vs kernel:** surface chỉ làm 2 việc — (a) decode request protocol → gọi `promptcompat.Normalize*` cho ra `StandardRequest`, (b) render `Turn` → protocol response. Mọi business (empty-retry, thinking, tool policy, usage, history, account switch) nằm ở `completionruntime` + `assistantturn` + client. Ví dụ: Claude surface tự normalize rồi ủy quyền cả handler qua `h.OpenAI.ChatCompletions` (`internal/httpapi/claude/handler_messages.go:188,213,218`); Gemini convert messages về dạng OpenAI (`internal/httpapi/gemini/convert_messages.go:13`).

## 2. Luồng end-to-end: POST /v1/chat/completions (stream)

1. **Route** — `internal/server/router.go:101` `r.Post("/v1/chat/completions", chatHandler.ChatCompletions)`; middleware CORS/UTF8/timeout (77-83).
2. **Gateway auth** — `internal/httpapi/openai/chat/handler_chat.go:40` `h.Auth.Determine(r)`; `internal/auth/request.go:57-79`: extract token từ Authorization Bearer / x-api-key / x-goog-api-key / query key (230-251). Key không nằm trong `Store.HasAPIKey` → dùng trực tiếp làm DeepSeek token (passthrough, 64-72). Key quản lý → `acquireManagedRequestAuth` (81-120): vòng lặp `Pool.AcquireWait` + `ensureManagedToken` (262-274: login nếu token rỗng, force-refresh theo interval). defer `Release` ở handler_chat.go:51-54.
3. **Parse** — decode JSON map + `MaxBytesReader` (58-67); upload inline file (68); `promptcompat.NormalizeOpenAIChatRequest` (72 → request_normalize.go:15-58): resolve alias model, resolve thinking/search theo model config, `BuildOpenAIPrompt` (prompt_build.go:19-30: normalize messages → inject tool prompt → `prompt.MessagesPrepareWithThinking`) → `StandardRequest{Surface:"openai_chat", FinalPrompt, ToolNames, ToolChoice, Stream, Thinking, Search, RefFileIDs, PassThrough}`.
4. **Account pool** — `internal/account/pool_acquire.go:15-47` `AcquireWait`: round-robin `tryAcquire` (66-81, bump queue 83-92) + waiter channel khi bão hòa (34-45); giới hạn `maxInflightPerAccount`, queue, global inflight (pool_core.go:36-81).
5. **Token/cookie** — `ensureManagedToken` + login qua `Resolver.Login` = `dsClient.Login` (router.go:51-53); token persist vào Store (request.go:152-161).
6. **Completion prep** — stream: `StartCompletion` (handler_chat.go:108 → completionruntime/nonstream.go:50-74): upload current-input file nếu có (76-86) → `ds.CreateSession` (client_auth.go:53-92, có refresh token + switch account trong retry loop) → `ds.GetPow` (client_auth.go:98-159: POST create_pow_challenge → `ComputePow` (client/pow.go:14) → `pow.SolvePow` (pow/deepseek_pow.go) → header base64 JSON) → `stdReq.CompletionPayload(sessionID)` (standard_request.go:63-92: prompt, model_type, thinking_enabled, search_enabled, ref_file_ids, passThrough) → `ds.CallCompletion`.
7. **Upstream call** — `internal/deepseek/client/client_completion.go:15-32`: header `x-ds-pow-response` (19), stream POST qua transport fingerprint với fallback std (42-72), wrap auto-continue khi 200 (28-30).
8. **SSE upstream → parse** — `internal/stream/engine.go:45` `ConsumeSSE` pump line qua `sse.StartParsedLinePump` (sse/stream.go:35) → `sse.ParseDeepSeekContentLine` (line.go:21) → parts text/thinking, content-filter, finish (parser.go:71).
9. **Tool sieve streaming** — `chat_stream_runtime.go:338` `toolstream.ProcessChunk(&s.toolSieve, p.RawText, toolNames)` (toolstream/tool_sieve_core.go:3+) tách DSML/XML tool-call khỏi text giữa dòng chảy; `Flush` khi kết thúc (252).
10. **Convert & emit chuẩn OpenAI** — `chat_stream_runtime.go:82` `newChatStreamRuntime` sinh delta `chat.completion.chunk`, keepalive, usage; hook `OnFinalize` ghi finish_reason (`stop`/`content_filter`) + archive history (handler_chat.go:262-276).
11. **Retry/429** — `ExecuteStreamWithRetry` (stream_retry.go:39-147): empty-output → clone payload + `parent_message_id` + PoW mới (111-116); quá số lần → switch account (77-97) rồi tạo session mới trên account khác.
12. **Cleanup** — defer auto-delete remote session theo mode single/all (handler_chat.go:124-155) + `Auth.Release` trả slot pool.

## 3. Abstraction then chốt

- **`promptcompat.StandardRequest`** (standard_request.go:5-26): hợp đồng duy nhất giữa surface và kernel; trường `Surface` giúp log/trace, `CompletionPayload()` (63-92) là điểm render cuối sang payload DeepSeek. Kèm `ToolChoicePolicy` (37-61: auto/none/required/forced + allowed-set).
- **`completionruntime.DeepSeekCaller` interface** (nonstream.go:20-25): 4 method (CreateSession/GetPow/UploadFile/CallCompletion) — client thật và test double cùng cắm vào; tách hoàn toàn kernel khỏi HTTP.
- **`assistantturn.Turn` + `FinalizeTurn`/`ShouldRetryEmptyOutput`** (turn.go:93, 227, 234): mô hình kết quả chuẩn hóa, dùng chung cho non-stream, stream,Responses; usage/OpenAIChatUsage render về từng surface.
- **Pool + waiter** (`account.Pool`): FIFO round-robin, bounded queue, waiter channel, exclude-set cho switch account; `auth.Resolver.SwitchAccount` (request.go:186-214) release + acquire nhảy account.
- **`FailureKind`** (deepseek/client/errors.go:8-46): phân loại lỗi `direct_unauthorized` vs `managed_unauthorized` để render đúng thông điệp cho caller passthrough vs caller dùng pool.
- **Stream engine** (`stream.ConsumeSSE` + hooks, engine.go:22-43): tách timer/keepalive/idle-timeout khỏi logic emit; `StopReason` enum 5 giá trị.

## 4. Test strategy đa giao thức

- **Shared fixtures Go ↔ Node**: `tests/compat/fixtures/sse_chunks/*.json` + `tests/compat/expected/sse_*.json` chạy song song trên Go (`internal/compat/go_compat_test.go:20` TestGoCompatSSEFixtures) và Node (`tests/node/js_compat_test.js:37`); cả hai đọc chung `internal/deepseek/protocol/constants_shared.json` (js_compat_test.js:23-29) để guarantee parity header/client-version.
- **Sieve song song Go/Node**: `internal/toolstream/tool_sieve_core.go` (Go) vs `internal/js/helpers/stream-tool-sieve/` (JS) cùng pass bộ edge case như nested fence, CDATA, fullwidth pipe, char-by-char (`internal/toolstream/complex_edge_test.go` 20+ test; `tests/node/stream-tool-sieve.test.js`).
- **Raw upstream replay byte-level**: `tests/raw_stream_samples/*/{meta.json, upstream.stream.sse}` capture thật từ DeepSeek qua `DS2API_DEV_PACKET_CAPTURE=1` (`internal/devcapture/store.go:77`, admin endpoint `internal/httpapi/admin/rawsamples/`, script `tests/scripts/capture-raw-stream-sample.sh`); replay bằng `tests/tools/deepseek-sse-simulator.mjs` với gate fail-on-leak / reference-leak / missing-finish / baseline-mismatch (scripts `run-raw-stream-sim.sh`, `compare-raw-stream-sample.sh`).
- **CI gates** (`.github/workflows/quality-gates.yml`): lint + **refactor line gate** (giới hạn 300 dòng Go / 500 dòng frontend / 120 dòng entry, `tests/scripts/check-refactor-line-gate.sh:4-7`), Go unit trên matrix macOS+Windows, `run-unit-all.sh` = Go + Node, WebUI build, **cross-build** toàn bộ GOOS/GOARCH release target (`tests/scripts/check-cross-build.sh`).
- **Vercel 2-runtime**: `vercel.json` rewrite `/v1/chat/completions` → `api/chat-stream.js` (Node) trừ khi có `?__go` → `api/index.go`. JS chỉ nhận stream trên Vercel (`internal/js/chat-stream/index.js:46-58`: non-Vercel/non-stream → `proxyToGo`); Go giữ quyền policy qua 4 endpoint nội bộ prepare/pow/switch/release có internal-token (`handler_chat.go:23-38`, `vercel_stream.go:15+`), JS tự stream tới DeepSeek và gọi Go lấy lease/PoW/switch (`vercel_stream_impl.js:53-109, 432-437`).

## 5. Đánh giá

**Điểm mạnh**

1. **Canonical model kỷ luật**: `AGENTS.md` cấm surface giữ business logic; mọi adapter đều chảy về `StandardRequest` + `Turn` → thêm protocol mới (Gemini, Ollama) chỉ cần parse + render, không chạm kernel; Gemini/Claude thậm chí ủy quyền handler OpenAI.
2. **Retry policy tập trung, có interface test được**: `DeepSeekCaller` + hooks (`StreamRetryHooks`) cho phép retry empty-output, refresh PoW, switch account được test không cần mạng; kernel SSE/parse/sieve đều pure-function với fixture byte-level.
3. **Parity Go/Node và chống regression thực tế**: shared JSON fixtures + shared constants + raw-sample replay bắt bug xuống mức byte; line-gate 300 dòng ép tách file, giữ codebase nhỏ file.

**Điểm yếu**

1. **Trùng lặp logic Go/JS**: `internal/js/` tái bản toàn bộ parse/SSE/tool-sieve/policy — mỗi thay đổi sieve hay error-shape phải sửa và giữ đồng bộ 2 codebase, chi phí bảo trì gấp đôi (chỉ có fixture chung làm an toàn).
2. **Pass-through map[string]any và field dư trong StandardRequest**: kernel nhận `Messages []any`, `ToolsRaw any`, `PassThrough map[string]any` thiếu type an toàn; `handler_chat.go:121` phải truyền ~15 tham số rời rạc vào `handleStreamWithRetry` (empty_retry_runtime.go:69) — dấu hiệu state chưa gói trọn, khó mở rộng tham số.
3. **Coupling pool↔auth↔client theo vòng**: `auth.Resolver` gọi `dsClient.Login` trong khi `dsclient.Client` giữ `Auth.Resolver` (router.go:50-54 khởi tạo vòng, phải gán muộn); client retry-loop gọi thẳng `Auth.RefreshToken/SwitchAccount` (client_auth.go:77-88) nên khó tách unit test tầng client, và pool ẩn trạng thái toàn cục (Reset drain waiter) khó kiểm soát khi config đổi nóng giữa chừng request.

---

# ds2api — Subagent 2: Thuật toán & kỹ thuật cốt lõi

> Repo: `D:\GHITA AGENT\refer_project\ai-framework\ds2api` (CJackHwang/ds2api, Go, AGPL-3.0, ARCHIVED).
> Tất cả path dưới đây tính từ gốc repo. Đọc sâu implementation, không chạy code.

---

## 1. PoW solver DeepSeekHashV1 (`pow/deepseek_pow.go`, `pow/deepseek_hash.go`)

**Cơ chế chính xác:**

- DeepSeekHashV1 = SHA3-256 nhưng **bỏ qua round 0 của Keccak-f[1600]**, chỉ chạy rounds 1..23 (`pow/deepseek_hash.go:1-3`, vòng `for r := 1; r < 24; r++` tại `deepseek_hash.go:25`). Round constants bảng rc[24] đầy đủ nhưng chỉ index 1..23 được XOR (`deepseek_hash.go:114`). Padding chuẩn SHA3: `0x06` + bit cuối `|0x80`, rate 136 (`deepseek_hash.go:140-141`, `deepseek_pow.go:89-90`).
- Challenge format: solver nhận `challenge` (64 hex chars = target hash), `salt`, `expire_at`, `difficulty` (`deepseek_pow.go:14-22`). Prefix = `"<salt>_<expire_at>_"` (`deepseek_pow.go:25-27`).
- **Pre-absorb prefix**: target hex decode thành 4 word uint64 LE (t0..t3) để so sánh trực tiếp (`deepseek_pow.go:39-44`); prefix absorb đầy đủ các block 136 byte vào `baseState [25]uint64` **một lần duy nhất** trước vòng lặp (`deepseek_pow.go:46-56`); phần đuôi (tail < 136 byte) giữ sẵn trong buffer (`deepseek_pow.go:57-59`).
- **Vòng lặp tìm nonce** `n ∈ [0, difficulty)` (`deepseek_pow.go:62-116`):
  - Chuyển `n` thành chuỗi decimal **thủ công trong buffer tĩnh 20 byte**, ghi từ cuối lên đầu (`deepseek_pow.go:70-82`) — không `strconv`.
  - Copy `baseState` vào stack `s`, XOR tail + số + padding (1 hoặc 2 block tùy tổng độ dài, `deepseek_pow.go:84-112`), chạy `keccakF23`, so sánh `s[0..3]` với t0..t3 (`deepseek_pow.go:113`) — match 32 byte đầu (SHA3-256 output).
  - **Zero-alloc**: mọi buffer là mảng cố định trên stack (`var buf [rate]byte`, `var numBuf [20]byte`), không có heap alloc nào trong hot loop; ctx.Err() check mỗi 1024 vòng (`n&0x3FF == 0`, `deepseek_pow.go:64-68`) để không burn CPU vô ích.
- Difficulty default 144000 nếu challenge không gửi (`deepseek_pow.go:138-141`); header trả về là base64(JSON `{algorithm,challenge,salt,answer,signature,target_path}`) **không chứa difficulty/expire_at** (`deepseek_pow.go:122-131`). Enforce algorithm name "DeepSeekHashV1" (`deepseek_pow.go:134-137`).

**Trick đáng chú ý:** so target bằng 4 phép so uint64 thay vì bytes.Equal; absorb-một-lần + tail-precompute nghĩa mỗi iteration chỉ tốn ~2 block XOR + 1-2 lần keccakF23. Độ phức tạp O(difficulty × keccakF23).

**Clean-room cho ai-engine:** cơ chế "pre-absorb prefix + fixed buffer + integer compare" áp dụng trực tiếp được cho bất kỳ PoW HMAC-style nào; bảng rc + bỏ round 0 là đặc thù DeepSeek (copy từ WASM decompile).

---

## 2. SSE engine (`internal/sse/stream.go`, `parser.go`, `internal/stream/engine.go`, `internal/deepseek/protocol/sse.go`)

**Kiến trúc 2 tầng + 1 consumer:**

1. **Byte-level scanner** (`protocol/sse.go:9-25`): `bufio.Reader` 64KB, `ReadBytes('\n')` thô, callback mỗi dòng — không parse `event:`/`id:` vì DeepSeek chỉ dùng `data:`.
2. **Parser** (`sse/parser.go:17-31`): trim prefix `data:`, `[DONE]` → stop; JSON unmarshal vào `map[string]any` generic (DeepSeek dùng JSON-patch path: `p`, `v`, `o` fields). `ParseSSEChunkForContentDetailed` (`parser.go:76-113`) xử lý:
   - Skip-path set + pattern (`shouldSkipPath`, `parser.go:33-69`) — gồm cả `response/fragments/<n>/status` numeric (`isFragmentStatusPath`).
   - Status path `response/status` = "FINISHED" → finished (`parser.go:85-92`).
   - Fragment type THINK/THINKING → "thinking", RESPONSE → "text" (`collectDirectFragments` `parser.go:142-174`, wrapped fragments `parser.go:287-316`).
   - **Bug-workaround `/think` split** (`splitThinkingParts` `parser.go:331-379`): DeepSeek API hay tiếp tục gửi `thinking_content` cả sau khi model xong suy nghĩ; regex `</think>` inside thinking content → mọi phần sau chuyển thành text, strip sạch `<think>` tags (`parser.go:382-386`).
3. **Micro-batch pump** (`sse/stream.go:35-362`): production config **MinChars 16 rune / MaxWait 10ms / FlushOnNewline / FlushOnFinish** (`stream.go:26-33`). Chi tiết:
   - 2 goroutine: scanner đẩy raw line vào `scanCh` (buffer 128) (`stream.go:59-84`); pump parse + accumulate.
   - 3 buffer strings.Builder: text / thinking / **toolDetectionThinking** (thinking dành riêng cho tool-sieve, không emit cho client khi thinking off) (`stream.go:51-56`).
   - Flush khi: force (stop/EOF/newline), lần đầu (`!anyFlushed` — giảm latency first token), ≥16 rune text, hoặc thinking>0 && text≥50 (`flushBuffer` `stream.go:130-190`).
   - **maxWait timer chuẩn Go**: `time.NewTimer(0)` + Stop/drain trước Reset để tránh race timer (`resetMaxWait`/`stopMaxWait` `stream.go:86-117`); timer fire → flush force (`stream.go:341-346`). Chỉ active khi có data pending (`stream.go:276-278`).
   - Chuyển type thinking→text phải flush buffer trước để không lẫn thứ tự (`stream.go:259-264`).
4. **Downstream consumer engine** (`stream/engine.go:45-139`): ConsumeSSE bọc pump với **keep-alive ticker** (`KeepAliveInterval`, claude ping 5s `protocol/constants.go:161`, `httpapi/claude/handler_routes.go:32`), **MaxKeepAliveNoInput** (40 tick không content → `StopReasonNoContentTimeout`, `engine.go:99-104`), **IdleTimeout** sau khi có content (`engine.go:105-107`), hooks OnParsed trả `ParsedDecision{Stop, StopReason, ContentSeen}` (`engine.go:38-43`).
5. **Replay dedupe** (`sse/dedupe.go:10-30`): continuation/snapshot replay của DeepSeek lặp lại prefix văn bản cũ; `TrimContinuationOverlap` so HasPrefix existing↔incoming (incoming ≥32 rune mới đáng so — `minContinuationSnapshotLen`), incoming chứa existing → cắt suffix, existing chứa incoming → drop "" — áp dụng ở cả stream-collect (`sse/consumer.go:70-82`) và non-stream accumulate (`completionruntime/nonstream.go:136-141`).

**Trick đáng chú ý:** toolDetectionThinking tách riêng để sieve thấy đủ markup ngay cả khi client tắt thinking; drain-remaining qua `scanDone` select-case (`stream.go:326-339`) đảm bảo không mất dòng cuối khi scanner thoát.

---

## 3. Account pool + waiter (`internal/account/pool_acquire.go`, `pool_core.go`, `pool_waiters.go`, `pool_limits.go`)

**Cơ chế chính xác:**

- **Round-robin thật bằng "rotate-on-acquire"**: `queue []string` account IDs; khi acquire ID nào, `bumpQueue` xóa ID khỏi vị trí hiện tại và append xuống cuối (`pool_acquire.go:83-92`) → lần acquire sau sẽ ưu tiên account khác, không cần counter.
- **Acquire** (`acquireLocked` `pool_acquire.go:49-64`): target-specific (header `X-Ds2-Target-Account`) bypass round-robin nhưng vẫn tôn trọng exclude + cap (`pool_acquire.go:50-61`); generic `tryAcquire` duyệt queue theo thứ tự, skip excluded/đầy cap (`pool_acquire.go:66-81`).
- **Caps 2 tầng** (`canAcquireIDLocked` `pool_limits.go:62-73`): per-account `inUse[id] >= maxInflightPerAccount` (default 2, `pool_core.go:23-26`) + global `currentInUseLocked() >= globalMaxInflight` (tổng = accounts × maxPer, `pool_limits.go:40-48`).
- **FIFO waiter** (`pool_waiters.go:18-25`): mỗi waiter là 1 `chan struct{}` append vào slice; `Release` chỉ **close(1) waiter đầu hàng** (`pool_core.go:83-100`) — wakeup đơn lẻ tránh thundering-herd; waiter dậy thì loop lại `AcquireWait` (`pool_acquire.go:20-46`) vì có thể bị người khác chớp mất slot.
- **Anti-leak**: ctx cancel → `removeWaiterLocked` xóa chính mình khỏi hàng (`pool_acquire.go:39-43`); `Reset`/`ApplyRuntimeLimits` drain toàn bộ waiter (`pool_waiters.go:38-43`, `pool_limits.go:22-29`).
- **Queue cap**: `canQueueLocked` giới hạn `len(waiters) < maxQueueSize` (default = recommended concurrency, `pool_limits.go:12-16`); target đã exclude hoặc không tồn tại → không cho xếp hàng (`pool_limits.go:3-11`).
- **Fairness khi Reset**: queue khởi tạo sort ổn định — account có token sẵn đứng trước (`pool_core.go:36-45`).

**Trick đáng chú ý:** dùng close-channel làm wakeup token (idempotent, không cần gửi giá trị); exclude-set truyền xuyên suốt từ caller nên waiter loop tự nhiên re-check.

---

## 4. Token lifecycle + retry ladder (`internal/auth/request.go:81-296`, `completionruntime/stream_retry.go`, `nonstream.go`)

**Lazy-login vs force-refresh:**

- `ensureManagedToken` (`request.go:262-274`): token rỗng → login ngay (lazy-login); token có sẵn → chỉ force-refresh nếu quá hạn `tokenRefreshedAt[accountID] + intervalHours` (`shouldForceRefresh` `request.go:276-296`). Lần gặp đầu tiên không có mark → ghi nhận now, **không** refresh (`request.go:290-293`) — tránh cold-start stampede. Sau login thành công: persist vào store + mark refreshed (`loginAndPersist` `request.go:152-161`).
- `MarkTokenInvalid` xoá token + clear mark + persist rỗng (`request.go:176-184`) — token chết sẽ lazy-login lại ở request sau.

**Failover chain acquire** (`acquireManagedRequestAuth` `request.go:81-120`): vòng lặp `AcquireWait(target, tried)`; ensure token fail → thêm ID vào `tried`, Release, thử account khác; target cụ thể fail → trả lỗi ngay không fallback (`request.go:113-115`); hết accounts (hoặc full exclude) → `ErrNoAccount` kèm `lastEnsureErr` ưu tiên (`request.go:85-97`).

**Switch-account** (`SwitchAccount` `request.go:186-214`): chặn khi target-specific (`request.go:190-192`); đưa account hiện tại vào `tried` + Release, rồi **non-blocking** `Acquire("", tried)` vòng cho tới khi có account mới pass ensure — exclude-set là cơ chế chống quay lại account cũ.

**Retry thang theo FailureKind** (stream path `ExecuteStreamWithRetry` `stream_retry.go:39-147`; non-stream `nonstream.go:96-192`):

- **FailureKind mapping** (`assistantturn/turn.go:213-222` `UpstreamEmptyOutputDetail`): content_filter → **400** (không retry, `ShouldRetryEmptyOutput` loại ở `turn.go:227-232`); có thinking mà không text (rate-limit/empty) → **429**; trống hoàn toàn → **503**.
- **Thang 1 — synthetic empty-retry** (attempts < RetryMax, default 1 `shared/empty_retry.go:11-13`): clone payload + append suffix _"Previous reply had no visible output..."_ vào prompt + set `parent_message_id` = message ID vừa nhận để retry thành turn kế tiếp trong cùng session (`shared/empty_retry.go:23-34`; gọi tại `stream_retry.go:116`, `nonstream.go:184`); PoW lấy mới, fail thì fallback PoW cũ (`stream_retry.go:111-115`); usage prompt ghi nhận đệm suffix cho đếm token (`UsagePromptWithEmptyOutputRetry` `empty_retry.go:44-56`).
- **Thang 2 — switch-account**: chỉ khi `attempts >= retryMax` và **chỉ 1 lần** (`accountSwitchAttempted` flag, `stream_retry.go:57-61,76`); trigger duy nhất là **429** (`canRetryOnAlternateAccount` `nonstream.go:194-206`). Switch xong phải **tạo session mới + PoW mới + xoá `parent_message_id`** (session mới không có parent, `stream_retry.go:149-173`, delete tại dòng 167); file upload hiện tại phải re-upload cho account mới (`stream_retry.go:159-165`, `nonstream.go:230-240`).
- Lỗi PoW/login failover: `GetPow` fail → 401 "Failed to get PoW (invalid token...)" (`nonstream.go:66`); CreateSession fail → 401 kèm hướng dẫn re-login (`authOutputError` `nonstream.go:273-278`).

**Trick đáng chú ý:** retry "synthetic" biến lỗi trống thành turn follow-up thay vì gọi lại từ đầu — giữ context DeepSeek; flag one-shot switch tránh vòng lặp account switch vô hạn.

---

## 5. Auto-continue stream splice (`internal/deepseek/client/client_continue.go`)

**Cơ chế chính xác:**

- Wrap body của completion response bằng `io.Pipe`: caller đọc `pr`, goroutine `pumpAutoContinue` đẩy dữ liệu (`client_continue.go:82-92`).
- **Pump loop** (`client_continue.go:97-129`): đọc từng body qua `streamBodyWithContinueState`; nếu state báo cắt (`shouldContinue`) và `rounds < defaultAutoContinueLimit = 8` (`client_continue.go:19`) → gọi endpoint continue `{chat_session_id, message_id, fallback_to_resume:true}` (`client_continue.go:59-63`), splice body mới vào cùng pipe, `prepareForNextRound` reset status/finished nhưng **giữ responseMessageID** (`client_continue.go:307-313`).
- **Mid-stream `[DONE]` swallowing** (`streamBodyWithContinueState` `client_continue.go:135-181`): mọi `data: [DONE]` ở giữa (DeepSeek kết thúc round continue bằng [DONE] riêng) bị **nuốt**, chỉ emit đúng 1 `[DONE]` cuối cùng nếu round cuối có (`client_continue.go:122-126`) — caller thấy 1 stream liền mạch.
- **Phát hiện cắt giữa chừng** (`continueState.observe*` `client_continue.go:184-286`): parse từng JSON chunk, bắt `response_message_id` từ 3 vị trí (top-level, `v.response.message_id`, `message.response.message_id`), status từ direct patch (`p == "response/status"`), batch patches (`p == "response"` + mảng v), và wrapped object. `shouldContinue` (`client_continue.go:290-303`): chỉ trigger với status **INCOMPLETE / AUTO_CONTINUE** (auto_continue=true → set status "AUTO_CONTINUE"); **WIP không đủ** vì stream bình thường khởi đầu là WIP; không continue nếu đã FINISHED/CONTENT_FILTER hoặc thiếu message_id.
- Continue request tái dùng đúng PoW header của completion gốc (`client_continue.go:58`) — không solve lại.

**Trick đáng chú ý:** io.Pipe splice tách hoàn toàn "phát hiện cắt" khỏi "người tiêu dùng"; giới hạn 8 round chống loop vô tận; fallback_to_resume=true cho phép DeepSeek tự resume message đang dở.

---

## 6. Kỹ thuật khác

### 6a. uTLS Safari fingerprint + ép ALPN HTTP/1.1 (`internal/deepseek/transport/transport.go:71-113`)

- `DialTLSContext` custom: dial TCP thuần → `utls.UClient` với **`utls.HelloSafari_Auto`** (ClientHello giả Safari) (`transport.go:80-82`).
- **forceHTTP11ALPN** (`transport.go:100-113`): `BuildHandshakeState()` rồi walk `uConn.Extensions`, tìm `ALPNExtension` và **ghi đè `AlpnProtocols = ["http/1.1"]`** trước khi handshake — Safari mặc định đề xuất h2, ép hạ xuống h1.1 để khớp client Go (Go transport đặt `ForceAttemptHTTP2: false`, `transport.go:34`).
- Sau handshake kiểm tra negotiated protocol, khác `http/1.1` → đóng conn, fail cứng (`transport.go:92-95`). Client thường (`NewFallbackClient`) không uTLS (`transport.go:52-69`); proxy env chỉ áp khi không inject dialContext (`transport.go:29-31,42-44`).

### 6b. PromptCompat boundary — 4 protocol hội tụ 1 StandardRequest

- 4 surface: `openai_chat` (`promptcompat/request_normalize.go:41`), `openai_responses` (`request_normalize.go:93`), `anthropic_messages` (`httpapi/claude/standard_request.go:51`), `google_gemini` (`httpapi/gemini/convert_request.go:42`). Gemini/claude convert message về **dạng OpenAI messages** rồi gọi `BuildOpenAIPromptForAdapter` (`promptcompat/prompt_build.go:35-37`, `gemini/convert_request.go:35`) — normalize trùng với chat/completions để hành vi tool/history giống hệt.
- **Merge rules** (`message_normalize.go:12-57`): `developer` → `system` (`message_normalize.go:201-207`); assistant message gộp 3 phần `\n\n`: reasoning bọc `[reasoning_content]...[/reasoning_content]` (`formatPromptLabeledBlock` `message_normalize.go:180-187`), content, tool-call history (`buildAssistantContentForPrompt` `message_normalize.go:59-87`); assistant content nếu là block `<tool_calls>` standalone → re-parse thành format chuẩn (`message_normalize.go:89-121`); tool/function content rỗng → chuỗi `"null"` (`message_normalize.go:189-195`); role lạ không có content → drop (`message_normalize.go:42-54`).
- **History transcript thay vì passing messages**: cuối cùng chỉ 1 string `FinalPrompt` được đưa vào payload `"prompt"` (`standard_request.go:79-91`); history render thành file ảo `# DS2API_HISTORY.txt` với entries `=== n. ROLE ===` (`history_transcript.go:8-11,30-60`), tool history kèm header `[name=... tool_call_id=...]` (`history_transcript.go:75-96`).
- **Tool-choice policy** parse chặt: auto/none/required/forced + `allowed_tools` validate chống undeclared tool (`request_normalize.go:144-233`); tools schema hỏng → vẫn bật sieve bằng sentinel `__any_tool__` (`request_normalize.go:112-124`). Inline file token estimate `bytes/3` pessimistic (`request_normalize.go:353-378`).

### 6c. DSML/XML tool-call sieve trên raw stream (`internal/toolstream/`)

- State machine duy nhất `State` (`tool_sieve_state.go:8-26`): `pending` (văn bản chờ), `capture` (đang gom tool-call), stack code fence (```/~~~), markdown inline-code span ticks, incremental tool-arg delta state.
- `ProcessChunk` (`tool_sieve_core.go:5-91`): tìm markup bắt đầu (`findToolSegmentStart` `tool_sieve_core.go:194-222`) — **bỏ qua tag trong code fence** (state-aware `insideCodeFenceWithState` `tool_sieve_state.go:62-74`) và **trong inline-code span**; span mở từ chunk trước chưa đóng → `holdToolSegmentStart = -2` giữ buffer chờ (`tool_sieve_core.go:216-219`) — chống false-positive khi model viết ví dụ `<tool_call>` trong backticks.
- `splitSafeContentForToolDetection` (`tool_sieve_core.go:167-190`): partial XML tag → hold phần đuôi, emit prefix an toàn.
- `Flush` (`tool_sieve_core.go:93-165`): end-of-stream recovery — stray backtick unmatched → reset span và re-scan (`tool_sieve_core.go:98-104`); capture chưa resolve thành tool call thật → **release nguyên văn như text, không nuốt nội dung** (`tool_sieve_core.go:140-151`); sanitize CDATA lỏng thử cứu lại (`tool_sieve_core.go:127-139`).
- DSML normalize (`toolcall/toolcalls_dsml.go:7-62`): canonicalize markup kiểu DSML (tag có delimiter lạ) về XML chuẩn, skip section bị ignore (code span/fence).

### 6d. Error normalize (`internal/assistantturn/turn.go`, `completionruntime/nonstream.go`)

- Một kiểu lỗi chung `OutputError{Status, Message, Code}` (`turn.go:30-34`) xuyên suốt mọi surface.
- `ValidateTurn` (`turn.go:195-211`): tool_choice required mà không có call → 422 `tool_choice_violation`; không call không text → `UpstreamEmptyOutputDetail` (`turn.go:213-222`): content_filter → 400 `content_filter`; thinking-only (rate limit) → 429 `upstream_empty_output`; trống → 503 `upstream_unavailable`. Lỗi này đồng thời là **FailureKind** cho retry ladder (mục 4).
- `FinalizeTurn` (`turn.go:234-255`): có tool-call → xoá error, finish_reason `tool_calls`; usage đếm token heuristic (tiktoken/heuristic `util/token_count*.go`), ref-file tokens cộng vào input.
- Auth error normalize theo loại token (`authOutputError` `nonstream.go:273-278`): managed account → hướng dẫn re-login admin; API-key lạ → gợi ý config.keys.

---

## 7. Pattern đáng clean-room cho ai-engine (Ghita)

1. **PoW zero-alloc solver**: pre-absorb prefix + stack buffer + so target uint64 (`pow/deepseek_pow.go:31-118`) — khuôn mẫu chung cho mọi PoW dạng hash-counting.
2. **Micro-batch SSE pump** 16 rune/10ms + first-token flush ngay (`sse/stream.go:26-33,130-190`) — cân bằng latency/throughput có đo đạc, dễ transplant; kèm timer stop-drain-reset chuẩn.
3. **Round-robin = rotate-on-acquire + FIFO close-channel waiter + exclude-set** (`account/pool_acquire.go`) — nhỏ gọn hơn semaphore+condvar, fairness rõ ràng, đáng mang nguyên khối sang ai-engine account pool.
4. **Thang retry 2 lớp theo FailureKind**: empty-output → synthetic follow-up turn trong cùng session (suffix prompt + parent_message_id), 429 → switch-account một lần duy nhất (`stream_retry.go`, `nonstream.go:194-206`, `assistantturn/turn.go:213-232`) — thiết kế "lỗi nào quyền nào" rất sạch.
5. **Auto-continue splice qua io.Pipe + nuốt [DONE] giữa stream** (`client_continue.go`) — pattern độc lập surface, dùng được cho bất kỳ upstream cắt ngang nào.
6. **uTLS fingerprint ép ALPN h1.1** (`transport.go:100-113`) — ghi đè extension trước handshake là trick hiếm tài liệu.
7. **Sieve markup state-machine hold/release**: hold khi chưa chắc, flush nguyên văn khi không phải tool-call (`tool_sieve_core.go:93-165`) — nguyên tắc "không bao giờ nuốt text của user" nên giữ.
8. **Replay-overlap dedupe** HasPrefix 2 chiều với ngưỡng 32 rune (`sse/dedupe.go`) — xử lý continuation snapshot lặp nội dung.

_(Hết báo cáo — chỉ đọc, không sửa repo.)_
