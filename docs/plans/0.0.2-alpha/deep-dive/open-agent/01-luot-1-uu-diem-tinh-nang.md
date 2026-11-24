# open-agent — Lượt 1: Tổng quan, tính năng & ưu điểm áp dụng

> **Dự án:** AFK-surf/open-agent (fork AFFiNE → agentic AI self-hostable) · Apache-2.0 (LICENSE đã xác minh full text; package.json ghi MIT — mâu thuẫn metadata) · clone: `refer_project/ai-framework/open-agent`
> **Phương pháp:** 2 subagent khảo sát song song 22/11/2026, chỉ đọc mã nguồn (không chạy code repo thứ ba). Subagent 1 = tổng quan & tính năng; Subagent 2 = ưu điểm & áp dụng vào Ghita.

## Tóm tắt nhanh (tổng hợp)

- Fork AFFiNE (NestJS + Postgres/pgvector + Redis + BullMQ + React 19/Rspack + Rust napi) → agentic assistant self-hostable, deploy Docker Compose.
- Giá trị thật ở `packages/backend/server/src/plugins/copilot/` (~46k dòng NestJS): 9 model provider (Vercel AI SDK v5), 16 tool thực thi thật, planner/todo/choose human-in-the-loop, workflow engine đa bước, RAG pgvector có rerank.
- Mức chín: **beta sớm** — self-host thử nghiệm OK, chưa production-stable.
- License Apache-2.0 **an toàn** cho ràng buộc Ghita (cấm GPL/AGPL); lưu ý metadata license bất nhất khi copy code.
- **Top 3 idea cho Ghita:** (1) TokenUsageTracker AsyncLocalStorage → `monitoring`/`ai-engine`; (2) StreamObject protocol 5 loại + `tool-incomplete-result` → `ai-engine`/`communication`; (3) tool `choose` + todo aggregation → `agents`/desktop.

---

# open-agent — Subagent 1: Tổng quan & tính năng

## 1. Dự án là gì

- **Định danh**: "Open-source alternative to Claude Agent SDK, ChatGPT Agents, and Manus" (`README.md:10`). Open-Agent là một agentic AI self-hostable: chat với các model frontier trong khi hệ multi-agent phía server thực thi task thật (tìm web, chạy Python sandbox, điều khiển browser, soạn tài liệu).
- **Ai dùng**: dev/team muốn tự host trợ lý AI agentic (không phụ thuộc SaaS đóng), hoặc lấy làm nền cho agent chuyên dụng của riêng họ (`README.md:16`).
- **Mô hình sử dụng**: deploy qua Docker Compose — copy `.docker/config.example.json` + `.docker/docker-compose.yml`, điền API key vào `config.json`, `docker compose up -d` (`README.md:38-55`). Compose gồm 3 dịch vụ: Postgres **pgvector:pg16**, Redis 7, và image `ghcr.io/afk-surf/open-agent` + job init chạy migrate (`.docker/docker-compose.yml:2-60`). Có thêm client desktop Electron (`dev:electron` script — `package.json:21`).
- **Nguồn gốc quan trọng**: đây là **fork của AFFiNE** (toeverything/AFFiNE) — repo giữ nguyên hạ tầng NestJS/BlockSuite/Prisma của AFFiNE, thay lớp AI thành hệ multi-agent. README thừa nhận "builds upon the ideas of projects like AFFiNE" (`README.md:88`); frontend vẫn kế thừa thư viện `blocksuite` vendored và server version 0.22.4 (`packages/backend/server/package.json:4`).

## 2. Kho tính năng theo chủ đề

### 2.1 Orchestration multi-agent (backend `plugins/copilot`)

