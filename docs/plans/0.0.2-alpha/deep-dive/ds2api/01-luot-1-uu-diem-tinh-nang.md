# ds2api — Lượt 1: Tổng quan, tính năng & ưu điểm áp dụng

> **Dự án:** CJackHwang/ds2api v4.6.1 — gateway Go biến DeepSeek Web thành API chuẩn OpenAI/Claude/Gemini/Ollama · **AGPL-3.0** (xác minh LICENSE:1-2) · **ARCHIVED** (push cuối 10/05/2026) · Go ~37.4k dòng (368 file, 135 test) + WebUI React ~6.6k dòng · clone: `refer_project/ai-framework/ds2api`
> **Phương pháp:** 2 subagent khảo sát song song 22/11/2026, chỉ đọc mã nguồn (KHÔNG chạy code). ⚠️ AGPL-3.0 → với Ghita CHỈ học thiết kế/ý tưởng theo quy trình clean-room, cấm copy code.

## Tóm tắt nhanh (tổng hợp)

- Kiến trúc lõi 3 tầng: N surface adapter (openai/claude/gemini/ollama) → 1 `StandardRequest` canonical (`promptcompat/standard_request.go:5`) → 1 completion code-path; Claude/Gemini delegate qua OpenAI handler (`server/router.go:68-70`) — pattern N×M→N+M.
- Tính năng: account pool round-robin + inflight caps + waiter FIFO; token lifecycle lazy-login/force-refresh/failover với exclude-set; FailureKind taxonomy + retry thang rỗng→switch-account; PoW solver DeepSeekHashV1 thuần Go zero-alloc (`pow/deepseek_pow.go`); SSE micro-batch 16 ký tự/10ms; auto-continue stream splice; synthetic tool-calling DSML (canonical-XML); uTLS Safari fingerprint; gateway auth đa hình thái; Admin JWT + WebUI.
- **Pattern đáng học cho Ghita (chỉ ý tưởng):** StandardRequest layer cho ~25 provider ai-engine; credential pool mapping cho ai-engine; micro-batch delta cho Socket.IO mobile; error normalize 1 AgentError shape; queue fairness cho burst.
- **Không học:** automate login + TLS fingerprint spoof (vi phạm ToS), keyword-based error detection (giòn), map[string]any payload (mất type-safety).
- Rủi ro: AGPL buộc clean-room; ARCHIVED — mọi claim upstream phải tự verify.

---

# ds2api — Subagent 1: Tổng quan & tính năng

> Repo khảo sát: `D:\GHITA AGENT\refer_project\ai-framework\ds2api` (clone của CJackHwang/ds2api). Chỉ đọc, không sửa repo gốc. Ngày khảo sát: 2026-11-22.

## 1. Dự án là gì

**DS2API** là middleware/gateway biến "năng lực hội thoại DeepSeek Web (phía trang web)" thành API chuẩn tương thích **OpenAI / Claude / Gemini / Ollama** (README.MD:20, docs/project-value.md:19-25). Vấn đề cốt lõi nó giải quyết (docs/project-value.md:29-57):

- Web DeepSeek không có API công khai ổn định → chuẩn hóa thành API contract cho SDK/CLI (Codex CLI, Claude Code, Gemini SDK, LangChain, OpenWebUI…).
- Không chỉ forward URL: phải quy đổi format request/response, thinking/reasoning, search + citation, file upload, session lifecycle, auto-continue, retry khi output rỗng, usage estimation.
- "PromptCompat" — mọi protocol đều được normalize về **context thuần text kiểu web-chat** rồi render ngược về protocol gốc (docs/ARCHITECTURE.md:195).

**Ai dùng**: cá nhân/nhà phát triển muốn gắn DeepSeek (bản web, dùng tài khoản cookie/password) vào toolchain lập trình — Claude Code, Codex CLI, OpenAI SDK JS/Python, Vercel AI SDK, Anthropic SDK, Gemini SDK (README.MD:149-158 — bảng platform compatibility P0/P1).

**Mô hình triển khai**:

- Binary Go tự chạy: `cmd/ds2api/main.go`, build tĩnh `CGO_ENABLED=0`, bind `0.0.0.0:5001` (README.MD:320-322).
- Docker multi-stage: Node24 build WebUI → Golang 1.26 build binary → runtime `debian:bookworm-slim`, user non-root `ds2api`, volume `/data` (Dockerfile:1-43). Có thêm chế độ `runtime-from-dist` nhúng archive release có sẵn (Dockerfile:45-68).
- Vercel Serverless: `api/index.go` (Go handler) + `api/chat-stream.js` (Node Runtime cho SSE streaming, vercel.json rewrite chỉ `/v1/chat/completions`) (README.MD:279-299).
- Zeabur (zeabur.yaml), systemd, release archive đa nền tảng qua GitHub Actions (`.github/workflows/release-artifacts.yml`).
- Repo kèm bộ tài liệu song ngữ Trung/Anh: README, API.md (~1.4k dòng), docs/ARCHITECTURE.md, DEPLOY, TESTING, project-value.

## 2. Kho tính năng đầy đủ

### 2.1 Protocol adaptation (chuyển đổi format)

Router chính: `internal/server/router.go:95-118`.

| Protocol             | Endpoint                                                                                            | Bằng chứng                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| OpenAI Chat          | `POST /v1/chat/completions`, `GET /v1/models`, `GET /v1/models/{id}`                                | router.go:99-101                                                     |
| OpenAI Responses API | `POST /v1/responses`, `GET /v1/responses/{response_id}` (có response store TTL 900s)                | router.go:102-103; config.example.json `responses.store_ttl_seconds` |
| OpenAI Files         | `POST /v1/files`, `GET /v1/files/{file_id}` (upload inline file + file status polling upstream)     | router.go:104-105; internal/deepseek/client/client_upload.go         |
| OpenAI Embeddings    | `POST /v1/embeddings` — provider `deterministic` local (không gọi upstream)                         | router.go:106; config.example.json                                   |
| Claude               | `POST /anthropic/v1/messages`, `count_tokens`, shortcut `/v1/messages`, `/messages`                 | internal/httpapi/claude/handler_routes.go:37-44                      |
| Gemini               | `POST /v1beta/models/{model}:generateContent` + `:streamGenerateContent` (+ `/v1/models/{model}:*`) | internal/httpapi/gemini/handler_routes.go:28-32                      |
| Ollama               | `GET /api/version`, `GET /api/tags`, `POST /api/show`                                               | README.MD:137                                                        |
| Admin API            | `/admin/*` JWT-protected (xem 2.7)                                                                  | internal/httpapi/admin/handler.go:28-55                              |
| Ops probe            | `GET /healthz`, `GET /readyz`                                                                       | router.go:95-98                                                      |

Kiến trúc boundary: mọi protocol normalize về `standard_request` chung → `promptcompat` build context text → `completionruntime` chạy session/PoW/completion → `assistantturn` unify output → renderer theo protocol (docs/ARCHITECTURE.md:110-186; quy tắc boundary ghi cứng trong AGENTS.md "Protocol Adapter Boundary").

- Model alias: `model_aliases` dùng chung cho cả 3 protocol (`gpt-4o` → `deepseek-v4-flash`…), hậu tố `-nothinking` force tắt thinking (README.MD:160-203; config.example.json).
- Claude converter riêng: `internal/claudeconv/convert.go`.
- Tool call: model xuất shell DSML `<|DSML|tool_calls><|DSML|invoke name=…>` → normalize về canonical XML để parse (internal/toolcall/toolcalls_dsml.go:9-45); chống leak streaming bằng sieve (internal/toolstream/tool_sieve_core.go); OpenAI responses dùng đúng lifecycle event chính thức `response.output_item.*` (README.MD:377-379).

### 2.2 Multi-account management (pool, rotation, refresh)

- Account trong `config.json`: login bằng `email` hoặc `mobile` + password, per-account proxy (config.example.json; internal/deepseek/client/client_auth.go:16 Login, :274 normalizeMobileForLogin).
- Pool: `internal/account/pool_core.go:10-20` — struct `Pool{queue []string; inUse map[string]int; waiters []chan struct{}; maxInflightPerAccount; globalMaxInflight}`. Acquire round-robin có `bumpQueue` (pool_acquire.go:83), wait trên channel có context (pool_acquire.go:15 `AcquireWait`).
- Token lifecycle: `ensureManagedToken` login nếu trống; force refresh theo interval (mặc định 6h, `RuntimeTokenRefreshIntervalHours`); `MarkTokenInvalid` khi upstream báo token chết (internal/auth/request.go:262-296, 163-184).
- Rotation/retry: 429 do upstream thinking-only rỗng → compensate retry cùng account rồi **switch account fresh retry** (`SwitchAccount`, request.go:186-214; completionruntime/stream_retry.go).
- Pass-through mode: key không nằm trong `config.keys` → dùng thẳng làm DeepSeek token (request.go:64-72).
- Header `X-Ds2-Target-Account` chỉ định account cụ thể, 429 nếu account bận (request.go:73-79; README.MD:352-353).

