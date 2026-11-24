# Review — khu ai-engine, chu kỳ v0.0.2-alpha

Reviewer: ZCode (review + debug sâu, không tin gates).
Phạm vi: `packages/ai-engine` + `packages/shared` (types/constants) — S2/S3/R1-P3 khu engine.
Ngày review: 2026-11-22.

## Kết quả tổng

- Đọc toàn bộ diff khu ai-engine (`git diff -- packages/ai-engine packages/shared`) + 5 file mới + 7 file test mới.
- Không tin gates — tự đọc code từng module: standard-request (4 wire renderer), stream-protocol, token-tracker (ALS), key-gate, retry-ladder, orchestrator/chat (stream ladder), cost middleware, 11 providers, tools/index (choose), workspace-tools (PTY stream), registry wiring.
- **Đã hiện thực hóa + sửa 3 lỗi thật (1×P1, 2×P2 nhỏ)** — chi tiết bên dưới.
- Sau sửa: `vitest run` full package **1054/1054 pass**, `tsc --noEmit` sạch, `pnpm knip` exit 0.

## Đã sửa (tay, trong working tree)

### [P1] F1 — Stream kết thúc KHÔNG có terminal chunk khi message cuối trùng nudge text

- File: `packages/ai-engine/src/orchestrator/chat.ts` (block synthetic follow-up, ~line 213 trước sửa) + test `tests/retry-ladder.test.ts`.
- Bug: empty terminal chunk bị `heldEmptyDone` giữ lại; điều kiện chạy follow-up là
  `success && heldEmptyDone && messages.at(-1)?.content !== SYNTHETIC_FOLLOW_UP_PROMPT`.
  Khi conversation đã kết thúc bằng đúng chuỗi nudge (harness replay nudge vào history là kịch bản thật), cả block bị skip và `heldEmptyDone` **không bao giờ được yield** → consumer nhận 0 chunk, không bao giờ thấy `done` → UI/consumer treo. EventStream bus cũng không emit `message.complete`.
- Bằng chứng: viết repro test tạm — `expect(doneChunks.length).toBe(1)` fail với `0`. Test cũ
  "does not stack follow-ups…" che bug vì chỉ assert số lần gọi `chatStream`, không assert delivery.
- Sửa: tách điều kiện — khi nudge là no-op vẫn `yield heldEmptyDone`; follow-up chỉ chạy khi nudge thật sự mới.
- Test: nâng cấp test cũ thành regression test (assert đúng 1 chunk `done`). Repro scratch đã xóa.

### [P2] F2 — Google deterministic blocks (SAFETY/RECITATION/…) map thành `'stop'` → ladder rule 3 vô hiệu với Google

- File: `packages/ai-engine/src/providers/google.ts` (`mapFinishReason`).
- Bug: `default: return 'stop'` khiến response bị SAFETY/RECITATION chặn (empty content, finish `'stop'`)
  rơi vào ladder rule 1 → gọi thêm 1 synthetic follow-up **trả tiền** cho block all-deterministic —
  đúng cái rule 3 sinh ra để tránh. OpenAI (`content_filter`→`error`) và Anthropic (`refusal`→`error`) đều map đúng, Google bỏ sót.
- Sửa: `SAFETY`/`RECITATION`/`BLOCKLIST`/`PROHIBITED_CONTENT`/`SPII` → `'error'`.
- Lưu ý behavior change (cố ý): caller nhận `finishReason: 'error'` thay vì `'stop'` + content rỗng — `'error'` là giá trị hợp lệ mà OpenAI/Anthropic paths đã surface từ trước.

### [P2] F3 — Switch-key sau failover trúng nhầm provider

- File: `packages/ai-engine/src/orchestrator/chat.ts` (`orchestratorChat`).
- Bug: `keySwitcher` resolve MỘT lần từ provider primary ngoài `executeWithFallback`; khi failover sang
  fallback provider mà dính 429, ladder switch key của **primary** (no-op với call đang chạy) và tiêu luôn
  ngân sách `MAX_KEY_SWITCHES` của request.
- Sửa: resolve switcher per-invocation từ provider hiện tại (`resolveKeySwitcher(ctx, p)` trong fn);
  `ladderState` vẫn shared nên cap once-per-request giữ nguyên.

### [P3] F3b — Held empty chunk làm mất usage/model/provider vào cache

