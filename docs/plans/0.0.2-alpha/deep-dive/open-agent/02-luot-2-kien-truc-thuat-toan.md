# open-agent — Lượt 2: Kiến trúc & thuật toán

> **Dự án:** AFK-surf/open-agent (fork AFFiNE) · clone: `refer_project/ai-framework/open-agent`
> **Phương pháp:** 2 subagent đọc sâu song song 22/11/2026, chỉ đọc mã nguồn. Subagent 1 = kiến trúc; Subagent 2 = thuật toán & kỹ thuật cốt lõi.

## Tóm tắt nhanh (tổng hợp)

- **Kiến trúc:** mọi logic agent ở `packages/backend/server/src/plugins/copilot/` (providers/tools/workflow/prompt/context/embedding/transcript); NestJS base (BullMQ/Redis/Prisma + pgvector vector(1024)) + 2 crate napi Rust (`backend/native` = tiktoken/sanitize/hashcash, `common/native` = doc_loader pdf/docx/html + tree-sitter); frontend React/Rspack + Electron; build yarn@4 workspaces + CLI `oa`, napi-rs 3 beta 6 target, GraphQL codegen.
- **Luồng chat SSE:** `controller.ts:278` → `chooseProvider` (factory first-match qua `provider.match()`) → render prompt Mustache từ DB → `streamText` (MAX_STEPS=20, tool tạo động) → CitationParser → tee RxJS: 1 nhánh emit SSE (message/ping/error), 1 nhánh persist `ai_sessions_messages`.
- **Thuật toán đáng học:** ALS token tracker wrap `next/return/throw` của async generator + toolChain stack; RAG chunk 7168 token overlap 128 → pgvector cosine `<=>` → rerank logprob Yes/No (`pYes/(pYes+pNo)`) → score `max(rank, 1-distance)` → lọc 0.5 → topK (threshold 0.85 áp cho distance); hashcash SHA3-256 mint/check lệch 1 nibble + TTL kép; workflow condition user-defined chạy Piscina + SES Compartment/harden.
- **Phát hiện thú vị:** cuối stream còn gọi thêm 1 LLM để diễn giải báo cáo token usage; BullMQ attempts 5 + exponential backoff 2^n.
- **Điểm yếu kiến trúc:** provider coupling NestJS DI (khó test ngoài framework), hardcode model list + workflow graph, controller RxJS >800 dòng, DB-save lỗi chỉ log (mất tin nhắn âm thầm), test copilot chỉ 3 file spec.

---

# open-agent — Subagent 1: Kiến trúc

Repo: `refer_project/ai-framework/open-agent` (fork AFK-surf/open-agent — fork của AFFiNE). Monorepo yarn@4 workspaces + Cargo workspace (2 crate napi). Toàn bộ logic agent nằm ở `packages/backend/server/src/plugins/copilot/`. Tất cả path bên dưới tính từ gốc repo.

## 1. Bản đồ module

```
open-agent/
├── Cargo.toml                     # Cargo workspace: 2 crate napi (root Cargo.toml:3-5)
├── package.json                   # yarn workspaces: blocksuite/**, packages/*/*, tools/* (:13-19)
├── blocksuite/                    # vendor BlockSuite của AFFiNE (affine/framework/...) — chỉ còn dùng icon/legacy, app mới không build editor
├── packages/
│   ├── backend/
│   │   ├── native/                # crate Rust "server-native" (napi v3): tokenizer tiktoken, MIME sniff,
│   │   │                          #   html_sanitize, hashcash, doc_loader (src/lib.rs:16; index.d.ts:3-28)
│   │   └── server/                # NestJS backend (rspack build, ava test)
│   │       ├── src/core/          # auth, quota, user, features, mail, storage (khung AFFiNE giữ lại)
│   │       ├── src/base/          # nền tảng: prisma, redis, bullmq queue (base/job/queue/queue.ts:4),
│   │       │                      #   cache, mutex, event bus, config, error, metrics, throttler
│   │       ├── src/models/        # data-access Prisma: copilot-session, copilot-user (pgvector raw SQL),
│   │       │                      #   copilot-context, copilot-job (src/models/)
│   │       ├── src/plugins/copilot/  # ★ TOÀN BỘ LOGIC AGENT (chi tiết ở mục 2-3)
│   │       └── schema.prisma      # User, AiPrompt, AiSession, AiSessionMessage, AiContext,
│   │                              #   Ai*Embedding (vector(1024) pgvector: schema.prisma:11,251,269,308,346)
│   ├── common/
│   │   ├── graphql/               # GraphQL codegen client: documents .gql → schema.ts + export-gql-plugin (codegen.yml)
│   │   ├── native/                # crate Rust "open_agent_common": doc_loader (docx/html/pdf/text, splitter tree-sitter)
│   │   ├── env/ error/ debug/     # shared env parser, UserFriendlyError
│   └── frontend/
│       ├── app/                   # React 19 + Rspack SPA: src/components/chat*, src/store/copilot/ (zustand),
│       │                          #   src/lib/stream/stream-messages.ts
│       ├── component/             # UI shared
│       ├── electron/              # main/preload/helper + IPC scanner (src/entries, src/ipc), electron-forge
│       └── electron-api/          # bridge types
└── tools/cli/                     # CLI "oa" (clipanion): dev/build/init/run — điều phối monorepo (src/oa.ts:9-17)
```

