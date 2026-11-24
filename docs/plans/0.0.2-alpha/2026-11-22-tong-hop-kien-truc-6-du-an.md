# Tổng hợp kiến trúc — cái hay từ 6 dự án tham khảo, rút vào thành phần hiện có của Ghita

> **Ngày:** 22/11/2026 · **Nguồn:** 12 tài liệu deep-dive tại `docs/plans/0.0.2-alpha/deep-dive/` (24 subagent chỉ đọc, mọi nhận định có path:line) — open-agent · node-pty · better-harness · nut-js · AgentEnv · ds2api
> **Bản chất tài liệu:** TỔNG HỢP KIẾN THỨC cho bản v0.0.2-alpha — không phải kế hoạch track. Mỗi insight ghi: nguồn → bản chất kỹ thuật → rút vào thành phần cũ nào của Ghita.
> **Cách đọc:** Phần A gom cái hay theo 8 chủ đề kiến trúc (không theo dự án). Phần B bảng mapping vào thành phần hiện có. Phần C gom riêng phần Rust. Phần D nguyên tắc "không học".

---

## Phần A — 8 chủ đề kiến trúc

### A1. Lớp canonical request — N×M → N+M (ds2api, open-agent)

- ds2api: `StandardRequest` canonical (`promptcompat/standard_request.go:5`) — N surface adapter (openai/claude/gemini/ollama) chỉ parse/render, mọi business nằm 1 code-path; Claude/Gemini delegate qua OpenAI handler (`server/router.go:68-70`); error normalize 1 shape.
- open-agent: provider factory `getProvider(cond, {prefer})` chọn theo capability `provider.match(cond)` (outputType/model), đăng ký/hủy runtime (`providers/factory.ts:15-69`).
- **Rút vào:** `packages/ai-engine` (~25 provider đang N×M) — chuẩn hoá StandardRequest + AgentError + registry capability-match.

### A2. Quan sát & đo lường một run (open-agent)

- `TokenTrackingManager` AsyncLocalStorage theo requestId, push/pop toolChain (`main_request` → `tool_call:<tool>`), bọc wrap `next/return/throw` của async generator để context sống qua stream, tổng hợp token/latency per step (`providers/token-tracker.ts:167-303`).
- Tee stream RxJS: 1 nhánh SSE cho client + 1 nhánh reduce persist DB, xử lý abort + keep-alive ping (`copilot/controller.ts:317-369`).
- **Rút vào:** `packages/monitoring` + `packages/ai-engine` (báo cáo cost/latency cuối mỗi turn) + `packages/communication`.

### A3. Giao thức stream chuẩn hoá (open-agent, ds2api)

- StreamObject 5 loại (text-delta/reasoning/tool-call/tool-result/tool-incomplete-result) discriminated union + reducer merge client gộp delta theo id (`session-store.ts:18-45`, `store/copilot/utils.ts:89-207`).
- `tool-incomplete-result`: `ReadableStream.tee()` — nhánh A forward delta model-con trong tool về UI, nhánh B trả kết quả đầy đủ cho agent cha (`tools/utils.ts:19-119`).
- ds2api: SSE micro-batch 16 ký tự/10ms với 3 buffer (text/thinking/toolDetection) + timer stop-drain-reset; keep-alive/idle-timeout; replay dedupe HasPrefix 2 chiều (`sse/stream.go`, `internal/stream/engine.go:45-139`, `sse/dedupe.go`).
- **Rút vào:** `packages/communication` (wire protocol desktop↔mobile), `packages/ai-engine` (stream engine), UI desktop.

### A4. PTY & terminal (node-pty)

- KHÔNG dùng node-pty trực tiếp (Tauri = Rust, addon Node không nhúng được) — dùng crate **portable-pty** (MIT, wezterm).
- 5 pattern ConPTY đáng port: (1) 2-phase init + drain-before-close (reader conout trên thread riêng, flush đuôi trước ClosePseudoConsole — chống deadlock, được chứng minh bằng ETW); (2) kill-tree console-aware `FreeConsole→AttachConsole→GetConsoleProcessList` + guard race PID-reuse (upstream còn race chưa fix); (3) resize có pixel size; (4) exit thống nhất `{exitCode, signal}`; (5) escape commandline chuẩn `CommandLineToArgvW`.
- **Rút vào:** crate mới `crates/pty` + `apps/desktop` terminal (xterm.js UI) qua Tauri command.

### A5. Sandbox & environment (AgentEnv — MIT)

- Trait `SandboxBackend`/`Factory` + hợp đồng lỗi `Recoverable/Terminal` (`backend.rs:172,49-69`) — tách policy khỏi enforcement backend.
- State machine CAS: 8 trạng thái + `update_state_if_state` chống race (`types.rs:56-66`).
- Overlay rollback: phần write nằm thư mục upper/, rollback = bỏ upper, commit = merge về base — thay thế cho LSMT/ublk (Linux-only) trên Windows; sửa `restrict_writes` no-op tại `windows.rs:25-28`.
- Job Object limits: memory + IO rate token bucket (trick sentinel bucket(0,0) xoá limit) + TTL auto-kill (BTreeSet expiry index) + audit hooks.
- **Rút vào:** `crates/sandbox` v2 + `packages/security` (audit hooks).