- File: `packages/ai-engine/src/orchestrator/chat.ts` (2 chỗ hold).
- Bug: nhánh hold `continue` trước khi capture metadata → response rỗng bị cache với usage 0 dù provider
  đã tính tiền prompt (empty response vẫn có usage).
- Sửa: capture `provider`/`model`/`usage`/`finishReason` ở cả 2 nhánh hold trước khi `continue`.

## Findings không sửa (khuyến nghị)

### [P2] F4 — `runViaPty` có cửa double-execution hẹp

- File: `packages/ai-engine/src/tools/workspace-tools.ts` (`runViaPty`).
- Nếu addon spawn child THÀNH CÔNG rồi mới throw (lỗi wiring callback), `runViaPty` resolve `null` →
  buffered fallback chạy lệnh **lần thứ hai**. Addon thật throw đồng bộ trước spawn nên cửa này hẹp;
  khuyến nghị: đánh dấu `spawned = true` ngay sau `ptySpawn` trả về và không fallback khi đã spawned.
- Test `workspace-tools.pty-stream.test.ts` chất lượng tốt (approval trước PTY, fallback, opt-in flag).

### [P3] F5 — EventStream emit có thể interleaved khi cấu hình rewindWriter

- File: `packages/ai-engine/src/stream/event-stream.ts` + `orchestrator.ts` (`emitStreamEvent` fire-and-forget).
- Không rewindWriter: toàn bộ `emit` chạy đồng bộ → thứ tự `message.delta` đảm bảo. Có rewindWriter:
  fan-out subscriber nằm sau `await append` → subscriber có thể nhận delta lệch thứ tự giữa các emit
  (buffer vẫn đúng thứ tự vì push trước await). Khuyến nghị: queue fan-out tuần tự nếu bật rewind.
- Nhân sự lưu ý nhỏ: `message.complete` emit TRƯỚC khi chunk cuối yield cho consumer (bus nghe trước consumer một nhịp).

### [P3] F6 — Stream-side empty hold không phân biệt được content-filter

- Terminal stream chunk không mang `finishReason` (parity với legacy), nên stream bị Google/Anthropic chặn
  giữa vẫn触发 1 synthetic follow-up trước khi surface terminal. Non-stream đã đúng nhờ rule 3.
  Khuyến nghị track sau: gắn `finishReason` lên terminal chunk để hold check rule 3 cả ở stream.

### [P3] F7 — `mergeStreamObjects.sameToolCall` có thể collapse tool call hợp lệ

- File: `packages/ai-engine/src/stream-protocol.ts`.
- 2 tool call KHÁC nhau nhưng cùng name+arguments và đều không có id → call thứ 2 bị drop.
  Thực tế cả 4 provider đều cấp id (Google tự sinh synthetic id) nên rủi ro lý thuyết; đã có test chủ ý.

### [P3] F8 — `chooseApprovals.requests` tăng trưởng không giới hạn

- File: `packages/ai-engine/src/tools/index.ts` — manager dùng chung module-level, entry sau quyết định
  không được prune (chỉ có `clear()`), sidecar chạy dài sẽ tích tụ object nhỏ. Khuyến nghị: xóa entry
  sau khi `awaitDecision` kết thúc hoặc prune theo tuổi.

### [P3] F9 — Abort của user bị classify thành `timeout` (retryable)

- File: `packages/ai-engine/src/errors/index.ts` (`TIMEOUT_RE` chứa `aborted`).
- Non-stream: user abort → `AgentError` retryable → legacy retry vẫn gọi lại (parity với legacy —
  legacy regex cũng không chặn abort). Stream path đã chặn đúng qua `options?.signal?.aborted`.
  Giờ có AgentError rồi, thêm nhánh `aborted` → non-retryable là 2 dòng; để nguyên trong chu kỳ này
  để giữ call-count parity, khuyến nghị chu kỳ sau.

### [P3] F10 — ALS: `withToolScope` misattribute khi tool chạy đồng thời

- File: `packages/ai-engine/src/token-tracker.ts`. Chain là mảng shared per-run; 2 tool chạy
  `Promise.all` → frame chồng `[main, a, b]`, step của cả hai attributing về frame sâu nhất hiện tại.
  Hiện chưa có production caller của `withToolScope` (chỉ export cho host) nên chưa phá production;
  khuyến nghị: frame-id thay vì stack khi track sau bật dùng thật.

### [P3] F11 — Root vitest include trỏ tới test file đã xóa (pre-existing)