Phần thừa kế AFFiNE thuần không còn dùng cho agent: doc/editor của blocksuite, core/doc storage của server — chat mới chỉ phụ thuộc `core/auth`, `core/quota`, `models`, `base`.

## 2. Luồng dữ liệu end-to-end của một chat request (SSE)

Ví dụ endpoint `GET /api/copilot/chat/:sessionId/stream` — `packages/backend/server/src/plugins/copilot/controller.ts:278-374`:

1. **HTTP entry**: NestJS `@Sse()` trả `Observable<ChatEvent>` (`controller.ts:278-285`); auth qua decorator `@CurrentUser` (`core/auth`). Định nghĩa `ChatEvent{type: 'event'|'attachment'|'message'|'error'|'ping'}` tại `controller.ts:64-68`; ping giữ kết nối mỗi 5s (`controller.ts:70,175-186`).
2. **Validate query**: `ChatQuerySchema.parse` — messageId, modelId, retry, tools (zod, `types.ts:23-37`).
3. **Chọn provider**: `chooseProvider()` → kiểm quota (`checkQuota`) + load session; chỉ chấp nhận `modelId` nằm trong `session.optionalModels` (`controller.ts:96-134,116-119`). Gọi `CopilotProviderFactory.getProvider({outputType, modelId})` — duyệt map provider đăng ký, trả provider đầu tiên mà `provider.match(cond)` === true (`providers/factory.ts:15-40`).
4. **Nạp/revert session**: `appendSessionMessage()` — nếu `retry` thì `revertLatestMessage` xoá message assistant cũ (`controller.ts:136-162`; `session.ts:307-315`); nếu có `messageId` thì `session.pushByMessageId()` nạp user message từ `ChatMessageCache` (`session.ts:117-130`).
5. **Render prompt**: `session.finish(params)` gom stash messages (giới hạn token `maxTokenSize` mặc định 128K, `session.ts:53-60,136-158`) + `ChatPrompt.finish()` render Mustache `{{content}}`/`{{language}}` + param mặc định `oa::date|language|timezone` (`prompt/chat-prompt.ts:121-163`). Prompt lấy từ bảng `ai_prompts_metadata` qua `PromptService.get()` (cache Map, `prompt/service.ts:104-146`; schema `schema.prisma:164-182`).
6. **Stream từ LLM**: `provider.streamText({modelId}, finalMessage, {tools, signal, user, session})` chạy trong context `TokenTracker` (AsyncLocalStorage đo token/latency, `providers/token-tracker.ts:1-17`). Với OpenAIProvider: `chatToGPTMessage()` tách system + chuyển attachment thành ImagePart/FilePart (`providers/utils.ts:80-143`) → `streamText()` của Vercel AI SDK, `stopWhen: stepCountIs(MAX_STEPS=20)`, tools từ `getTools()` (`providers/openai.ts:609-637`, `providers/provider.ts:63-65,162-296`).
7. **Tool calls**: tools được tạo theo tên trong `options.tools` — `browser_use`, `web_search_exa`/`cloudsway`, `doc_compose`, `e2b_python_sandbox`, `todo_list`, ... (`providers/provider.ts:191-292`). Mỗi tool là AI SDK `tool()` bọc bởi `createTool()` để push/pop toolChain vào TokenTracker (`tools/utils.ts:128-162`). Kết quả tool dạng stream được tee vào `TransformStream` gửi cả hai chiều (`tools/utils.ts:19-84`).
8. **Post-process stream**: mỗi chunk `text-delta` qua `TextStreamParser` + `CitationParser` (footnote) trước khi yield (`providers/openai.ts:415-440`).
9. **Persist**: nhánh `reduce()` gom toàn bộ text rồi `session.push({role:'assistant'})` + `session.save()` → `dispose()` chỉ ghi các stash message mới vào `ai_sessions_messages` (`controller.ts:335-356`; `session.ts:223-235`; schema `schema.prisma:184-199`). Abort giữa chừng thì lưu placeholder `'> Request aborted'` (`controller.ts:341-343`).
10. **SSE về client**: nhánh `map(data => ({type:'message', id: messageId, data}))` merge vào stream (`controller.ts:329-357`). Frontend: `CopilotClient.chatTextStream()` mở EventSource `/api/copilot/chat/<id>/stream-object` (`frontend/app/src/store/copilot/client.ts:333-368`) → `toTextStream()` bọc EventSource thành AsyncIterable, xử lý error event có data = lỗi server (`store/copilot/event-source.ts:31-106`) → zustand `session-store` merge `streamObjects`/nội dung vào message cuối (`store/copilot/session-store.ts:249-309`). Session/message quản lý bằng GraphQL mutation (`createCopilotSessionMutation`... qua `@afk/graphql` codegen, `client.ts:78-127`).

Các endpoint khác cùng mẫu: `/chat/:sessionId` (non-stream, `controller.ts:227-276`), `/stream-object` (structured stream + `StreamObjectParser`, `controller.ts:376-485`), `/workflow` (chạy graph, `controller.ts:487-616`), `/images` (image gen, `controller.ts:618-743`).

## 3. Abstraction / interface then chốt

