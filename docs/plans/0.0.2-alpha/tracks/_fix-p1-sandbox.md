# Fix P1 — sandbox `spawn_sandboxed` treo vô hạn khi grandchild giữ stdout/stderr pipe (nhánh exit tự nhiên)

Worker: debugger Track Rust (v0.0.2-alpha) · Ngày: 2026-11-22 · Scope: chỉ `crates/sandbox/**`.
Bám finding **[P1]** trong `_review-rust.md` — mục "KHÔNG SỬA / KHUYẾN NGHỊ".

## 1. Bug

`crates/sandbox/src/lib.rs` — vòng poll (trước sửa): nhánh `try_wait()` trả `Some`
(child chính exit TỰ NHIÊN) break thẳng vào `child.wait_with_output()?` —
**không còn bất kỳ check timeout nào sau đó**. Con cháu kế thừa stdout/stderr
pipe (`cmd /C start /b …`, background job, daemon) giữ write-end mở → `read()`
chờ EOF vô hạn → wall-clock timeout bị vô hiệu hoàn toàn ở nhánh này.
R2 đã thêm `TerminateJobObject` cho nhánh TIMEOUT; nhánh natural-exit vẫn hở.
Không phải regression mới của R2 — pattern cũ cũng dính (review đã ghi nhận).

## 2. Repro (trước fix)

Test mới `grandchild_holding_pipe_cannot_defeat_timeout` (lib.rs:1734):
`cmd.exe /C "start /b ping -n 30 127.0.0.1 & exit"` — cmd exit ~100ms, cháu
`ping` kế thừa pipe chạy ~29s; `timeout = 1500ms`.

- **Trước fix: FAIL — call trả sau 29.43s** (panicked: "took 29.4341792s")
  dù timeout chỉ 1.5s → bug tái hiện đúng như finding.
- Test bảo vệ hành vi `grandchild_finishing_within_drain_grace_keeps_output`
  (lib.rs:1779) — cháu exit nhanh trong grace vẫn phải thu ĐỦ output, KHÔNG
  kill tree — PASS cả trước lẫn sau fix (không đổi hành vi trường hợp lành).

## 3. Fix (crates/sandbox/src/lib.rs)

