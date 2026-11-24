# Review khu 3 — Frontend + Sidecar + Harness/Security-Packages (v0.0.2-alpha)

Reviewer khu 3. Scope: sidecar bridges (S3 choose / S4 computer-use), desktop UI
approval flow + sharedSocket relay, harness S1 (work-loop / session-report),
sandbox-hook R2 wire, store.ts EPERM retry, chat-chunk-batcher, computer-use
screen patterns, monitoring CostSurface, security hashcash, shared constants/types.

**Kết luận chung: PASS với 3 fix đã commit-in-worktree, 0 P0/P1.**
Native addon `ghita-sandbox` có mặt → e2e sandbox-hook chạy thật (không skip).

---

## Đã sửa trong phiên review

- **[FIX-1][P2] `packages/communication/src/server.ts:661-676` — terminal text-delta bị kẹt trong batcher.**
  `broadcastStreamObject({type:'text-delta', done:true})` chỉ `push()` vào
  batcher; frame batched chỉ mang `{text, timestamp}` nên cờ `done` bị rơi, và
  chunk cuối có thể phát SAU `chat_done` mà caller emit ngay sau đó (đảo thứ tự
  end-of-turn trên mobile wire). Đã sửa: `done === true` → `flush()` đồng bộ
  ngay sau push (chunk cuối + text dư luôn land trước chat_done).
  Test mới: `flushes a terminal text-delta immediately (done:true never lags
past chat_done)` — `packages/communication/tests/chat-chunk-batcher.test.ts:198`.

- **[FIX-2][P2] `apps/desktop/src/components/chat/ChatToolApproval.tsx:114-136` — câu hỏi `choose` không bao giờ được hiển thị.**
  Nhánh `chooseOptions` thay `<pre>{arguments}</pre>` bằng nút option nên user
  chỉ thấy "1. Option A / 2. Option B" mà không biết đang trả lời câu hỏi gì.
  Đã thêm span hiển thị question (trỏ `approvalRequest.arguments`, bridge relay
  question vào `command` → UI map vào `arguments`) phía trên danh sách option.

- **[FIX-3][P3] `packages/agents/src/autogpt/store.ts:117-122` — ghost tmp file khi retry rename hết hạn.**
  Retry EPERM/EBUSY/EACCES 5 lần xong ném `lastError` mà không dọn `.tmp-*` của
  chính lần ghi → mỗi save thất bại để lại rác trong workspace. Đã thêm
  `fs.rm(tmp, {force:true})` best-effort trước khi throw (lỗi rm không che lỗi gốc).

Sau fix: toàn bộ test khu GREEN (chi tiết cuối file) + `tsc --noEmit` OK
(desktop, communication) + `pnpm knip` chỉ còn configuration hints (0 finding).

---

## Findings theo mảng

### 1. Sidecar bridges (choose-bridge.mjs / computer-use-bridge.mjs / server.mjs)

- **[P2→đã sửa] Terminal text-delta batcher** — xem FIX-1.
- **[PASS][security] choose-bridge whitelist đủ chặt** — `sanitizeChoosePayload`
  strip field lạ, `allowCustom` strict boolean, id ≤200, question ≤2000, options
  2–8 × ≤500 ký tự; payload lỗi bị drop, không emit. `emitToDesktop` =
  `io.to('desktop')` (server.mjs:137) — paired device không bao giờ thấy/answer
  human decision. `approve_command`/`reject_command` handler có gate
  `getAuthorizedClient({allowDevice:false})` (server.mjs:2036/2057) — device
  paired không tự duyệt được shell command mà chính nó trigger.
- **[PASS][security] computer-use-bridge** — whitelist 7 lệnh `computer_*`
  frozen; `rpc` chỉ nhắm 1 socket desktop (không broadcast → không click nhân
  đôi nhiều desktop LAN); timeout per-command (5s/20s/10s); ack 1-shot của
  socket.io → late ack sau timeout chỉ là no-op (không resurrect). Không có
  timer leak: promise đã settle thì resolve/reject sau là no-op.