- **CopilotProvider** (abstract class, `providers/provider.ts:62-423`): bắt buộc `type`, `models`, `configured()`, `text()`, `streamText()`; mặc định throw `CopilotProviderNotSupported` cho `streamObject/structure/streamImages/embedding/rerank` (`provider.ts:369-422`). Model capability matcher `findValidModel` theo `ModelInputType/ModelOutputType` + online model list (`provider.ts:107-138`). Tự đăng ký vào factory qua event `config.init`/`config.changed` (`provider.ts:82-103`) — cấu hình hot-reload từ `AppConfig` DB.
- **Factory** (`providers/factory.ts:8-78`): registry `Map<CopilotProviderType, CopilotProvider>`, `getProvider()` = first-match qua `match()`; `register()`/`unregister()` bật/tắt feature Copilot.
- **9 provider triển khai**: OpenAI (`openai.ts:89`), Anthropic + Vertex (`providers/anthropic/`), Gemini + Vertex (`providers/gemini/`), fal, perplexity, morph, oracle — danh sách config tại `plugins/copilot/config.ts:80-132`.
- **Tool interface**: dùng trực tiếp `Tool` của Vercel AI SDK (zod `inputSchema` + `execute`), thống nhất qua `createTool()` wrapper để theo dõi usage (`tools/utils.ts:128-162`); danh sách tool name tĩnh `Tools` + type map `CustomAITools` (`tools/types.ts:19-56`). Provider có thể ghi đè tool riêng: `getProviderSpecificTools` (vd `web_search_preview` của OpenAI Responses API, `openai.ts:336-350`).
- **Workflow graph/executor**: graph định nghĩa tĩnh trong code (`workflow/graph/presentation.ts:5-63`; list `WorkflowGraphList`). `WorkflowNode` hỗ trợ `Basic` (1 edge) / `Decision` (condition JS eval, chạy trong Piscina worker khi graph modified, `workflow/node.ts:30-66`) / `Nope`. `WorkflowGraphExecutor.runGraph()` đi từ node `start`, yield `EnterNode/EmitContent/EmitAttachment/ExitNode` (`workflow/workflow.ts:23-96`). Executor plug-in qua registry `AutoRegisteredWorkflowExecutor` (`workflow/executor/utils.ts:5-38`); hiện có `chat-text` (`executor/chat-text.ts:14-97`, gọi `promptService.get(promptName)` + `provider.text/streamText`) và `chat-image`, `check-json`, `check-html`.
- **Prompt scenario system**: `Scenario` map 10 scenario → tên prompt (`prompt/prompts.ts:22-96`); config `copilot.scenarios` cho phép override model toàn scenario (`config.ts:62-79`) — `PromptService.setup()` cập nhật hàng loạt record `ai_prompt` khi boot hoặc config đổi (`prompt/service.ts:35-71`).
- **Embedding/context pipeline**: job BullMQ `copilot.embedding.chats|docs` chunk nội dung (EmbeddingClient gemini-embedding-001, 1024 dims, `embedding/client.ts:25-80`) → ghi vector vào `AiUserChatEmbedding`... (`embedding/job.ts:69-110`). Truy vấn pgvector bằng raw SQL cosine distance `embedding <=> $1::vector` + threshold (`models/copilot-user.ts:294-349`). `CopilotContextService` cache config context trong Redis (`Cache`) và quản lý `ContextSession` thêm/xoá chats/docs/files trong context (`context/service.ts:24-128`, `context/session.ts:16-90`); tool `docSemanticSearch` nối vào đây (`providers/provider.ts:223-235`).
- **TokenTracker**: AsyncLocalStorage context đo token/cost/latency từng bước + toolChain, xuất `TokenSummary` (dùng cho prompt "Summarize the token usage", `providers/token-tracker.ts:24-120`).

## 4. Build system & dependency graph

- **Workspaces** (yarn@4.9.1, `package.json:13-19,64`): `blocksuite/**`, `packages/*/*`, `tools/*`. Script tổng hợp qua CLI nội bộ `oa` (clipanion, `tools/cli/src/oa.ts`): `oa server dev` → nodemon tsx; `dev` chạy đồng thời web + server bằng concurrently (`package.json:24-27`).
- **Server**: build bằng **Rspack** một file `dist/main.mjs` (`packages/backend/server/package.json:11` + `rspack.config.js`); Prisma generate ở postinstall; migration bằng `prisma migrate` + data-migration script.
- **Rust napi**: Cargo workspace gồm `open_agent_server_native` (tiktoken-rs, file-format, v_htmlescape — `packages/backend/native/Cargo.toml:12-20`) và `open_agent_common` (doc_loader pdf/docx/html + splitter tree-sitter nhiều ngôn ngữ — dependency `tree-sitter-*` tại root `Cargo.toml`). Build bằng `@napi-rs/cli` 3.0 với 6 target (`packages/backend/native/package.json` "napi.targets"); wrapper JS `src/native.ts` cache Tokenizer theo model (`native.ts:17-37`). napi v3 beta (`Cargo.toml` root: `napi = "3.0.0-beta.3"`).
- **GraphQL codegen**: `@afk/graphql` đọc schema từ `../../backend/server/src/schema.gql` + documents `.gql` trong `packages/common/graphql/src`, plugin `export-gql-plugin.cjs` export thêm index runtime (`packages/common/graphql/codegen.yml`).
- **Frontend app**: Rspack + React 19 + zustand/swr (`packages/frontend/app/package.json:11-38`). **Electron**: electron-forge + build layer bằng esbuild/tsx scripts; IPC tự quét qua `ipc-scanner.ts`.
- **Graph hướng phụ thuộc (agent)**: `frontend/app → @afk/graphql + @afk/error → server (REST SSE + GraphQL)`; `server/plugins/copilot → base(redis/bullmq/prisma/storage) + models + @afk/server-native(Rust) + ai-sdk/*`; `server-native → open_agent_common(Rust)`.