### 2.3 Queue control

- Mỗi account: `account_max_inflight` (default 2) slot; hàng đợi waiter `account_max_queue` (default = recommended = số account × inflight); global cap `global_max_inflight` (README.MD:359-369; internal/account/pool_limits.go:9-50).
- Chỉ 429 khi vượt tổng capacity, không có `Retry-After`.
- Monitoring: `GET /admin/queue/status` trả `available/in_use/waiting/max_*` (pool_core.go:102-132 `Status()`).
- Hot update: `runtime` settings reload qua Admin API mà không restart (internal/config).

### 2.4 Proof-of-Work solver

- DeepSeek bắt PoW qua `/api/v0/chat/create_pow_challenge` → giải thuật **DeepSeekHashV1**: tìm nonce ∈ [0, difficulty) sao cho keccak(prefix+nonce) == challenge (pow/deepseek_pow.go:13-31).
- Tối ưu: prefix (salt_expireAt_) **pre-absorb vào state keccak-f1600**, vòng lặp zero-allocation, encode số bằng buffer tĩnh 20 byte; check ctx cancel mỗi 1024 nonce (pow/deepseek_pow.go:46-68). Wrapper client: internal/deepseek/client/pow.go (`GetPow`, `GetPowForTarget`, retry nhiều lần).
- Tự viết keccak (không dùng x/crypto/sha3), có benchmark (pow/deepseek_pow_test.go, pow/README.md).

### 2.5 Streaming SSE conversion