- **[PASS] Attachment/gating** — `attachDesktopSocket` chỉ gọi khi
  `isTrustedDesktopSocket(socket)` (server.mjs:3057); disconnect tự detach; sau
  reconnect socket cũ `connected=false` bị `pickDesktopSocket` bỏ qua.
- **[PASS] Đã verify wire Rust ↔ JS arg names** — `computer_move_mouse(x,y)`,
  `computer_click(point,button)`, `computer_type_text(text)`,
  `computer_press_key(key)` (`apps/desktop/src-tauri/src/computer_use.rs:327-399`)
  khớp payload bridge; `ScreenCapture` serialize `mimeType`/`size`/`scale_factor`
  (computer_use.rs:37-48) khớp `adapter.screenshot()` + `undoDpiScale`.
  Tất cả arg single-word → không dính camelCase mismatch của Tauri.
- **[P3] Screenshot path không truyền `max_edge`/`mime_type`** — Rust
  `computer_screenshot` nhận 3 params nhưng bridge gọi không args: full-res PNG
  base64 mỗi lần chụp (memory + 20s budget). Khuyến nghị: thêm clamp
  `max_edge`/JPEG tùy chọn ở adapter trong 1 track sau.
- **[P3] Id namespace** — choose id `tc_*` và command-approval id do 2 generator
  khác nhau sinh; handler duyệt cả 2 registry cho mọi id. Collision thực tế
  ~0 (khác prefix + random), nhưng về lý thuyết id trùng sẽ resolve chéo.
  Khuyến nghị: prefix-check trước khi gọi bridge thứ hai.

### 2. Desktop UI event ordering / approval flow

- **[PASS] Reject của choose đi đúng kênh** — `handleRejectTool` mở rộng cho
  `approvalKind === 'choose'` → `reject_command`; nếu không, bare `reject` sẽ
  rơi vào handler pairing và câu hỏi chỉ chết ở timeout 60s. Đúng.
- **[PASS] Duplicate-resume / approve-race** — `handleChooseOption` +
  `handleApproveTool` đều đọc `approvalRequest` từ closure render hiện tại rồi
  `setApprovalRequest(null)` ngay sau emit; nhấn lần 2 là no-op (state null).
  Server-side id-guard (ToolApprovalManager trả false cho id đã quyết) chặn
  double-resolve từ 2 client.
- **[P2→đã sửa] Question ẩn** — xem FIX-2.
- **[P3] `allowCustom` bị bỏ qua ở UI** — bridge relay `allowCustom` nhưng modal
  không có ô nhập free-text; user chỉ chọn option có sẵn hoặc Reject. Engine
  vẫn nhận custom answer qua API (test e2e pass). Khuyến nghị: thêm input row
  - nút gửi gọi `onChooseOption(text)` khi `allowCustom`.
- **[P3] Approvals ghi đè nhau trong UI** — `setApprovalRequest` replace: 1
  require_approval mới (choose hoặc command) đè approval đang chờ; approval bị
  đè vẫn pending server-side và chỉ thoát bằng timeout. Hiện tại engine serialize
  approval per-run nên khó hit; rủi ro xuất hiện khi chạy song song 2 run
  (crew/workflow). Khuyến nghị: queue approval UI-side (hàng đợi + badge số).
- **[PASS] sharedSocket relay** — `registerComputerUseRelay` đăng ký 1 lần trên
  socket dùng chung (sống qua reconnect), ack wrap try/catch (requester
  disconnect không crash relay), id/cmd phải string + whitelist trước
  `invoke`. Không trở thành generic Tauri proxy (defense in depth 2 phía).

### 3. Harness S1 (work-loop.ts / types.ts / session-report.ts)

- **[PASS] Ceiling validator** — authored score phải integer 0..validatedCeiling,
  `hasMissing` cap 59 đúng kể cả khi check khác Outcome-supported
  (harness.test.ts:100-115). Non-integer/âm/vượt ceiling → `InvalidWorkLoopScoreError`.
- **[PASS] Emission bar** — 4 field đều là required string theo type nên không
  có false-negative cho finding type-hợp lệ; hand-built review thiếu field bị
  filter và liệt kê vào `emissionBarRejected`. Render-time re-check ở
  session-report chặn bypass.