## 5. Đánh giá kiến trúc

**Điểm mạnh**

1. **Abstraction provider sạch, mở rộng dễ**: `CopilotProvider` + capability matcher + auto register qua config event cho phép thêm provider/API-compatible mới gần như không đụng code controller; hot-reload config không restart (`providers/provider.ts:82-138`, `factory.ts:65-77`).
2. **Pipeline stream thống nhất & có quan sát**: mọi luồng (text/object/image/workflow/tool) đều đi qua Observable RxJS chung, có metric counter từng bước, TokenTracker đo token/latency/toollchain, ping chống timeout, xử lý abort sạch (`controller.ts:175-186,300-369`; `token-tracker.ts`).
3. **Prompt-as-data + workflow đồ thị**: prompt lưu DB (bảng `ai_prompt`) với Mustache param có validate/threshold token; scenario system cho đổi model theo nhóm prompt chỉ bằng config; workflow graph có Decision/executor registry dễ thêm node (`prompt/prompts.ts:22-96`, `workflow/executor/utils.ts:23-38`).

**Điểm yếu**

1. **Coupling vào framework & service locator**: `CopilotProvider` (đáng lẽ là lib thuần) inject trực tiếp 6 dependency NestJS + `moduleRef.get(..., {strict:false})` rải rác trong runtime path (`provider.ts:72-76,171-176,224-229`) — khó unit-test và khó chạy ngoài Nest. Provider importing ngược lên `../tools`, `../context`, `../prompt` tạo vòng phụ thuộc module-internal.
2. **Hard-code tràn lan**: model list gắn cứng trong từng provider class (`openai.ts:92-266`), workflow graph + condition viết bằng JS string/IIFE trong code (`workflow/graph/presentation.ts:29-46`, `node.ts:34`), service có TODO "get workflow from database" (`workflow/service.ts:44`), models chỉ match prefix `'gpt'/'dall'` ở native.ts. `optionalModels` của session bị giới hạn bởi prompt DB — đổi model runtime quanh qual.
3. **Testability/maintainability**: nghiệp vụ lớn nằm trong controllerRxJS khổng lồ (>800 dòng, `controller.ts`), session state mutable + stash-count thủ công (`session.ts:53-99`); test server dùng ava + e2e thật (cần DB/Redis) với rất ít spec cho copilot (`src/__tests__/copilot-provider.spec.ts`, `copilot.spec.ts`, `copilot.e2e.ts` — 3 file cho ~20 tool/provider); logic frontend stream trộn trực tiếp trong zustand store (`session-store.ts:241-309`) thay vì tầng service riêng.

---

# open-agent — Subagent 2: Thuật toán & kỹ thuật cốt lõi

> Phạm vi: `packages/backend/server/src/plugins/copilot/`, Rust native `packages/backend/native` + `packages/common/native`.
> Repo đọc-only (không chạy code). Mọi nhận định kèm `path:line`.

## 1. Token tracking bằng AsyncLocalStorage (`providers/token-tracker.ts`)

**Cơ chế.** `TokenTrackingManager` là singleton giữ một `AsyncLocalStorage<TokenTrackingContext>` (token-tracker.ts:167-169, exported là `TokenTracker` ở :363). Context chứa `{requestId, sessionId, userId, toolChain[], usageRecords[]}` (:184-190).

- `createContext()` dùng `storage.enterWith(context)` (:192) — gắn context vào **async execution hiện tại** thay vì `run()` callback, nên mọi await sinh ra sau đó (cùng "async chain") đều thấy context.
- `runWith(tracker, fn)` (:228-245) bao hàm bằng `storage.run()` và — điểm mấu chốt — **nếu kết quả trả về là async generator/iterable thì wrap lại** để mỗi lần `next()`/`return()`/`throw()` được thực thi bên trong `storage.run(ctx, ...)` (:294-302). Không có wrap này, context sẽ "rơi ra" khi stream chảy qua microtask khác (bởi AsyncLocalStorage chỉ propagate qua async resource được tạo _trong_ context).
- `getOrCreateTracker()` (:207-223): nếu đã có tracker trong context hiện tại thì tái dùng, ngược lại tạo mới với `requestId = sessionId_Date.now()`.

**Tool chain.** `pushTool/popTool` (:108-114) là stack cặp với stack gọi tool: wrapper `createTool` trong `tools/utils.ts:136-159` push tên tool trước khi execute, `recordUsage(step, toolName, duration)` sau đó, pop trong `finally` — bất kể lỗi. `getStepName()` (:116-128) đặt tên step = tool đỉnh stack; đỉnh đầu tiên là `main_request`, nếu depth > 1 thì tiền tố `tool_call:` — cho phép phân biệt call của model chính vs. call trong tool.

**Tổng hợp usage.** `getTotalUsage()` (:47-106) reduce toàn bộ `usageRecords` thành `inputTokens/outputTokens/reasoningTokens/totalTokens/totalWithReasoning` + timing (tổng duration, duration trung bình, số call). Ghi nhận sử dụng 2 đường:

1. `trackAICall()` (:250-281) bọc call đồng bộ có `result.usage`, có nhánh `extractUsage` tùy chỉnh, record cả khi throw (:277).
2. Với stream: `BaseStreamParser.handleFinish()` (providers/utils.ts:413-446) chờ promise `usage` của AI SDK khi stream kết thúc rồi `recordUsage`; `handleError()` (:448-459) record duration-only khi lỗi; `isFinished` chống double-count.

**Trick đáng chú ý:** `statusStreamObject()` (providers/utils.ts:850-867) còn sinh "status object" cuối stream, trong đó `summaryUsage()` (:792-848) gom usage theo model rồi **gọi thêm 1 LLM call với prompt `Summarize the token usage`** để dịch báo cáo token thành câu văn tự nhiên; fail thì fallback chuỗi template tự viết (:836-841).

## 2. Stream processing: tee SSE ↔ DB, buffering, abort

**Tee bằng RxJS `connect` (không phải `share()`).** Trong `controller.ts:317-358` (chatStream): async iterable từ provider được `from()` → `mergeMap(stream => stream)` flatten → `connect(shared$ => merge(brA, brB, ...))`. Nhánh 1: map thành SSE event `{type:'message'}`; nhánh 2: `reduce((acc, chunk) => acc + chunk, '')` nối chuỗi rồi `tap()` push message assistant + `session.save()` và `ignoreElements()` (không phát gì ra ngoài). Cùng một nguồn `shared$` nên DB-branch "ăn theo" SSE mà không tốn 2 call lên model — một biến thể tee thủ công (RXJS `connect` cho phép chủ động subscription thay vì refCount của `share()`). Cùng pattern tại stream-object (controller.ts:416-478, có thêm nhánh 3 phát `statusStreamObject` cuối stream :458-467) và workflow (:530-609) và images (:692-736). Ảnh stream còn tee qua `mergeMap(handleRemoteLink)` (:693) — mỗi link ảnh remote được fetch, hash SHA-256 nội dung làm key blob và lưu lại (storage.ts:84-90).

**Graceful shutdown đếm ngược.** `ongoingStreamCount$` là `BehaviorSubject`; `beforeApplicationShutdown()` chờ đếm về 0 (`filter(count===0), take(1)`) trước khi hoàn tất (controller.ts:75, 86-94, 300, 365).

**Abort detection chuẩn xác ở tầng socket** (`copilot/utils.ts:22-52`): `getSignal(req)` lắng nghe `req.socket` 'end'/'close'; khi close, abort chỉ được coi là **bất thường** nếu `hadError || !hasEnded` (client ngắt đột ngột) (:37); ngược lại là kết thúc bình thường. Controller set cờ `endBeforePromiseResolve` qua `onConnectionClosed(isAborted)` (controller.ts:302-308): nếu abort trước khi buffer Promise resolve thì message lưu DB là chuỗi '> Request aborted' thay vì buffer (controller.ts:341-343) — tránh lưu nội dung dở dang.

**Ping keepalive:** `mergePingStream()` (:175-186) merge interval 5s phát `{type:'ping'}` vào source stream, dừng bằng `Subject` trong `finalize` — chống proxy timeout khi model "suy nghĩ" lâu.

**`ReadableStream.tee()` + TransformStream buffering** (`tools/utils.ts:19-84` — `duplicateToolStream`): stream tool của AI SDK được `ReadableStream.from()` rồi **`.tee()` thành 2 branch** (:25-26). Branch A đi qua `TransformStream` buffer: các `text-delta` nhỏ được cộng dồn vào `pending`, chỉ khi `pending.length >= 16` (MIN_LEN_BUFFER) mới `enqueue` xuống `WritableStream` của tool-result (:28-50), phần dư flush ở `flush()` (:60-68) — giảm số lần ghi/state-update phía client cho từng token. Abort: transform kiểm tra `abortSignal.aborted` → `controller.error()` (:35-38) và `pipeTo(..., {signal, preventClose:true})` (:73-75). Branch B được đọc tuần tự gom full content trả về cho tool (`duplicateStreamObjectStream`, :86-119, dùng `Promise.all([readBranchB, pipelineDone])`).

**mergeStreams thủ công** (`copilot/utils.ts:54-117`): hợp 2 ReadableStream bằng `Promise.race` trên các pending `read()`; xử lý phức tạp việc **dán lại chỉ số** khi một reader kết thúc sớm (splice + remap `idx-1` cho các promise đang treo, :100-105) và `safeReleaseLock` chống double-release (:66-81). Dùng để trộn stream tool-result vào stream chính trong providers.

**Tạo tool wrapper:** `createTool` (tools/utils.ts:128-162) — push/pop toolChain + `runWith` để mọi LLM-call bên trong tool kế thừa tracking context.

## 3. RAG pipeline

### 3.1 Chunking trong Rust native (`packages/common/native/src/doc_loader`)

`Doc::with_options` (doc_loader/document.rs:41-84) định tuyến theo **magic bytes qua `infer`** (4096 byte đầu, :43) rồi theo extension:

- pdf → `pdf-extract` (PlainTextOutput, có nhánh encrypted, loader/pdf.rs:23-46);
- docx → `docx_parser::MarkdownDocument::to_markdown` (loader/docx.rs:6-30);
- html → `readability` extractor (title + text, loader/html.rs:34-43);
- `.md` → `TextLoader` + **`MarkdownSplitter`** (:62-66);
- code `.rs|c|cpp|h|hpp|js|ts|tsx|go|py` → `SourceCodeLoader` + tree-sitter + `TokenSplitter` (:67-76);
- còn lại → text + `TokenSplitter` (:79-81).

**Tree-sitter:** `Cargo.toml` khai báo đủ 11 grammar (c, c-sharp, cpp, go, java, javascript, kotlin-ng, python, rust, scala, typescript — packages/common/native/Cargo.toml:9-21) nhưng `parser.rs` chỉ wire **7 ngôn ngữ** (Rust, C, Cpp, JS, TS-TSX, Go, Python — loader/source/parser.rs:100-115; mapping extension :79-98). Thuật toán: parse AST; nếu file **ít dòng hơn `parser_threshold` (mặc định 1000 dòng, parser.rs:140-151)** → giữ nguyên 1 document; ngược lại duyệt child của root, tách theo `function_item`/`impl_item` thành chunk "functions_impls", các node khác thành "simplified_code" (:155-193). `catch_unwind(AssertUnwindSafe(...))` bao toàn bộ pipeline vì tree-sitter có thể panic (document.rs:92-103).

**Splitters** (bọc crate `text-splitter` features `markdown,tiktoken-rs`): `SplitterOptions` mặc định **chunk_size 7168 token, overlap 128, cl100k_base, trim** (splitter/options.rs:34-43); `ChunkConfig` gắn CoreBPE làm sizer (options.rs:76-87) — tức chunk theo **token thực** (không phải ký tự), MarkdownSplitter ưu tiên split theo heading markdown.

**Post-process JS:** chunk nhóm 128 để gọi embedding batch (`embedding/types.ts:100-105`); Rust `clean_content` (backend/native/src/doc_loader.rs:36 + utils.rs) xóa `\x00`, collapse whitespace, bỏ nhãn "FIGURE 1."/"table 2." đầu đoạn; index được remap về index gốc sau retry (embedding/types.ts:114-137, retry 3 lần).

### 3.2 Embedding + retrieval

- Embedding model mặc định **`gemini-embedding-001`, EMBEDDING_DIMENSIONS = 1024** (embedding/client.ts:25, embedding/types.ts:63).
- Lưu Postgres pgvector: `processEmbeddings` build `'[v1,v2,...]'::vector` bằng Prisma.raw (models/copilot-user.ts:42-57), INSERT với `ON CONFLICT ... DO UPDATE` (upsert, :238-263).
- Truy vấn: `<=>` (cosine distance) `ORDER BY distance ASC LIMIT topK` rồi **filter `distance <= threshold`** ở layer model (copilot-user.ts:288-350). Lưu ý: threshold áp cho **distance** nên 0.85 = similarity ≥ 0.15.
- **Quy trình chuẩn topK×2:** `matchChats/matchDocs/matchFiles` (context/session.ts:155-259) query `topK*2` ứng viên (default topK=5, threshold=0.85) → filter theo context đang bật → `client.reRank(..., topK)`; `matchFiles` (context/service.ts:137-157) tương tự với threshold 0.8. Tool `doc_semantic_search` dùng topK=10, chạy song song 2 nguồn (user-level + context-level) rồi gộp (tools/doc-semantic-search.ts:49-60) và strip các dòng metadata `Title:/Created at:...` đứng đầu chunk (:10-34).

### 3.3 Rerank — 2 tầng, có fallback

`reRank` (embedding/client.ts:141-206):

1. **Dedup** theo `${targetId}:${chunk}` vì cùng chunk có thể thấy ở cả context và workspace (:148-158); sort theo distance tăng dần (:159-171).
2. Gọi provider `rerank` với prompt `'Rerank results'` (client.ts:26, 113-123) — qua `provider.rerank` của **OpenAI provider là một kỹ thuật hiếm: rerank bằng logprob "Yes/No"** (providers/openai.ts:537-606): mỗi chunk được hỏi yes/no với `logprobs:16, maxOutputTokens:16`, tìm logprob token "Yes"/"No" (thử nhiều prefix `'_: . "-\t,(=_“'` vì OpenAI hay chèn khoảng trắng đầu token, :582-593), chuẩn hóa `prob = pYes/(pYes+pNo)` (:598-600).
3. Score cuối = `max(rerankScore, 1 - distance)` (client.ts:126-133) — ghép tín hiệu rerank và cosine similarity.
4. Lọc `score > 0.5`, sort giảm dần, lấy `topK` (:188-201). Bất kỳ sai lệch nào (số rank ≠ số chunk, exception) → fallback về sort theo distance của lớp cha (types.ts:139-149) — thiết kế "best effort, không bao giờ fail retrieval".

### 3.4 Citation format (stream-safe)