- **Chat session engine**: `ChatSession` quản lý context, stash message, auto-generate title qua BullMQ job `copilot.session.generateTitle` (`packages/backend/server/src/plugins/copilot/session.ts:54-60`).
- **Prompt library**: >70 prompt template chia theo 8 scenario (chat, image, coding, workflow, quick_decision_making...) (`.../copilot/prompt/prompts.ts:22-96`); prompt chat chính "Chat With Open-Agent" mặc định `claude-sonnet-4@20250514`, optional: gpt-4.1/gpt-5/o3/o4-mini/gemini-2.5-* (`prompts.ts:2107-2118`).
- **16 công cụ agent** (`.../copilot/tools/index.ts:1-17`): `browser_use` (cloud browser-use.com, trả screenshots/GIF/steps — `tools/browser-use.ts:7-9`), `e2b_python_sandbox` (E2B), `web_search_exa` + `exa_crawl`, `cloudsway_search/read`, `code_artifact`, `make_it_real` (sinh HTML đẹp), `python_coding`, `doc_compose`, `doc_semantic_search` (RAG trên workspace), `task_analysis`, `create_todo`, `choose`, `conversation_summary`.
- **Planner**: tool `task_analysis` dùng structured output (zod) trả về `needsPhases / complexity / estimatedSteps / todoList (step, dependencies, requiredTools)` (`tools/task-analysis.ts:13-29`).
- **Workflow engine**: graph + executor (`workflow/graph/presentation.ts`, `workflow/executor/chat-text|chat-image|check-html|check-json.ts`) chạy chuỗi step `workflow:presentation:step1..4`, `workflow:brainstorm:*` (`prompts.ts:50-64`); expose qua SSE `/chat/:sessionId/workflow` (`controller.ts:487`).
- **Tool wiring động**: tools truyền qua query hoặc `session.config.promptConfig.tools` khi gọi stream (`controller.ts:250-324,408-423`).

### 2.2 Model providers

- 9 loại provider trong enum (`providers/types.ts:8-17`): OpenAI, Anthropic (official + Vertex), Gemini (generative + Vertex), Perplexity, FAL (ảnh), Morph (apply code), **Oracle** (Oracle Cloud Generative AI — map `grok4-oracle` → model OCID, `providers/oracle.ts:46-50`).
- Dùng **Vercel AI SDK v5** (`ai@^5`, `@ai-sdk/*` — `packages/backend/server/package.json`); base class `CopilotProvider` với `streamText/streamObject` (`providers/provider.ts:363-369`); factory chọn provider theo model (`providers/factory.ts:15-42`); có `token-tracker.ts` đo usage theo tool call.
- Config API key qua `config.json`: openai/anthropic/gemini/perplexity/morph/fal/geminiVertex/anthropicVertex + exa/browserUse/e2b/unsplash/R2 storage (`.docker/config.example.json:29-72`).

### 2.3 UI (web + desktop)

- Web app React 19 + Rspack + Tailwind 4 + zustand + react-router 7 (`packages/frontend/app/package.json:17-42`).
- Trang chính: `home.tsx`, `chats/chat.tsx`, `chats-dashboard.tsx`, `chat-playback.tsx`, `doc-page.tsx`, `library-dashboard.tsx`, `sign-in.tsx`, `magic-link.tsx`, onboarding (`packages/frontend/app/src/pages/`).
- **Renderers cho từng tool result**: browser-use-result, e2b-python-result, code-artifact-result, todo-list-result, choose-result, task-analysis-card, web-search-result, ai-reasoning-card... (`app/src/pages/chats/renderers/`) + `aggregated-todo-list.tsx` hiển thị tiến độ nhiều bước (`components/chat/`).
- Streaming qua SSE `EventSource` → async iterator (`app/src/store/copilot/event-source.ts:31`); client GraphQL đóng gói mutations/queries copilot (`app/src/store/copilot/client.ts:5-27`).
- Desktop Electron (electron-forge, maker NSIS/dmg/deb/flatpak — `packages/frontend/electron/package.json:9-20`).

### 2.4 Persistence

- **PostgreSQL + pgvector**, 23 Prisma models, phần lớn cho AI: `AiSession`, `AiSessionMessage`, `AiContext`, `AiContextEmbedding`, `AiUserDocEmbedding`, `AiUserFileEmbedding`, `AiPrompt`, `AiJobs`... (`packages/backend/server/schema.prisma`).
- **Redis**: cache, BullMQ job queue, socket.io adapter, rate limiter, mutex (`app.module.ts:27,29`).
- **Blob storage S3-compatible** (mặc định Cloudflare R2 — `config.example.json:61-70`).
- Embedding client + cron job nhét RAG cho user docs/files (`copilot/embedding/`, `copilot/workspace/`).

### 2.5 Auth & quota