### A6. Desktop automation (nut-js)

- Path chuột Bresenham variant error-accumulator (`bresenham.class.ts:4-63`) + easing timesteps (`mouse-movement.function.ts:15-31`).
- `validateSearchRegion` chặn âm/NaN/<2px/vượt màn hình (`screen.class.ts:39-84`) + waitFor poll có AbortSignal + lưu lastRejectionReason.
- Window clamp tràn màn hình/maximized (`window.class.ts:43-71`); MatchRequest `{haystack, needle, confidence, providerData}` generic.
- Registry provider `hasX()` capability probe + Noop fallback; tránh busy-wait chặn event loop (anti-pattern của nut-js).
- **Rút vào:** `packages/computer-use` (grounding hiện theo pattern UI-TARS).

### A7. Evaluation & harness (better-harness — MIT)

- 7 evidence states làm trần 59/74/84/94/100; machine score = **trung bình deterministic** Present40/Wired60/Exercised75/Outcome90 (`fluency-dimensions.mjs:28-90`, `models/agent-work-loop.md:111-118`).
- Nguyên tắc gốc: "score never creates or suppresses a finding" — ⚠️ **Ghita đang vi phạm**: `ceiling − findings×6/8` (`packages/agents/src/harness/work-loop.ts:127-134`).
- Finding emission bar (emit chỉ khi inspected gap + bounded impact + smallest-owner repair + validation route); consistency gate score<70 ⇔ có finding (reverse-link 2 chiều).
- Intervention Ledger: 5-state machine, primary≠guardrail metric direction-aware, improving/outcome-supported cấm guardrail xấu đi.
- Privacy sanitizer cho evidence bundle; evidence freeze-context.
- **Rút vào:** `packages/agents/src/harness` + `packages/evals`.

### A8. Resilience & credentials (ds2api, open-agent)

- Account pool: rotate-on-acquire + FIFO waiter (close-channel wakeup đơn lẻ) + cap per-account/global + exclude-set khi switch (`account/pool_acquire.go:49-92`).
- FailureKind taxonomy + retry thang: empty → synthetic follow-up (max 1); 429 → switch-account đúng 1 lần; content_filter không retry (`client/errors.go:8`, `completionruntime/stream_retry.go`).
- Auto-continue stream splice ≤8 round, nuốt `[DONE]` giữa stream (`client_continue.go`).
- Tool `choose` human-in-the-loop (`tools/choose.ts:5-31`) + todo aggregation UI tự tổng hợp trạng thái từ stream.
- Hashcash PoW SHA3-256, mint/check lệch 1 nibble + TTL kép (`hashcash.rs:36-52`) — cho local API bridge.
- ⚠️ Không học: automate login + TLS fingerprint spoof (vi phạm ToS).
- **Rút vào:** `packages/ai-engine` (pool/retry/AgentError), `packages/agents` + desktop (choose/todo), `packages/security`+`communication` (PoW).

## Phần B — Mapping "rút vào" thành phần cũ của Ghita

| Thành phần hiện có                     | Insight rút vào                                                                                          | Nguồn                       | Giá trị    | Độ khó   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------- | ---------- | -------- |
| `crates/sandbox`                       | Trait backend + CAS state machine + overlay-dir rollback + Job Object limits + TTL                       | AgentEnv                    | Cao        | Trung    |
| `crates/pty` (mới)                     | portable-pty + 5 pattern ConPTY                                                                          | node-pty                    | Cao        | Trung    |
| `crates/docloader`                     | Đối chiếu thiết kế Chunk{index,content} + Markdown/TokenSplitter                                         | open-agent                  | Thấp       | Dễ       |
| `crates/retrieval` + `packages/memory` | Retrieval topK*2 → rerank logprob Yes/No → score max(rank, 1−distance) → lọc 0.5 → topK                  | open-agent                  | Trung      | Trung    |
| `packages/ai-engine`                   | StandardRequest + AgentError + provider capability registry + credential pool/retry thang + TokenTracker | ds2api + open-agent         | Cao        | Trung    |
| `packages/communication`               | StreamObject 5 loại + micro-batch + reducer merge client                                                 | open-agent + ds2api         | Cao        | Trung    |
| `packages/agents`                      | Fix scoring work-loop + choose tool + todo aggregation                                                   | better-harness + open-agent | Cao        | Dễ→Trung |
| `packages/evals`                       | 7 evidence states + consistency gate + emission bar + privacy sanitizer                                  | better-harness              | Cao        | Dễ→Trung |
| `packages/monitoring`                  | TokenUsageTracker + báo cáo cost cuối turn                                                               | open-agent                  | Trung      | Dễ       |
| `packages/computer-use`                | Bresenham+easing, validateSearchRegion, AbortSignal, window clamp, MatchRequest                          | nut-js                      | Trung      | Dễ       |
| `packages/security`                    | Hashcash PoW + audit hooks sandbox                                                                       | open-agent + AgentEnv       | Thấp–Trung | Dễ       |
| `apps/desktop`                         | Terminal PTY (xterm.js) + choose UI + todo aggregation                                                   | node-pty + open-agent       | Cao        | Trung    |