`StreamPatternParser` (providers/utils.ts:171-356) là **stateful incremental parser**: buffer chuỗi chưa chắc chắn, nhận diện 3 pattern `[[[n]]]`, `[n]`, `[text](url)`, `([text](url))`; khi thiếu dữ liệu trả `{kind:'needMore'}` và **break, giữ buffer** cho chunk sau (:181-205) — tránh render sai link khi bị cắt giữa chừng. `CitationParser` (:358-403) dựa trên đó: gán mỗi URL mới một số thứ tự, thay bằng `[^n]`, cuối stream `end()` phát dòng footnote `[^n]: {"type":"url","url":"..."}` (JSON-encoded trong footnote markdown, :395-402); với Perplexity thì nguồn từ `sources` của SDK (providers/perplexity.ts:132-139, 172-190). `TextStreamParser` (:492-683) biến reasoning-delta/tool-call thành callout `> ...` với prefix `\n[!]\n`, và ghi chú doc-edit thành footnote `[^editN]: {"type":"doc-edit",...}` (:641-646).

## 4. Hashcash PoW (`packages/common/native/src/hashcash.rs`)

- **Định dạng stamp** chuẩn hashcash v1 7 trường `1:bits:ts:resource:ext:rand:counter` (format() :54-59); `rand` là salt alphanumeric 16 ký tự (:10, :67-72).
- **Mint** (:62-97): thử counter tăng dần, SHA3-256(`challenge:counter`), tới khi hash có **`ceil(bits/4)` ký tự hex '0' đầu** (:85-91) — với bits=20 nghĩa là 5 hex zero = 2^20 hash trung bình (~1M lần băm, chạy ở native/Rust qua napi AsyncTask để không block event loop — backend/native/src/hashcash.rs:52-70).
- **Check** (:36-52): verify `version=="1"`, `bits <= claim`, **resource khớp chính xác**, và chỉ cần `floor(bits/4)` hex zero (:42-48) — mint dùng ceil, check dùng floor: check "dễ" hơn mint tối đa 1 nibble khi bits không chia hết cho 4; với bits=20 hai phía bằng nhau.
- **TTL:** `check_expiration()` parse ts `%Y%m%d%H%M%S` (giây, UTC) và chỉ chấp nhận stamp có tuổi ≤ **5 phút** (checked_add_signed(Duration::minutes(5)) :24-34). Ngoài ra server còn thêm TTL ở tầng DB: challenge token tạo với TTL 5*60s (`captcha/service.ts:89-101`) + resource randomUUID lưu `verificationToken`, dùng 1 lần (get rồi không invalidate lại ở đây — replay được chống bởi TTL ngắn).
- **Anti-abuse flow** (`plugins/captcha/service.ts:111-143`): nếu có `challenge` → verify hashcash (napi `verifyChallengeResponse` native/Task async — backend/native/src/hashcash.rs:16-37); không có thì fallback Turnstile Cloudflare với `idempotency_key` chống replay (:44-79). NAPI binding chạy verify trong threadpool libuv (`AsyncTask`), tránh block event loop Node.

## 5. Workflow engine

**Cấu trúc graph.** `WorkflowNode` (workflow/node.ts:17-164) giữ `edges[]`/`parents[]`; ràng buộc khai báo: Basic chỉ 1 edge (:96-99), Decision phải có condition (:100-104), Nope không được có edge (:105-107). `WorkflowGraphExecutor.runGraph` (workflow/workflow.ts:35-95) là vòng lặp tuần tự đơn node kế node: với mỗi node chạy `next()` generator; `Params`-result được `Object.assign` vào `lastParams` (state truyền qua node, :53-59); `Content` chỉ phát ra stream nếu node là node cuối (`!hasEdges` :62-70) — nội dung node giữa bị nuốt vào `lastParams.content` (:91-93). Node type: Basic chạy executor (chat-text/chat-image/check-html/check-json), Decision chọn edge theo condition, Nope chỉ pass-through content (:148-161).

**Decision condition eval — 2 chế độ an toàn** (node.ts:30-65): condition string được bọc IIFE `return (${condition})(nodeIds, params)` (:34). Nếu `graph.modified` (graph từ nguồn không tin cậy — user-defined): chạy trong **Piscina worker thread** riêng với `env:{}, argv:[], execArgv:[]` (:37-47) và file `worker.mjs` dùng **SES lockdown + Compartment sandbox + harden()** cho nodeIds/params (workflow/worker.mjs) — isolate BOTH khỏi process chính và chống escape global. Nếu graph built-in (không modified): tạo `new Function('nodeIds','params', iife)` trực tiếp (:55-63). Condition trả string = id edge muốn đi; falsy/undefined → mặc định edge đầu (`edges[0]`, node.ts:113-129, 138-147).

**Validators.** `check-json` (executor/check-json.ts:20-38): `JSON.parse` thử/catch → "true"/"false". `check-html` (executor/check-html.ts:28-63): 2 tầng — `XMLValidator.validate` (fast-xml-parser) bắt buộc; nếu `strict` thì thêm `HtmlValidate` chuẩn `html-validate:standard` (:33-44). Kết quả được yield thành `Params` (nếu có `paramKey`) hoặc `Content` (:55-62) — Decision phía sau dùng giá trị này để rẽ nhánh retry loop (ví dụ graph `presentation` step3 quyết định format lại nếu từng dòng JSON không parse được — graph/presentation.ts:31-52).

**Auto-registration:** executor tự đăng ký vào `Map<string, NodeExecutor>` qua `onModuleInit` (executor/utils.ts:19-30) — thêm executor mới không phải sửa registry.