- Đăng ký/đăng nhập password, magic link qua email SMTP, OAuth Google + GitHub, captcha plugin (`core/auth/service.ts:68-83`, `plugins/oauth/`, `config.example.json:2-11`).
- Feature/quota gating: `FeatureModule`, `QuotaModule` (`copilot/index.ts:38`); frontend map lỗi 402 → `PaymentRequiredError` (`app/src/store/copilot/client.ts:51`).
- Observability: OpenTelemetry (Google Cloud Trace, Prometheus, Zipkin), BullMQ job, throttler (`server/package.json` deps, `app.module.ts:24,29`).

### 2.6 CLI / API surface

- **REST SSE**: `/api/copilot/chat/:sessionId/stream | stream-object | workflow | images`, `/unsplash/photos`, `/blob/:userId/:key` (`plugins/copilot/controller.ts:72,278,376,487,618,745`).
- **GraphQL (Apollo)**: `CopilotResolver`, `UserCopilotResolver`, `PromptsManagementResolver`, context resolvers (`copilot/index.ts:66-68`), schema tại `server/src/schema.gql`.
- **CLI**: `oa` (tools/cli — init/build/dev/run, `tools/cli/src/oa.ts`), server CLI bằng nest-commander (`server/src/cli.ts:2-9`), server-native Rust build qua `yarn oa @afk/server-native build` (`tools/public/dev.md:74`).

## 3. Trạng thái dự án

| Hạng mục                  | Bằng chứng                                                                                                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **License**               | Apache-2.0, full text tại `LICENSE:1-40`; README xác nhận (`README.md:95`). ⚠️ Không khớp: `package.json:5` khai `"license": "MIT"`                                                                                                                                                  |
| **Ngôn ngữ/stack**        | TypeScript (NestJS 11 + AI SDK v5 backend; React 19 frontend), Rust (napi 3 beta, edition 2024 — `Cargo.toml:1-6,39`) cho native: pdf-extract, docx-parser, tree-sitter 11 ngôn ngữ, tiktoken, audio capture                                                                         |
| **Kích thước**            | Toàn repo: 3.297 file TS/TSX/RS ≈ 369k dòng. Riêng `packages/` (không tính blocksuite): 816 file ≈ 90k dòng — backend/server 350 file ≈ 45,7k dòng, frontend/app 129 file ≈ 13,8k dòng, native Rust 28 file ≈ 1,7k dòng; `blocksuite/` vendored: 2.675 file                          |
| **Cấu trúc top-level**    | `packages/backend/{server,native}`, `packages/frontend/{app,component,electron,electron-api}`, `packages/common/{debug,env,error,graphql,native}`, `blocksuite/`, `tools/{cli,public,changelog}`, `.docker/`, `.github/workflows` (build-images, copilot-test, release...)           |
| **Trạng thái phát triển** | Young/early: version 0.1.0 (`package.json:3`), image mặc định tag `canary` (`docker-compose.yml:34`), lịch sử git chỉ 1 commit squash "2025-10-10 Update README.md" (fork reset). CI đầy đủ: build images lên ghcr.io/afk-surf/open-agent (`.github/workflows/build-images.yml:189`) |

## 4. Năm điểm độc đáo nhất