- **[PASS] Consistency gate** — authored < 70 phải có finding linked cùng
  dimension (primaryCheck ownership); baseline exempt đúng spec;
  `allowUnlinkedLowScore` ghi violation thay vì throw. Không thấy false-positive
  cho review hợp lệ: findingRefs/dimensionRefs được derive từ emitted findings
  nên link integrity luôn resolve trong evaluate-built review.
- **[PASS] Sanitizer** — `renderSessionReport` sanitize qua
  `InputSanitizer.scan` + shared pii-redaction middleware (không reimplement);
  test PII (email/GitHub token/script) pass. Lưu ý `checkId`/`f.id`/`severity`
  không sanitize — đúng thiết kế (identifier có kiểm soát).
- **[P3] Breaking change API** — `renderSessionReport` sync → async. Toàn bộ
  caller trong repo đã await; caller bên ngoài (nếu có) sẽ nhận Promise thay
  string. Khuyến nghị note trong CHANGELOG của bản alpha.
- **[P3] Floor learning-capture áp cả authored score** — authored 20 (hợp lệ
  theo ceiling) bị nâng lên 35 nhưng `authored` giữ 20; hơi khó đọc khi audit
  `score ≠ authored`. Đúng spec floor nhưng nên comment rõ ở types.ts.

### 4. Sandbox-hook R2 wire (src/blocks/sandbox-hook.ts + runner.ts)

- **[PASS] Handler đúng path** — `createRunInSandbox` → `SandboxRunner.run(node, ['-e', code])`
  với denyGlobs = DEFAULT ∪ policy (dedupe); blocked → `SandboxRunError`
  mang result; exit≠0 → error kèm stderr; `onResult` cho audit. e2e thật với
  native addon: strict profile + overlay rollback sạch, deny-glob chặn argv
  trước spawn, wire qua GraphExecutor `code_sandbox` block hoàn chỉnh.
- **[PASS] Fix camelCase napi đúng chỗ** — runner.ts đổi `deny_globs`→`denyGlobs`
  v.v. cả 2 chiều (interface + call-site); không còn option bị addon bỏ qua âm thầm.
- **[P3] `resolveSandboxPolicy` không nhận `overlayCommit`/`ioWriteLimitMb`** —
  2 field mới của SandboxRunnerOptions phải set tay ngoài policy config
  (sandbox-hook.ts nhận `overlayCommit` riêng). Nếu muốn policy declaration
  đầy đủ, thêm 2 field này vào `SandboxPolicyConfig` track sau.

### 5. store.ts EPERM retry

- **[PASS] Retry bounded** — 5 attempts, backoff tuyến tính 25→125ms, chỉ
  EPERM/EBUSY/EACCES; lỗi thật (ENOENT...) ném ngay giữ semantics cũ.
  Per-write `enqueue()` serialize nên không có stale map.
- **[P3→đã sửa] Ghost tmp** — xem FIX-3.
- **[P3] EACCES trong retry list** — EACCES trên rename thường là permanent
  (permission), retry 5 lần chỉ cộng ~375ms delay trước khi ném đúng lỗi.
  Chấp nhận được; khuyến nghị bỏ EACCES nếu muốn fail-fast.

### 6. Hashcash (packages/security/src/hashcash.ts)

- **[PASS] TTL edge** — ts 1s-granularity: lệch tối đa <1s so ttl; future-skew
  60s chặn stamp "từ tương lai"; `bits` verifier-bounded [1,64] chống DoS;
  mint ceil(bits/4) ≥ check floor(bits/4) → minted stamp luôn verify pass
  (bits=13 asymmetry có test riêng).
- **[PASS] Timing** — không có secret nào được so sánh (resource/counter là
  public, PoW verify bằng hash) → constant-time compare không cần thiết ở đây.
- **[P3] Chưa có replay cache** — TTL 5 phút chỉ giới hạn cửa sổ replay; stamp
  hợp lệ có thể nạp lại nhiều lần trong cửa sổ. Khuyến nghị: verifier giữ
  seen-set (hash full stamp) ở lớp server API bridge khi wire vào Track S4.