Thiết kế theo đúng khuyến nghị review ("drain pipe bằng vòng có deadline,
TerminateJobObject khi quá deadline, rồi mới reap") + pattern drain trên
reader thread của `crates/pty` (tham khảo, không đụng file):

- **`PIPE_DRAIN_DEADLINE = 1000ms`** (lib.rs:1014) — chốt thời gian drain
  stdout/stderr sau khi child chính đã thoát.
- **`spawn_pipe_reader`** (lib.rs:1019) — đọc từng pipe trên thread phụ, gửi
  `(is_stdout, buf)` qua `mpsc` khi EOF; thread chỉ xong khi MỌI holder của
  write-end thoát → caller bắt buộc áp deadline.
- **`reap_output(child, containment, stall_deadline: Option<Duration>)`**
  (lib.rs:1050) — thay mọi `wait_with_output` sau vòng poll:
  - Phase 1: drain trong deadline. Cháu exit nhanh → EOF tự nhiên, thu đủ
    output, **không kill gì** (giữ nguyên hành vi trường hợp lành).
  - Phase 2 (chỉ khi stall): `kill_child_tree` = `TerminateJobObject` toàn bộ
    job tree (đóng handle kế thừa của cháu, EOF tới trong ms) → drain nốt
    phần đã đệm trong OS pipe trong deadline thứ hai. `stall_deadline`
    `Some(1000ms)` cho nhánh natural-exit / timeout-kill / io-budget-kill;
    `None` cho nhánh không limit (= contract `timeout: None` chờ vô hạn —
    không đổi, nhưng qua helper để `child` không bị move).
  - Sau hai deadline vẫn kẹt (holder NGOÀI job) → bỏ thread, trả phần đã đọc
    - exit code của child chính. **Không bao giờ block vô hạn.**
- **Vòng poll** (lib.rs:1330–1418): cả 3 nhánh break (natural-exit,
  timeout-kill, io-budget-kill) đều qua `reap_output(..., Some(1000ms))` —
  vá luôn case kill tree fail (OpenProcess bị deny) mà cháu vẫn giữ pipe.
  Lifecycle/state/exit code/3 profile: không đổi.
- **Nhận khuyến nghị P3 #1** (review: "`?` trong pipeline bỏ `finish_overlay`"):
  lỗi IO của wait được gom về một chỗ (lib.rs:1403) — vẫn `kill_child_tree`
  - `finish_overlay` (rollback/commit overlay session) trước khi trả
    `Err(io::Error)`; kênh lỗi giữ nguyên, không bỏ rác upper/temp, không bỏ
    sót child sống.
- **Nhận khuyến nghị P3 #2** (review: test phụ thuộc môi trường):
  `io_write_budget_kills_runaway_writer` skip có kiểm soát khi `node` không
  có trên PATH (lib.rs:1851–1865) thay vì fail giả.

### Bỏ qua (có chủ đích, theo review đã ghi nhận/accept)

- ReadOnly/Strict Windows là containment mềm → backlog ACL/codex-sandbox.
- win_job IO budget chỉ đếm direct child + poll 25ms → chấp nhận best-effort
  (đã doc trong comment `assign`).
- Các P3 của `crates/pty` (args " ", exit_code truncation, kill không timeout)
  → ngoài scope (không đụng crates/pty).

## 4. Test trước / sau

| Gate                                                                          | Trước fix           | Sau fix                                                      |
| ----------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------ |
| `grandchild_holding_pipe_cannot_defeat_timeout`                               | FAIL (29.43s)       | PASS (~1.2s)                                                 |
| `grandchild_finishing_within_drain_grace_keeps_output`                        | PASS                | PASS                                                         |
| `cargo test -p ghita-sandbox`                                                 | 21 test cũ          | **23/23 PASS** (21 cũ + 2 mới, ổn định 3 lần chạy liên tiếp) |
| `cargo clippy -p ghita-sandbox --all-targets -- -D warnings`                  | —                   | sạch                                                         |
| `cargo clippy -p ghita-sandbox --all-targets --features addon -- -D warnings` | —                   | sạch                                                         |
| `cargo fmt -p ghita-sandbox -- --check`                                       | FAIL (pre-existing) | sạch                                                         |

Lưu ý fmt: violation `fmt --check` tồn tại **từ trước** thay đổi này (backend.rs/
overlay.rs/state.rs đã committed tại `c6ffed5` cũng fail; CI chỉ gate fmt cho
`apps/desktop/src-tauri`, không gate crates/). Đã chạy `cargo fmt -p
ghita-sandbox` để toàn crate sạch gate — toàn bộ diff fmt là mechanical,
đã re-verify test + clippy xanh sau format.

## 5. Danh sách thay đổi (file:line, trạng thái hiện tại sau fmt)

- `crates/sandbox/src/lib.rs`
  - `:1014` const `PIPE_DRAIN_DEADLINE` (mới)
  - `:1019` `spawn_pipe_reader` (mới)
  - `:1050–1119` `reap_output` (mới — drain deadline + kill-on-stall + abandon)
  - `:1330–1400` vòng poll: 3 nhánh break → `reap_output`; `Err(err) => break`
    gom lỗi (trước đây `try_wait()?` / `wait_with_output()?` trả sớm)
  - `:1403–1420` match lỗi wait → kill child + `finish_overlay` trước khi trả
    `Err` (P3 #1)
  - `:1727–1810` 2 test regression mới (repro + bảo vệ hành vi grace)
  - `:1851–1865` guard `node` cho test io-budget (P3 #2)
- `crates/sandbox/src/backend.rs`, `overlay.rs`, `state.rs` — chỉ reformat
  mechanical (`cargo fmt`), không đổi logic.
- Không commit/push/tag. Không đụng crates/pty, packages/**, apps/**,
  refer_project, docs/plans (trừ report này).