1. **Multi-model collaboration đặt làm trung tâm**: một session cho phép model mặc định + `optionalModels` xuyên provider (Claude/GPT/Gemini/grok4-via-OCI), chọn provider runtime qua factory — không khóa vào một nhà cung cấp (`prompts.ts:2107-2118`, `providers/types.ts:8-17`, `oracle.ts:46-50`).
2. **Human-in-the-loop là tool citizen**: tool `choose` buộc agent dừng đưa lựa chọn cho user quyết (`tools/choose.ts:5-31`), kết hợp `task_analysis` trả plan có dependency graph và `create_todo` render thành todo-list UI đồng bộ (`tools/task-analysis.ts:13-29`, `tools/todo.ts:22-38`, `renderers/choose-result.tsx`, `aggregated-todo-list.tsx`) — đúng triết lý "Stop prompt-chasing. Start decision-making" (README:27).
3. **Workflow engine declarative**: step AI được khai báo như prompt (`workflow:*:step1..4`) + graph (`workflow/graph/presentation.ts`) + executor có validator (`check-html`, `check-json`) — pipeline đa bước (tạo presentation, mindmap, ảnh style-transfer) chạy server-side, stream về client qua SSE riêng (`controller.ts:487`).
4. **Agent gắn với workspace tài liệu thực sự**: RAG pgvector trên docs/files (`AiUserDocEmbedding`, `AiUserFileEmbedding` — schema.prisma), tool `doc_compose`/`doc_semantic_search`, hệ citation `[^1]:{"type":"doc","docId":...}` bắt agent trích dẫn nguồn workspace/web có cấu trúc (`prompts.ts:2144-2172`).
5. **Fork AFFiNE dùng làm đòn bẩy**: kế thừa hạ tầng production-grade (auth, quota, OTel, BullMQ, socket.io, BlockSuite editor vendored) để sản phẩm agent đi nhanh; kèm Rust native (tree-sitter chunking 11 ngôn ngữ, pdf/docx extract) cho embedding chất lượng (`Cargo.toml:74-85`).

## Kết luận 3 dòng

Open-Agent là fork AFFiNE biến hạ tầng ghi chú thành agentic AI assistant self-hostable, phần giá trị thật nằm ở backend copilot (~46k dòng NestJS): 9 model provider qua AI SDK v5, 16 tool thực thi thật, planner/todo/choose hướng con người ra quyết định, và workflow engine đa bước. Tài liệu mỏng và code nhiều phần thừa kế AFFiNE chưa dọn, license khai báo bất nhất (Apache-2.0 trong LICENSE/README nhưng MIT trong package.json), lịch sử commit bị squash — dấu hiệu dự án trẻ. Mức chín: **beta sớm, dùng được để self-host thử nghiệm và làm nền fork, chưa phải production-stable**.

---

# open-agent — Subagent 2: Ưu điểm & áp dụng vào Ghita

**Tổng quan thực địa:** repo là fork/tiếp biến của nền tảng AFFiNE: backend NestJS (`packages/backend/server`) + 2 crate napi Rust (`backend/native`, `common/native`) + frontend React/Rspack (`packages/frontend/app`) + Electron (`packages/frontend/electron`). Logic "multi-agent" nằm ở `packages/backend/server/src/plugins/copilot/` (providers, tools, workflow, context, transcript, embedding).

## 1. Ưu điểm nổi bật (xếp theo giá trị)