### 7. Computer-use screen patterns (region/match-request/waitFor)

- **[PASS] DPI/region** — `validateSearchRegion` chặn NaN/âm/<2px/tràn màn hình
  (throw, không tự sửa); `clampRegionToScreen` clamp không-throw cho rect OS
  (shadow/maximized/âm Windows) — đúng cặp pattern nut-js, có test phủ.
- **[P3] Infinity thoát validate khi không có screenSize** — `Number.isNaN`
  không bắt Infinity; `width: Infinity` pass validate nếu caller không truyền
  `screenSize` (NaN-only check). Khuyến nghị dùng `!Number.isFinite`.
- **[PASS] AbortSignal cleanup** — `waitFor`: listener `{once:true}` + remove
  khi timer fire; abort giữa sleep reject NGAY (không đợi hết interval);
  deadline check trước mỗi sleep → không ngủ vượt deadline; lastRejectionReason
  kèm lỗi timeout. Không thấy leak.

### 8. CostSurface (monitoring)

- **[PASS]** — aggregation đúng, per-model cost tỉ lệ token share, ring bounded
  (default 50), `registerCostSurface` unregister có guard identity (không xóa
  handler của người khác), không import ai-engine (structural typing). Test đầy đủ.

### 9. ChatChunkBatcher + CommunicationServer

- **[PASS] Batcher core** — char/time bound, timer reset sau flush, dispose
  drop-buffer, emit lỗi swallow có warn; `stop()` flush trước dispose đúng thứ
  tự; `start()` sau `stop()` recreate batcher (không dùng batcher đã dispose).
- **[P2→đã sửa] Terminal delta** — xem FIX-1.
- **[P3] Frame batched mất metadata** — batcher emit chỉ `{text, timestamp}`;
  provider/model/usage trên text-delta wire (per `StreamObjectWire`) bị rơi khi
  đi qua batch path. Legacy mobile contract chỉ đọc `{text}` nên OK; khuyến
  nghị document ràng buộc này ở broadcastStreamObject.

### 10. Shared constants/types

- **[PASS]** — `CHAT_CHUNK/CHAT_DONE/CHAT_ERROR` trùng literal với sidecar
  broadcast; `StreamChunkType` 5 giá trị khớp stream-protocol.ts ai-engine.

### 11. Chất lượng test khu

- **[PASS] Strong** — 2 bridge dùng socket.io thật (port 0) + engine dist thật
  cho choose e2e (không mock engine); phủ id-guard, whitelist, timeout,
  disconnect, id-mismatch, DPI undo, input validate. Harness 19 test phủ ceiling
  validator/emission bar/consistency gate/reverse-link. hashcash 19 test phủ
  tamper/TTL/skew/bits-bounds. Chỉ thiếu test UI cho flow choose (không có
  ChatToolApproval test file) — khuyến nghị bổ sung khi làm allowCustom.

---

## Kết quả test sau debug

| Suite                                                 | Kết quả                                 |
| ----------------------------------------------------- | --------------------------------------- |
| `node --test choose-bridge.test.mjs`                  | 8/8 pass                                |
| `node --test computer-use-bridge.test.mjs`            | 10/10 pass                              |
| `@ghita/security` (vitest)                            | 176/176 pass (9 files)                  |
| `@ghita/communication` (vitest)                       | 166/166 pass (14 files, gồm test FIX-1) |
| `@ghita/monitoring` (vitest)                          | 24/24 pass (3 files)                    |
| `@ghita/computer-use` (vitest)                        | 241 pass / 13 skipped (11 files)        |
| `@ghita/agents` (vitest, gồm sandbox-hook e2e native) | 444/444 pass (40 files)                 |
| apps/desktop vitest                                   | 220/220 pass (27 files)                 |
| `tsc --noEmit` desktop + communication                | exit 0                                  |
| `pnpm knip`                                           | 0 finding (chỉ configuration hints)     |

Không commit/push/tag (đúng quy tắc).