- `packages/ai-engine/vitest.config.ts` include 19 file `../../tests/unit/*.test.ts` không còn tồn tại
  → chạy vitest trong package hiện 19 collect-error "file không tồn tại" (không phải test fail).
  Dọn include list khi dọn root tests.

## Đã kiểm tra và SẠCH (không tìm thấy bug)

1. **Byte-parity StandardRequest**: đối chiếu 4 renderer với baseline legacy — key order khớp từng variant
   (OpenAI/Groq/Mistral chat+stream, Azure omitModel, Custom stream_options, Anthropic stream sau toolFields
   rồi system, Google, Ollama format/tools/think passthrough, defineVendor). Test parity 670 dòng chặt
   (cả end-to-end qua fetch mock bắt body). Không thấy drift.
2. **Token/cost double-count**: `wrapAsyncGenerator` + `withToolScope` chưa có production caller — chỉ cost
   middleware record 1 step/call; stream wrapper record trong `finally` với cờ `success` đúng semantics
   (break sớm/producer error → không step). Nested run rollup 1 step vào parent, không trùng. Công thức
   estimate dùng chung `estimateUsageFromLength` (mid-stream refactor giữ nguyên ceil(len/4)).
3. **ALS leak**: nested `run()` isolate đúng (test proof), parent restore sau child, report emit cả khi fn throw.
   Generator wrap record theo store TẠI THỜI ĐIỂM drain — drain ngoài scope → no-op, không cross-run.
4. **Retry ladder**: không infinite (cap 1 nudge + 1 switch, legacy retry bound); không double-retry vô kiểm soát
   (ladder chạy trong legacy retry, state shared); empty-hold không double-done (assert trong test + đã fix F1);
   finishReason `'error'` + empty → throw content_filter non-retryable (rule 3 đúng cho non-stream).
   Ladder state shared đúng cách qua failover.
5. **Error classifier**: 429/401/403/5xx/timeout/network/content-filter/budget/no_provider map đúng
   (`ENOTFOUND` không dính trap "not found" vì thiếu space; 400+có wording filter → content_filter đúng thứ tự).
   Idempotent + provider backfill. `budget` giờ non-retryable (cải tiến so với legacy từng retry budget error —
   behavior change có chủ ý, ghi nhận).
6. **API key leak**: scan log/throw quanh key-manager/credentials/providers — không có key vào log;
   `KeyGate` timeout message chỉ chứa **số lượng** key excluded (`exclude.size`), không chứa key;
   Google key nằm trong URL nhưng error path không echo URL; `getHealthStatus` vẫn mask key.
7. **Stream ordering**: EventStream mặc định (không rewindWriter) emit đồng bộ → thứ tự delta đúng;
   `orchestrator.chatStream` wrapper emit `message.delta`/`message.complete` fire-and-forget có `.catch`
   → không phá stream chính; đúng 1 `message.complete`/stream (sau fix F1).
8. **Edge cases**: stream rỗng (hold + follow-up + surface đúng 1 terminal — sau fix), tool-call không args
   (`isNonEmptyChatContent` counting toolCalls), reasoning trước text (OpenAI: content ưu tiên trong cùng delta,
   reasoning chunk riêng giữ thứ tự giữa các chunk), empty terminal kèm toolCalls không bị hold.
9. **KeyGate FIFO**: acquire atomic (không await giữa check-queue và enqueue), timeout reject có dọn queue,
   drain chỉ phục head (FIFO by design), abortAll dọn timer. Đủ test cả fake timers.
10. **workspace-tools PTY**: approval + blockedTokens chạy TRƯỚC nhánh PTY; TDZ fix timers-array trước
    `finish` có comment đúng lý do; kill registry parity `__activeChildProcs`; grace timer chống treo;
    stream handler lỗi listener không phá run. Format output PTY khác buffered (merge stream) — có test chủ ý.

## Test sau debug

- `vitest run` (packages/ai-engine): **81 files / 1054 tests PASSED** (sau 3 fix + 1 regression test mới).
- `tsc --noEmit` (packages/ai-engine): sạch.
- `pnpm knip`: exit 0 (chỉ configuration hints có sẵn).
- Repro scratch test đã xóa; regression chính thức nằm trong `tests/retry-ladder.test.ts`.

## Ghi chú quy trình

- Không commit/push/tag (theo quy tắc — chờ xác nhận của user).
- Chỉ động `packages/ai-engine` (chat.ts, google.ts, retry-ladder.test.ts); không đụng crates/apps/agents/communication/computer-use.