- Parser DeepSeek SSE: `internal/sse/parser.go` — `ParseDeepSeekSSELine` (:17), xử lý fragment type thinking/text lồng nhau qua path (`updateTypeFromExplicitPath` :115, nested response :176), dedupe (:internal/sse/dedupe.go), phát hiện content-filter leak (internal/sse/content_filter_leak.go), citation link (internal/sse/citation_links.go).
- Engine stream chung: `internal/stream/engine.go:10-24` — StopReason enum (context_cancelled / no_content_timeout / idle_timeout / upstream_completed / handler_requested), keep-alive ticker, hooks OnParsed/OnKeepAlive/OnFinalize (:44-50).
- Semantic layer: `internal/assistantturn` normalize thinking/toolcall/usage/stop thành unified assistant turn; render bằng `internal/format/{openai,claude}`.
- Chi tiết hành vi upstream được reverse-engineer và ghi doc: docs/DeepSeekSSE行为结构说明-2026-04-05.md.
- Regression replay: tests/raw_stream_samples/* chứa SSE thật của upstream để test so khớp byte-level (internal/compat + tests/scripts/compare-raw-stream-sample.sh).

### 2.6 Auth cho gateway

- Caller credential extraction đa hình thái: `Authorization: Bearer`, `x-api-key`, `x-goog-api-key`, `?key=`, `?api_key=` (internal/auth/request.go:230-251) — phục vụ cả Gemini AI Studio client.
- Caller identity = SHA-256(key)[:8] dùng isolate chat-history giữa các tenant (request.go:253-260).
- Admin auth: JWT HS256 tự implement (không thêm dependency), expire configurable, có cơ chế `AdminJWTValidAfterUnix` vô hiệu token cũ khi đổi secret (internal/auth/admin.go:73-97).
- 2 mode rõ ràng: managed (key trong `keys`/`api_keys` với name/remark) vs pass-through token (README.MD:343-355).

### 2.7 Admin / monitoring surface

`internal/httpapi/admin/handler.go:41-53` — subpackages:

- auth (login/logout JWT), accounts (CRUD, test/batch test account, batch import), configmgmt (import/export full config), settings (hot update runtime), proxies, rawsamples (truy vấn/xuất capture), vercel (sync), devcapture (packet capture), history (chat history server-side), version (check update).
- WebUI: React + Vite SPA tại `/admin`, ~6.5k dòng JSX/JS (webui/src), i18n zh/en, dark mode, 6 feature pages: account manager, API tester (chat panel stream test), chat history viewer, proxy manager, settings, Vercel sync (docs/ARCHITECTURE.md:96-107).
- Server-side chat history: `internal/chathistory/store.go` lưu + phân trang + retention policy; `internal/responsehistory` archive raw response trước khi render.
- Dev packet capture: `DS2API_DEV_PACKET_CAPTURE=true` ghi N request/response upstream gần nhất vào memory, API truy vấn theo keyword, lưu thành replay sample (README.MD:386-415).
- File/thumbnail: `internal/devcapture`, `internal/rawsample` — bộ công cụ debug "giống tcpdump cho upstream".

## 3. Trạng thái dự án

| Mục             | Giá trị                                                                                                                                                            | Bằng chứng                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| License         | **AGPL-3.0** (GNU Affero General Public License v3)                                                                                                                | LICENSE:1-2; GitHub API xác nhận "AGPL-3.0" |
| Ngôn ngữ        | Go 1.26 (module `ds2api`); Node.js cho Vercel bridge + WebUI React/Vite                                                                                            | go.mod:1-3; Dockerfile                      |
| Kích thước      | 368 file Go, **~37.4k dòng Go** (gồm 135 test file); WebUI 53 file ~6.6k dòng; tổng ~546 file (không tính .git)                                                    | đếm `find + wc -l`                          |
| Version         | 4.6.1                                                                                                                                                              | VERSION:1                                   |
| ARCHIVED        | **True** trên GitHub (archived=true), ~4,697 sao, push cuối 2026-05-10                                                                                             | GitHub API repos/CJackHwang/ds2api          |
| Dependencies Go | chi: go-chi/chi v5; refraction-networking/utls; hupe1980/go-tiktoken; andybalholm/brotli; dlclark/regexp2; tidwall gjson/sjson; CLIProxyAPI/v6 (bridge chuyển đổi) | go.mod:5-25                                 |
| CI/CD           | quality-gates (lint + line-gate + unit + webui build), release-artifacts đa platform (linux amd64/arm64/armv7, darwin, windows), GHCR docker                       | .github/workflows/*                         |

Top-level: `api/` (Vercel), `app/` (handler assembly), `cmd/` (main + e2e CLI), `docs/`, `internal/` (~30 packages), `pow/`, `scripts/`, `tests/` (fixtures, raw samples, node tests, scripts), `webui/`, `start.mjs` (menu tương tác dev/prod/stop).

## 4. 5 điểm độc đáo nhất

1. **PoW solver DeepSeekHashV1 thuần Go, zero-allocation** — tự implement keccak-f1600, pre-absorb prefix vào state để mỗi nonce chỉ XOR + 1 permutation; mục tiêu "mili-giây response" (pow/deepseek_pow.go:29-68; README.MD:141).
2. **TLS fingerprint masquerading bằng uTLS Safari** — `utls.HelloSafari_Auto` + force HTTP/1.1 ALPN trong DialTLSContext để trông giống browser thật khi gọi web DeepSeek (internal/deepseek/transport/transport.go:11, 81-105) — hiếm project reverse-engineering nào làm kỹ tới tầng TLS handshake.
3. **PromptCompat kernel: 4 protocol về 1 text-context duy nhất** — OpenAI/Claude/Gemini/Ollama đều normalize thành `standard_request` → context web-chat thuần text (kèm `DS2API_HISTORY.txt` context-file upload cho history dài), rule boundary được ghi trong AGENTS.md để không protocol nào "chiếm" business logic (internal/promptcompat/*; AGENTS.md).
4. **Dual-runtime streaming bridge trên Vercel** — Go làm "prepare" (auth, account lease, PoW, payload), Node Runtime làm SSE relay với tool sieve được implement song song 2 ngôn ngữ + cross-build compat test để đảm bảo Go/Node semantics giống hệt nhau (api/chat-stream.js; internal/js/chat-stream; tests/node/stream-tool-sieve.test.js; tests/compat/fixtures).
5. **Tool-call anti-leak sieve + DSML shell** — streaming sieve chặn markup toolcall rò ra text (fence/code-span aware), parse DSML `<|DSML|tool_calls>` lẫn canonical XML, có json-repair, schema-normalize, và bộ test fixture byte-level với raw SSE samples thật từ upstream (internal/toolcall/_, internal/toolstream/_; docs/toolcall-semantics.md).

## Phụ lục: cấu trúc internal/ chính

`account` (pool/queue) · `assistantturn` (output semantic) · `auth` (caller/admin JWT) · `chathistory` · `claudeconv` · `compat` (regression fixtures) · `completionruntime` (session/PoW/call + retry) · `config` (load/hot-update) · `deepseek/{client,protocol,transport}` · `devcapture` · `format/{claude,openai}` · `httpapi/{admin,claude,gemini,ollama,openai/*,requestbody}` · `js` (Node bridge) · `prompt` · `promptcompat` · `rawsample` · `responsehistory` · `server` · `sse` · `stream` · `testsuite` · `textclean` (xóa `[reference: N]`) · `toolcall` · `toolstream` · `translatorcliproxy` · `util` · `version` · `webui` (docs/ARCHITECTURE.md:12-108).

---

# ds2api — Subagent 2: Ưu điểm & áp dụng vào Ghita

> Repo: `D:\GHITA AGENT\refer_project\ai-framework\ds2api` (clone CJackHwang/ds2api, AGPL-3.0, ARCHIVED).
> Phạm vi: Go API gateway biến DeepSeek web/mobile session thành endpoint chuẩn OpenAI Chat/Responses, Claude Messages, Gemini, Ollama. ~33k LOC Go không test (368 file `.go`).
> **Ràng buộc tuyệt đối:** repo là AGPL-3.0 (`LICENSE:1`) → chỉ học Ý TƯỞNG/thiết kế, cấm copy/transpile code vào Ghita.

---

## 0. Kiến trúc tổng quan (bản đồ đọc code)

```
httpapi/{openai,claude,gemini,ollama,admin}   ← N surface adapter (REST + SSE)
        ↓ normalize
promptcompat.StandardRequest                  ← 1 định dạng request nội bộ chuẩn
        ↓ CompletionPayload(sessionID)
deepseek/client (auth, session, PoW, completion, auto-continue)
        ↑ acquire/release
account.Pool (round-robin + inflight caps) ← auth.Resolver (token lifecycle)
pow/ (solver thuần Go)   sse/ (parse + micro-batch)   toolcall/toolstream (synthetic tools)
```

Điểm mấu chốt kiến trúc: **các surface không gọi upstream trực tiếp** — mọi request chuẩn hóa về `StandardRequest` rồi mới gọi một code-path completion duy nhất.

---

## 1. Ưu điểm thiết kế (xếp hạng theo giá trị học hỏi)

### 1.1. Lớp chuẩn hóa request "canonical" giữa N adapter và 1 upstream (xếp hạng 1)

- Mọi surface (openai_chat, openai_responses, claude, gemini) đều normalize về **một struct duy nhất** `StandardRequest` (Surface, ResolvedModel, FinalPrompt, ToolNames, ToolChoice, Stream, Thinking, RefFileIDs, PassThrough) — `internal/promptcompat/standard_request.go:5-27`.
- Mỗi surface chỉ có hàm normalize riêng: `NormalizeOpenAIChatRequest` (`promptcompat/request_normalize.go:15-58`), tương tự cho Responses/Claude/Gemini. Xuống upstream chỉ còn `StandardRequest.CompletionPayload(sessionID)` (`standard_request.go:61+`).
- Handler Claude/Gemini còn **delegiate qua OpenAI handler** thay vì tự gọi upstream (`internal/server/router.go:68-70`: claudeHandler/geminiHandler nhận cả `OpenAI: chatHandler`) — giảm N×M mapping xuống N+M.

### 1.2. Account pool: round-robin + caps + hàng chờ công bằng (xếp hạng 2)

- Pool giữ `queue []string` tài khoản; khi acquire xong thì `bumpQueue` đẩy tài khoản về **cuối hàng** → round-robin tự nhiên, không cần atomic counter (`internal/account/pool_acquire.go:83-92`, `tryAcquire` :66-81).
- Ba tầng giới hạn: `maxInflightPerAccount` (default 2), `globalMaxInflight` (≈ accounts × per-account), `maxQueueSize` — đều cấu hình được qua store/env (`pool_limits.go:9-73`, `pool_core.go:22-81`).
- `AcquireWait` có hàng đợi waiter FIFO (channel đóng để đánh thức) + hủy qua `ctx.Done()` + xóa waiter khỏi queue khi hủy (`pool_acquire.go:15-47`, `pool_waiters.go:18-36`). Trả `Status()` đầy đủ để admin giám sát (`pool_core.go:102-132`).

### 1.3. Token lifecycle tự động: lazy login + refresh định kỳ + failover (xếp hạng 3)

- `auth.Resolver` gộp cả vòng đời credential: token rỗng → login ngay; quá interval giờ → **force refresh**; lỗi auth → `MarkTokenInvalid`; tài khoản hỏng → `SwitchAccount` với **exclude-set** `TriedAccounts` (`internal/auth/request.go:81-120, 152-214, 262-296`).
- Refresh có ghi dấu thời điểm per-account (`tokenRefreshedAt`) và persist token về store ngay sau login (`loginAndPersist`, `request.go:152-161`) — token không bao giờ chỉ nằm trong RAM.
- Multi-tenant: caller key (Bearer / x-api-key / x-goog-api-key / query key) được nhận diện riêng khỏi account DeepSeek; caller identity lưu dạng hash SHA-256 8 byte để cách ly lịch sử chat theo tenant mà không lộ key thô (`request.go:230-260`).

### 1.4. Phân loại lỗi + thang retry nhiều cấp (xếp hạng 4)

- `FailureKind` 3 mức: unknown / direct_unauthorized (user tự đưa token) / managed_unauthorized (pool quản lý) — cho phép hành vi khác nhau theo nguồn credential (`internal/deepseek/client/errors.go:8-46`).
- Heuristic nhận lỗi auth **kể cả HTTP 200 + biz_code != 0** (DeepSeek trả lỗi dạng biz message), danh sách keyword song ngữ Trung/Anh (`client_auth.go:170-225`). Lỗi cuối trả về `RequestFailure{Op, Kind, Message}` có cấu trúc thay vì error string.
- Thang retry ở `completionruntime/stream_retry.go:39-147`: output rỗng → retry N lần (có prompt "synthetic retry" + parent_message_id); hết lượt → **switch account đúng 1 lần** rồi tạo session/PoW mới (`startPayloadCompletionOnAlternateAccount` :149-173); vẫn fail → terminal.
- Retry loop dùng hooks (ConsumeAttempt/OnRetry/OnAccountSwitch...) tách chính sách retry khỏi I/O — dễ test.

### 1.5. PoW solver thuần Go, tối ưu vi mô (xếp hạng 5)

- Reverse-engine protocol thành spec rõ ràng: `DeepSeekHashV1 = SHA3-256 nhưng bỏ round 0 của Keccak-f` (`pow/README.md`, `pow/deepseek_hash.go:1-3`).
- Tối ưu đáng học: prefix `salt_expireAt_` **pre-absorb vào sponge state** trước vòng lặp → trong loop nonce chỉ XOR tail + 1 lần `keccakF23`, zero allocation (`pow/deepseek_pow.go:46-116`); check `ctx.Err()` mỗi 1024 vòng (:62-68); target so sánh 4 uint64 little-endian thay vì bytes.
- API gọn: `SolveAndBuildHeader(challenge) → x-ds-pow-response` (`deepseek_pow.go:134-147`) — một hàm end-to-end, phía client chỉ gọi.

### 1.6. SSE re-streaming + micro-batching delta (xếp hạng 6)

- DeepSeek upstream là giao thức patch dạng `{p: path, v: value}` trên SSE — parser tách content theo path, quản lý fragment type (thinking→text transition, bỏ qua path status/noise) (`internal/sse/parser.go:33-113`).
- Bên pump có **AccumulateConfig**: gom delta nhỏ thành chunk ≥ MinChars (16) hoặc MaxWait (10ms) hoặc xuống dòng mới mới flush — giảm số message không cần thiết (`internal/sse/stream.go:12-33`). Pipeline 2 goroutine (reader 64KB buffer → parsed line channel 128) tách I/O khỏi parse.

### 1.7. Auto-continue: bọc stream cắt nối trong suốt (xếp hạng 7)

- Khi model hết output-limit, client **tự gọi API continue** (tối đa 8 round) và nối stream vào `io.Pipe` — caller phía ngoài thấy một stream liền mạch, không biết có continuation (`internal/deepseek/client/client_continue.go:30-52, 80-97`; state observer bắt flag `auto_continue` và status FINISHED :184-290).

### 1.8. Synthetic tool-calling cho model không có function-calling (xếp hạng 8)

- Tools được serialize thành markup DSML (`<|DSML|tool_calls>/<|DSML|invoke|parameter>`) nhét vào prompt + replay lịch sử (`internal/prompt/tool_calls.go:18-60`); output model được **scan ngược** ra tool calls — kể cả trong thinking, có xử lý code-fence/markdown-span để không bắt nhầm tag trong code block (`internal/toolcall/toolcalls_scan.go:35-64`, `toolcalls_parse.go:22-60`).
- Streaming version `toolstream/tool_sieve_core.go`: buffer pending giữ text khi chưa phân giải được tag mơ hồ, tách prefix/suffix, emit Event{Content|ToolCalls} (:5-70). Kèm `ToolChoicePolicy` auto/none/required/forced chuẩn hóa như OpenAI (`promptcompat/standard_request.go:30-52`).

### 1.9. Transport hardening + per-account proxy (tham khảo, không học theo)

- uTLS giả fingerprint Safari (`internal/deepseek/transport/transport.go:1-40`) + fallback về std transport khi fail; endpoint primary/fallback pair trong mọi call (`client_completion.go:42-72`); cache http.Client per-proxy (`client_core.go:16-44`, `proxy.go:129-136`).

### 1.10. Observability & self-test harness (xếp hạng 9)

- `devcapture.Store` bọc request/response body lại (label + truncate 5MB) để admin xem raw sample khi upstream đổi giao thức (`internal/devcapture/store.go:14-36`).
- `internal/testsuite` là conformance runner chạy chính nó như server thật: runSummary + assertions + artifact per case (`testsuite/runner_core.go:14-47`); admin có endpoint **test-all-accounts song song với semaphore 5** — health check sống động mỗi tài khoản (`httpapi/admin/accounts/handler_accounts_testing.go:31-70`).

---

## 2. Cái hay áp dụng vào Ghita (CHỈ pattern/ý tưởng — KHÔNG copy code, repo AGPL-3.0)

### (a) Adapter web-session → chuẩn API: giá trị cho ai-engine

- **Pattern đáng lấy:** lớp `StandardRequest`/`StandardChunk` nội bộ đứng giữa N provider adapter và engine. ai-engine đang có ~25 provider TS, mỗi provider tự map request/response riêng → chuẩn hóa về 1 canonical shape sẽ chuyển N×M thành N+M, và giúp provider "không chính chủ" (service chưa có API chính thức, gọi qua session web) viết mỏng hơn rất nhiều.
- **Với provider kiểu web-session:** dùng pattern "1 completion code-path + payload builder per-surface" của ds2api; provider wrapper chỉ cần: login/refresh credential → tạo session → solve challenge (nếu có) → normalize stream.
- Giá trị: cao (giảm dư thỞ code, dễ thêm provider). Độ khó: trung (refactor dần, giữ adapter cũ song song).

### (b) Credential pool + rotation + health check → packages/ai-engine

- Bảng mapping ý tưởng:
  | ds2api                                             | Ghita ai-engine                                                   |
  | -------------------------------------------------- | ----------------------------------------------------------------- |
  | `Pool.queue` + `bumpQueue` round-robin             | pool API key/credential per provider, xoay vòng khi acquire       |
  | `maxInflightPerAccount` + `globalMaxInflight`      | rate-limit nội bộ cho từng key (free-tier key khác nhau quota)    |
  | `AcquireWait` + waiter FIFO + ctx cancel           | burst request từ agent tool-calls không 429 của mình gây ra       |
  | `TriedAccounts` exclude-set                        | failover: key lỗi 401/429 → thử key khác trong cùng provider      |
  | `ensureManagedToken` + force refresh theo interval | lazy re-auth cho provider OAuth/device-flow; ghi dấu last-refresh |
  | admin test-all-accounts semaphore 5                | command health-check định kỳ per credential, đánh dấu key chết    |
- Giá trị: cao cho loadNative() fallback + provider rotation. Độ khó: thấp-trung (thuần TS, không cần infra).

### (c) PoW/challenge solver pattern

- Với Ghita: ít khi cần PoW thật, nhưng **shape của pattern** đáng học: (1) protocol quirk đóng gói thành package riêng, pure function `solve(challenge) → answer`, không phụ thuộc HTTP; (2) bảng test vector kèm bench; (3) pre-compute phần bất biến (pre-absorb prefix) trước vòng lặp; (4) check cancel định kỳ để không đốt CPU vô ích.
- Nếu Ghita có Rust crate napi addon: dạng challenge-solving CPU-bound là ứng viên tốt cho Rust thay vì TS.
- Giá trị: tình huống (situational). Độ khó: cao nếu gặp service thật có PoW; thấp nếu chỉ định hình interface.

### (d) Queue/fairness cho request burst

- Lấy nguyên lý: caps 2 tầng + hàng đợi FIFO có `maxQueueSize` + từ chối nhanh khi queue đầy (fail-fast thay vì treo vô hạn) + thông kê `Status()` expose ra diagnostics.
- Ứng dụng cụ thể Ghita: packages/communication (Socket.IO desktop↔mobile) khi mobile bắn burst tool-calls; queue đặt ở desktop trước khi đẩy vào ai-engine.
- Giá trị: trung-cao. Độ khó: thấp (async queue TS ~100 dòng).

### (e) Error normalize về format thống nhất

- Lấy 3 ý tưởng: (1) **taxonomy Kind** (auth/ratelimit/protocol/unknown) phân loại tại biên giới provider, không rải if/else khắp codebase; (2) nhận diện lỗi auth cả khi HTTP 200 + body lỗi (nhà cung cấp Việt/TQ hay trả code trong body) — nhưng thay keyword hardcode bằng **bảng mapping cấu hình được per provider**; (3) error object có cấu trúc `{op, kind, message, status}` để caller quyết định retry/switch-key/abort.
- Ghita: chuẩn hóa mọi provider error thành 1 `AgentError` shape trước khi ra UI mobile/desktop.
- Giá trị: cao. Độ khó: thấp.

### (f) Hai pattern bổ sung đáng lấy

- **Micro-batching SSE delta** (10ms/16 ký tự, flush theo newline): áp trực tiếp vào packages/communication để giảm số emit Socket.IO → mobile, đỡ lag UI render. Giá trị cao, khó thấp.
- **Auto-continue wrapper**: bọc provider trả output ngắn (max-tokens cut) thành stream liền mạch, splice tiếp tục ngầm — hữu ích cho agent turn dài. Giá trị trung, khó trung.
- **devcapture + testsuite**: record raw provider response (truncate) để replay regression test khi provider đổi format; runner assertion per case. Ghita có thể làm "capture mode" cho ai-engine khi debug provider lạ.

---

## 3. Rủi ro đặc thù khi học từ ds2api

1. **AGPL-3.0 (LICENSE:1)** — copyleft mạnh nhất: nếu copy/transpile code (kể cả Go→TS đổi tên biến) vào Ghita mà dùng sản phẩm qua network, Ghita buộc mở nguồn theo AGPL. Nguyên tắc cách ly bắt buộc:
   - Đọc code → **chỉ ghi chú abstract** (module boundary, luồng dữ liệu, bất biến, thứ tự bước) → đóng source → viết lại từ ghi chú bằng TS/Rust của mình.
   - Cấm chép: tên biến/hàm, cấu trúc file, chuỗi logic if/else đặc trưng, hằng số đặc trưng (16/10ms, 8 rounds, 40001...), biểu thức regexp.
   - Design pattern/khái niệm không có bản quyền — nhưng "bản dịch máy" là work phái sinh. Mọi ghi chú trong file này chỉ mô tả hành vi, không chứa code gốc.
2. **ToS risk khi automate web session** — ds2api tự động login email/password device_id android, giả TLS fingerprint Safari, giải PoW chống bot: toàn bộ là vi phạm điều khoản dịch vụ của nhà cung cấp, rủi ro ban account vĩnh viễn. Ghita chỉ nên áp pattern cho **API chính thức**, không tự động hóa session web của bên thứ ba trong sản phẩm.
3. **ARCHIVED = không maintain** — keyword list lỗi (Trung/Anh), biz_code 40001-40003, đường path patch SSE đều là snapshot tại thời điểm archive; DeepSeek đổi là chết im lặng. Mọi claim "upstream hành vi X" phải tự verify, không tin lại code cũ. Cũng không nên học các decision gắn chặt protocol cụ thể.

---

## 4. Ba thứ KHÔNG nên học

1. **Automate login + TLS fingerprint spoofing** (`client_auth.go:16-51` gửi password + device_id "android"; `transport/transport.go` uTLS giả Safari): đây là phần lõi vi phạm ToS/anti-abuse — Ghita không tự động hóa consumer web session, không giả fingerprint browser/TLS trong sản phẩm.
2. **Phát hiện lỗi bằng keyword text + mã hardcode** (`client_auth.go:170-225`: so khớp "token"/"登录"/"未登录", biz_code 40001-40003): cực kỳ giòn — đổi i18n hoặc đổi code là hỏng; đúng hơn là bảng mapping cấu hình + phân loại theo schema lỗi chính thức của provider.
3. **Payload `map[string]any` xuyên suốt + clone tay** (`standard_request.go:61+` `CompletionPayload` trả map; `stream_retry.go:175-181` clone nông): mất type-safety, thêm field dễ quên clone. Ghita TS có zod/TS type — giữ schema tường minh cho request/response chuẩn hóa.

---

## 5. Kết luận một dòng

ds2api đáng học nhất ở **kiến trúc 3 tầng (surface adapter → canonical request → upstream client)** kèm credential pool tự chữa lành và chuẩn hóa lỗi — cả ba đều ghép trực tiếp được vào ai-engine bằng TS thuần; còn phần automation session/PoW chỉ học "shape pattern", tuyệt đối không đem code (AGPL) và không đem hành vi vi phạm ToS vào Ghita.