**Graph thực tế:** `presentation` (5 node: sinh ngôn ngữ → sinh slide JSONL → Decision kiểm tra JSON từng dòng → format lại nếu fail), `image-sketch/image-clay` dùng `paramToucher` để biến output node trước thành `controlnets` canny-SDXL (graph/image-filter.ts:8-30). Graph list là hardcode (`getWorkflow` TODO lấy từ DB — workflow/service.ts:44-54).

## 6. Kỹ thuật đáng chú ý khác

- **Session context giờ nhất quán + stash** (`copilot/session.ts`): `ChatSession` giữ `stashMessageCount` đếm message mới trong phiên; `save()` chỉ persist stash (:223-230) và dispose qua `Symbol.asyncDispose` (dùng `await using` — session.ts:53-60, 232-234, comment usage :470-482). `takeMessages()` (:136-158) **cắt history từ cuối theo token budget**: cộng dồn `prompt.tokens` + encode từng message tới `maxTokenSize` (mặc định 128k, :59). `revertLatestMessage` splice từ user-message cuối để hỗ trợ retry (:101-107). Cảnh báo: không có ref-counted LRU session store trong fork này — `ChatSessionService.get()` load thẳng từ DB mỗi request (session.ts:483-494); cache thật duy nhất là `ChatMessageCache` Redis TTL 1h cho submitted message (message.ts:8-26) và config của ContextSession trong Redis (context/service.ts:52-101) — nhận định ngược với đề bài, đã kiểm tra grep `LRU/lru` toàn backend: 0 kết quả.
- **tiktoken native**: `Tokenizer` napi wrap `CoreBPE` (backend/native/src/tiktoken.rs:6-26); gpt-5* → O200kBase; `getTokenEncoder` (server/src/native.ts:19-38) cache theo model trong `Map`, model không-gpt fallback **gpt-4/cl100k**, `dall*` trả null. `ChatPrompt.encode` dùng nó để tính promptTokenSize (prompt/chat-prompt.ts:58-92). Mustache render với `escape` bị vô hiệu hóa (chat-prompt.ts:10) — template prompt không HTML-escape.
- **BullMQ**: tên job `namespace.job` quyết định queue (`namespace()` — base/job/queue/def.ts:37-47, `OnJob` validate ns ∈ {nightly, notification, doc, copilot, indexer}); mặc định **attempts 5, backoff exponential delay 1000ms (2^(attempt-1)×delay)**, `removeOnComplete: true` (cho phép re-add cùng jobId), removeOnFail giữ 1 ngày/500 job (queue/config.ts:28-38). Worker gắn **requestId vào CLS** (`ClsServiceManager` + `CLS_ID`, executor.ts:118-134) để job kế thừa trace context; `JOB_SIGNAL.Retry/Repeat` được xử lý bằng **re-add job với chính opts cũ** (executor.ts:162-175) thay vì cơ chế retry built-in. Cron nightly 00:00 phát job cleanup + generateMissingTitles (copilot/cron.ts:19-33, 47-62); title được sinh bằng LLM prompt 'Summary as title' khi session đủ user+assistant message (session.ts:524-561).
- **Job embedding** (copilot/embedding/job.ts): 3 job `copilot.embedding.{chats,docs,files}` — nội dung chat/doc được đóng gói thành File ảo (tên = title.md, :63-67, 125-128) đi cùng pipeline chunk; lỗi được emit event `user.*.embed.failed` rồi **re-throw cho BullMQ retry** (:99-109).
- **PDF/DOCX extraction:** pdf.rs dùng `pdf_extract` (plaintext, hỗ trợ encrypted với mật khẩu rỗng :31-45); docx.rs `docx_parser` → markdown (giữ cấu trúc heading/table); html.rs `readability` trích main content kèm URL nguồn (html.rs:34-43). Toàn bộ chạy trong `AsyncTask` napi threadpool (backend/native/src/doc_loader.rs:46-75).
- **Provider routing** (providers/factory.ts): chọn provider theo `(outputType, modelId)` từ map per-type (#providers :13); session có thể override model nếu model nằm trong `optionalModels` của prompt (controller.ts:116-119).
- **mimalloc**: toàn bộ native crate dùng `MiMalloc` global allocator (backend/native/src/lib.rs:9-12) — giảm fragmentation cho workload hash/tiktoken cường độ cao.
- **OpenAI rerank logprob** (chi tiết đã nêu 3.3) là kỹ thuật tinh tế nhất repo: dùng chính chat model làm cross-encoder rẻ bằng cách đọc top-logprobs.

## Kết luận nhanh

| Hạng mục      | Điểm mạnh                                   | Rủi ro/trick cần lưu ý                                                                           |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Token tracker | wrap async generator chuẩn ACS              | usage bỏ trống nếu provider không trả `usage` (extractUsage TODO tiktoken, token-tracker.ts:357) |
| Stream tee    | `connect` + reduce 1 lần duy nhất qua model | nhánh DB save lỗi chỉ log, không retry (controller.ts:346-353)                                   |
| RAG           | rerank 2 tầng + fallback an toàn            | threshold áp cho distance (0.85 ≈ sim ≥ 0.15), tree-sitter chỉ 7/11 ngôn ngữ được wire           |
| Hashcash      | mint ceil/check floor, TTL 5 phút kép       | replay chỉ chặn bằng TTL (resource token không bị đánh dấu đã dùng)                              |
| Workflow      | SES sandbox cho condition user-defined      | graph hardcode, condition built-in vẫn `new Function`                                            |