1. **Request-scoped token/cost tracking xuyên suốt bằng AsyncLocalStorage** — `TokenTrackingManager` dùng `AsyncLocalStorage` để theo dõi usage theo requestId, push/pop `toolChain` đặt tên step (`main_request` → `tool_call:<tool>`), bọc cả async generator để context không mất qua stream (`packages/backend/server/src/plugins/copilot/providers/token-tracker.ts:167-303`), tổng hợp input/output/reasoning tokens + thời gian trung bình mỗi call (:47-106).
2. **Tee stream RxJS: 1 nhánh SSE cho client, 1 nhánh persist DB** — `connect(shared$ => merge(...))` phát event tới client và đồng thời reduce toàn văn bản để lưu session; xử lý abort (`endBeforePromiseResolve`) và ping keep-alive (`.../copilot/controller.ts:317-369`, `:416-480`).
3. **Stream kết quả agent lồng nhau ra UI ("tool-incomplete-result")** — `duplicateToolStream` dùng `ReadableStream.tee()`: nhánh A forward delta của model-con (sub-agent trong tool) về frontend, nhánh B trả kết quả đầy đủ cho agent cha (`.../copilot/tools/utils.ts:19-119`).
4. **Giao thức stream chuẩn hoá, merge ở client** — `StreamObjectSchema` là discriminated union 5 loại: `text-delta`, `reasoning`, `tool-call`, `tool-result`, `tool-incomplete-result` (`packages/frontend/app/src/store/copilot/session-store.ts:18-45`); reducer `mergeStreamObjects` gộp delta, ghép `mark_todo` vào `todo_list` cũ theo id, xóa placeholder tool-call (`.../store/copilot/utils.ts:89-207`).
5. **Provider registry theo capability** — `CopilotProviderFactory.getProvider(cond, {prefer})` chọn provider bằng `provider.match(cond)` theo outputType/model, đăng ký/hủy động (`.../copilot/providers/factory.ts:15-69`); hỗ trợ OpenAI/Anthropic/Gemini/Perplexity/fal/morph/oracle.
6. **Prompt-as-data + scenario override hot-reload** — prompt lưu DB (Prisma), gán vào 9 scenario (`chat`, `coding`, `complex_text_generation`...) trong `.../copilot/prompt/prompts.ts:22-96`; đổi model theo scenario qua event `config.changed` không cần restart (`.../copilot/prompt/service.ts:28-48`).
7. **Context engineering có thật: pgvector + rerank + threshold** — embedding `vector(1024)` đánh index trong Postgres (`packages/backend/server/schema.prisma:11,251,259`), retrieval topK*2 rồi rerank về topK, threshold 0.85 có chú thích "based on prior experiments" (`.../copilot/context/session.ts:190-259`).
8. **Quản lý nhiều session phía client bằng ref-counted registry** — `createRefCounter` với `maxCacheSize: 10`, acquire/release store per-session,preload meta khi tạo mới (`.../store/copilot/sessions-store.ts:48-115`).
9. **Human-in-the-loop dạng tool + todo aggregation** — tool `choose` trả options cho user chọn (`.../copilot/tools/choose.ts:5-31`); frontend trích tất cả todo từ streamObjects và nhóm theo trạng thái (`.../store/copilot/utils.ts:16-87`).
10. **DX tốt:** GraphQL client typed bằng codegen từ file `.gql` versioned (`packages/common/graphql/src/graphql/copilot-session-create.gql`...), CLI monorepo tự viết `oa`/`r` chạy script theo package + dependency (`tools/cli/src/oa.ts:1-35`, `run.ts`), lint-staged chạy cả `cargo fmt` (`package.json:44-53`), 53 spec/e2e test qua vitest workspace.

## 2. Cái hay áp dụng được vào Ghita Agent

| #   | Idea                                                                                      | Kỹ thuật                                                                       | Mapping Ghita                                                                           | Giá trị    | Độ khó |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------- | ------ |
| 1   | TokenUsageTracker dạng AsyncLocalStorage + toolChain                                      | Bọc wrap async generator, record per-step model/duration/reasoning             | `packages/monitoring` + `ai-engine` (mỗi agent run = 1 context; báo cáo cost cuối turn) | Cao        | Dễ     |
| 2   | Giao thức StreamObject 5 loại + reducer merge phía client                                 | Zod discriminated union; merge delta + tool placeholder                        | `communication` (wire protocol desktop↔mobile↔engine) + `ai-engine`                     | Cao        | Trung  |
| 3   | Tee stream: UI nhận delta của model-con trong tool call (`tool-incomplete-result`)        | `ReadableStream.tee()` + TransformStream buffer 16 ký tự                       | `ai-engine` + `agents` + UI `apps/desktop`                                              | Cao        | Trung  |
| 4   | `choose` tool human-in-the-loop + todo aggregate                                          | Tool trả options; UI render, user chọn rồi resume                              | `agents` + `apps/desktop` (thay cho confirm dialog cứng)                                | Cao        | Dễ     |
| 5   | Provider factory `match(cond)` + `prefer`                                                 | Registry + capability query theo outputType/model                              | `ai-engine` (router chọn model local/cloud)                                             | Cao        | Dễ     |
| 6   | Retrieval context: embedding → topK*2 → rerank → threshold                                | pgvector; Ghita thay bằng SQLite-vec/`crates/retrieval`                        | `memory` + `crates/retrieval`                                                           | Trung–Cao  | Trung  |
| 7   | Rust doc_loader: docx/pdf/html/source-code (tree-sitter) + MarkdownSplitter/TokenSplitter | napi addon, mimalloc (`packages/common/native/src/doc_loader/`)                | `crates/docloader` (Ghita đã có crate — so sánh thiết kế Chunk{index,content})          | Trung      | Dễ     |
| 8   | Workflow Decision node chạy condition trong Piscina worker với `env:{}, argv:[]`          | Sandbox eval dynamic condition (`.../workflow/node.ts:37-53`)                  | `agents` (nếu có graph/skill chạy động)                                                 | Trung      | Trung  |
| 9   | Ref-counted session store LRU (max 10) phía client                                        | `createRefCounter` + acquire/release                                           | `apps/desktop` state (nhiều conversation song song)                                     | Trung      | Dễ     |
| 10  | Hashcash PoW anti-abuse cho API cục bộ                                                    | SHA3-256, 20 bits, TTL 5 phút (`packages/common/native/src/hashcash.rs:36-52`) | `security`/`communication` (bảo vệ local server/mobile bridge)                          | Thấp–Trung | Dễ     |