## Phần C — Rust ("rút vào" crates)

1. **`crates/pty` (mới):** wrap portable-pty (MIT) + 5 pattern ConPTY → napi addon + Tauri command cho terminal desktop.
2. **`crates/sandbox` v2:** trait `SandboxBackend` + CAS + overlay-dir rollback + Job Object limits + TTL auto-kill — sửa `windows.rs:25-28`.
3. **`crates/docloader`:** đối chiếu thiết kế chunk của open-agent (`packages/common/native/src/doc_loader/` — tree-sitter, Markdown/TokenSplitter) với crate hiện có.
4. **Không port (Linux-only hoặc anti-pattern):** LSMT/ublk/Firecracker (AgentEnv), busy-wait (nut-js), eval chuỗi động (open-agent).

- Mọi addon mới đi đúng pattern hiện có: feature `addon` + `src/napi.rs`, build `scripts/build-native.mjs`, nạp `packages/native-bridge` `loadNative(name, fallback)` với JS fallback bắt buộc.

## Phần D — Nguyên tắc học / không học (từ 6 dự án)

**Không học (anti-pattern hoặc rủi ro):**

- open-agent: stack server nặng (Postgres+Redis+NestJS+Stripe) cho agent local; metadata license tự mâu thuẫn; eval chuỗi động `new Function` điều khiển luồng; demo code trộn production tree; DB-save lỗi chỉ log.
- nut-js: busy-wait chặn event loop; side-effect require lúc import; registry singleton side-effect; minimize/restore stub throw.
- ds2api: automate login + TLS fingerprint spoof (vi phạm ToS); keyword-based error detection (giòn); `map[string]any` mất type-safety; handleStreamWithRetry ~15 tham số rời.
- AgentEnv: tầng storage đồ sộ; control plane phân tán; tư thế no-auth (API không authorization).
- node-pty: deprecated API surface (fork/createTerminal/open); 1 thread chặn mỗi PTY đợi exit; pipe name `Math.random()`.
- better-harness: hệ 11 host adapters; văn bản điều lệ ultra-dense; schema findings.json sở hữu phân tán (template v25 vs code v26).

**Clean-room với AGPL (ds2api):** ghi mô tả thiết kế (chính là các mục A1/A3/A8 ở trên) → viết lại từ mô tả, không đọc chuỗi code khi viết code Ghita.

## Phần E — Khi muốn triển khai

Tài liệu này là kho kiến thức, không phải plan track. Khi owner muốn hiện thực hoá mục nào, chọn từ Phần B → lập mini-plan riêng theo đúng quy ước chu kỳ (P0 verify nền → thiết kế → code → gates: typecheck/lint/turbo test/knip/cargo test/clippy −D warnings, native-first + JS fallback, KHÔNG commit/push tự ý — tham khảo quy ước trong `2026-11-14-v0.0.2-preview-deep-integration.md` mục Global Constraints).

**Đề xuất thứ tự nếu triển khai dần** (theo giá trị/độ khó từ Phần B):

1. S1: fix scoring work-loop (Dễ, giá trị cao — sửa nợ kỹ thuật ngay)
2. A2 TokenTracker (Dễ) → A8 choose tool (Dễ) — thắng nhanh
3. R1 crates/pty + terminal desktop (Trung, giá trị cao — Rust)
4. A1 StandardRequest + A8 pool/retry (Trung — hợp nhất ai-engine)
5. R2 sandbox v2 (Trung, giá trị cao — Rust)
6. A3 StreamObject protocol (Trung — communication + ai-engine)
7. A7 7 evidence states + gates (Trung — evals/agents)
8. Còn lại theo nhu cầu (rerank retrieval, PoW, docloader compare, computer-use patterns)

## Phần F — Phát hiện đặc biệt cần owner biết

1. ⚠️ **Nợ kỹ thuật đang có:** công thức scoring `ceiling − findings×6/8` (`work-loop.ts:127-134`) trái nguyên tắc gốc của better-harness mà Ghita đã hấp thụ trước đây ("score never creates or suppresses a finding").
2. ⚠️ **ds2api AGPL-3.0:** toàn bộ ý tưởng A1/A3/A8 phải clean-room — mô tả thiết kế trong tài liệu này là đủ để viết lại, không đọc chuỗi code khi viết.
3. **open-agent fork AFFiNE** — giá trị thật ở `plugins/copilot/` (~46k dòng), phần còn lại là thừa kế AFFiNE chưa dọn.
4. **AgentEnv = MoonshotAI** (powering RL training Kimi K3) — dự án trẻ (72 commits) nhưng production-proven (1.5M images) — học kiến trúc hợp đồng (trait + CAS) là đủ cho Ghita.
5. **node-pty upstream còn race PID-reuse chưa fix** trong kill-tree — nếu port pattern phải thêm guard so sánh process start-time.