## 3. Hạn chế / rủi ro khi áp dụng

- **License — đã xác minh:** tệp `LICENSE` (dòng 1–4) là **Apache-2.0** thật (full text), README badge khớp (`README.md:8`). KHÔNG phải GPL/AGPL → an toàn cho ràng buộc của Ghita. Nhưng lưu ý 2 điểm: (a) root `package.json:5` khai báo `"license": "MIT"` — **mâu thuẫn metadata** giữa package.json và LICENSE; nếu copy code phải giữ Apache-2.0 + NOTICE/patent grant; (b) đã quét `yarn.lock` và `Cargo.lock`: không thấy dependency nào khai báo GPL/AGPL.
- **Kiến trúc lệch pha:** open-agent là server-centric (NestJS + Postgres/pgvector + Redis + Stripe + mailer + Docker, thấy ở `dev.md` và `schema.prisma`). Ghita local-first → phải thay SSE bằng Tauri IPC, Prisma/pgvector bằng SQLite + crate `store`/`retrieval`; không thể "copy nguyên cụm", chỉ lấy pattern.
- **Injection risk trong workflow:** condition của Decision node là chuỗi IIFE eval bằng `new Function` ngay trong process chính khi `!graph.modified` (`.../workflow/node.ts:34,55-58`); worker sandbox chỉ áp dụng khi graph bị sửa. Nếu Ghita có graph user-editable phải dùng typed condition, không eval string.
- **Code thiếu nhất quán:** comment tiếng Trung lẫn trong production code (`token-tracker.ts:159,357`); tool stream lỗi chỉ log warn (`tools/utils.ts:76-80`); nhánh persist DB trong SSE lỗi chỉ `.catch(err => logger.error)` (`controller.ts:346-353`) — mất tin nhắn âm thầm nếu DB fail.
- **`stream-messages.ts` là code demo giả lập** (`packages/frontend/app/src/lib/stream/stream-messages.ts:13-15,70` — `randomDelay(500,1000)` từng ký tự) nằm trong cây production; tham khảo ý tưởng immutable-frame nhưng không nên giữ trong runtime.

## 4. 3 thứ KHÔNG nên học

1. **Stack server nặng (Postgres + Redis + NestJS + GraphQL + Stripe) cho một agent local** — quá mức cần thiết cho desktop/mobile local-first; Ghita giữ SQLite + IPC riêng tư.
2. **Metadata license tự mâu thuẫn** (package.json "MIT" vs LICENSE Apache-2.0) — Ghita phải đảm bảo package.json/LICENSE/LICENSE-THIRD-PARTY khớp 100%.
3. **Eval chuỗi động làm điều kiện điều khiển luồng + demo code trộn vào production tree** — vừa là surface bảo mật vừa làm rối repo; điều kiện nên là hàm typed có đăng ký, demo tách biệt.

## Top 3 idea đáng áp dụng nhất

1. **TokenUsageTracker với AsyncLocalStorage + toolChain push/pop** (→ `monitoring` + `ai-engine`) — quan sát được cost/latency của mọi sub-call trong một agent run, giá trị/công suất đầu tư cao nhất. Cao / Dễ.
2. **Giao thức StreamObject 5 loại + `tool-incomplete-result` + reducer merge phía client** (→ `ai-engine`, `communication`, UI desktop) — chuẩn hoá streaming agent lồng nhau giữa Rust engine, desktop và mobile. Cao / Trung.
3. **Tool `choose` + todo aggregation cho human-in-the-loop** (→ `agents` + `apps/desktop`) — biến "hỏi user" và "danh sách việc cần làm" thành tool-first, UI tự tổng hợp trạng thái từ stream. Cao / Dễ.
