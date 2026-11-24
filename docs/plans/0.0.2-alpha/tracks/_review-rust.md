# Review Rust Track — chu kỳ v0.0.2-alpha

Reviewer: agent review+debug Track Rust (không tin gates — đọc code + chạy test thực tế).
Phạm vi: `crates/pty/` (mới), `crates/sandbox/` (lib/backend/state/overlay/napi/windows), `apps/desktop/src-tauri/src/terminal.rs` (extract), `apps/desktop/src-tauri/.cargo/config.toml`, `scripts/build-native.mjs`. KHÔNG đụng packages/**.

Kết quả cuối: **cargo test -p ghita-pty -p ghita-sandbox: 51/51 PASS** (30 pty + 21 sandbox) · **clippy -D warnings sạch** (default + `--features addon` + `--all-targets`).

---

## ĐÃ SỬA trong phiên review này (working tree, chưa commit)

### [P2] pty — UTF-8 multibyte vẫn vỡ ở biên flush thời gian (audit 3.6 chưa fix triệt để)

- **File**: `crates/pty/src/lib.rs` — `drain_reader` / `flush_buf` (trước sửa ~line 457–473).
- **Bug**: flush 16ms/batch convert **toàn bộ** buffer bằng `String::from_utf8_lossy`. Khi writer chậm khiến flush thời gian rơi GIỮA một chuỗi multibyte (VD chữ "ẽ" 3 byte bị tách 2/1): nửa đầu → `U+FFFD`, **nửa sau bị DROP khỏi buffer** (`std::mem::take`), byte còn lại sang chunk kế tiếp sinh thêm `U+FFFD` — đúng loại hỏng chữ Việt/CJK mà "audit fix 3.6" tuyên bố đã xử lý. Batch-flush theo `FLUSH_THRESHOLD` vẫn an toàn (buffer đủ lớn), nhưng interval-flush thì không.
- **Đã sửa**: tách hàm thuần `utf8_flushable_len(buf, at_eof, cap)` — flush chỉ tới `valid_up_to()` khi `error_len()==None` (tail incomplete được GIỮ lại cho read kế), EOF/cap(4×8KB) thì flush toàn bộ qua lossy (tail không bao giờ hoàn tất / chống writer bệnh hoạn làm buffer phình vô hạn). Thêm 2 unit test (`test_utf8_flushable_len_valid_and_incomplete_tail`, `..._malformed_and_eof`) bám đúng hành vi `from_utf8` đã probe thực nghiệm (`0xC0` → `error_len=Some(1)` ngay lập tức).

### [P2] pty — generations map leak theo session id

- **File**: `crates/pty/src/lib.rs` — cuối `drain_reader`.
- **Bug**: session exit tự nhiên chỉ `sessions.remove(id)` — entry `generations[id]` ở lại mãi (chỉ `kill_session` dọn). Mỗi id duy nhất sống 1 counter → leak chậm với id động (`term-1`, `term-2`, …).
- **Đã sửa**: `generations.remove_if(id, |_,g| *g==reader_gen)` sau khi reader kết thúc, kèm flag `was_current` bắt trước (remove làm `is_current_gen()` thành false — không remove trước khi emit exit).

### [P2] pty — ghost thread có thể XOÁ session mới cùng id (check-then-act race)

- **File**: `crates/pty/src/lib.rs` — cuối `drain_reader` (trước sửa line 521–523).
- **Bug**: `if is_current_gen() { sessions.remove(&session_id) }` — kiểm tra rồi remove KHÔNG atomic. Spawn mới cùng id chen giữa 2 bước → thread cũ xoá nhầm session MỚI: write/resize/kill theo id báo "not found", exit event của session mới không bao giờ tới. counter `PtySession.generation` có sẵn nhưng `#[allow(dead_code)]` (chưa từng dùng).
- **Đã sửa**: `sessions.remove_if(id, |_,s| s.lock().map(|s| s.generation==reader_gen).unwrap_or(false))` — so gen NGAY TRONG remove_if (shard-lock giữ nguyên, đúng thứ tự lock shard→session như các nơi khác); bỏ `#[allow(dead_code)]` ở field generation.

### [P2] sandbox napi — timeout_ms/process_limit/memory_limit_mb = 0 hoặc NaN gây kill tức thời / contain fail

- **File**: `crates/sandbox/src/napi.rs` (spawn_sandboxed).
- **Bug**: `timeout_ms as u64` với NaN/số âm/0 → saturate 0 → `Duration::from_millis(0)` → child bị timeout-kill NGAY (không chạy nổi lệnh). `process_limit: Some(0)` → `AssignProcessToJobObject` luôn fail (child tự đếm vào limit). `memory_limit_mb=0` → job memory limit 0 byte.
- **Đã sửa**: timeout vô nghĩa (không finite / ≤ 0) → default 120s đúng doc; `filter(|&p| p>0)` cho process/memory limit.

### [P2] sandbox overlay — commit dereference junction/symlink do child tạo + temp bị merge trái hợp đồng

- **File**: `crates/sandbox/src/overlay.rs` — `merge_dir`.
- **Bug 1**: dùng `entry.metadata()` (FOLLOWS link) → child tạo junction trong `upper/` (junction KHÔNG cần quyền admin) trỏ tới thư mục bất kỳ → commit recursively merge nội dung của đích junction vào workspace (exfil nội bộ / vòng lặp). Skip duy nhất là `base`.
- **Bug 2**: doc comment commit ghi "(trừ junction `base` và thư mục temp scratch)" nhưng code KHÔNG skip `upper/temp` → scratch của toolchain bị promote về workspace.
- **Đã sửa**: `merge_dir(src, dst, skip: &[&Path])` — skip theo slice `[base_link, temp]`; dùng `entry.file_type()` (không theo link) và skip mọi `is_symlink()` (junction/symlink không được merge). Test commit mở rộng assert `!ws/temp` sau commit.

### [P3] pty windows — poison lock tắt mutual exclusion của console dance

- **File**: `crates/pty/src/windows.rs` — `enumerate_console_processes`.
- **Bug**: `CONSOLE_DANCE_LOCK.lock().ok()` — khi mutex poisoned, guard = None → KHÔNG còn lock → 2 thread chạy FreeConsole/AttachConsole song song (mỗi process chỉ attach 1 console).
- **Đã sửa**: `unwrap_or_else(PoisonError::into_inner)` — giữ exclusion kể cả khi poisoned.

### [P3] pty — reader thread spawn fail để lại session "undead"

- **File**: `crates/pty/src/lib.rs` — `PtyManager::spawn`.
- **Bug**: session đã insert vào map trước khi spawn thread; thread spawn lỗi (`?` trả Err) → session còn trong map nhưng không ai drain/remove → write/resize/kill theo id thấy session "sống" ma.
- **Đã sửa**: rollback `sessions.remove` + `generations.remove` trong nhánh map_err.

### [P3] pty — kill_session xoá generations đua spawn cùng id

- **File**: `crates/pty/src/lib.rs` — `kill_session`.
- **Bug**: `generations.remove(id)` vô điều kiện sau khi remove session — spawn(id) chen giữa → counter của session MỚI bị xoá → reader mới coi là ghost vĩnh viễn (mất toàn bộ event + không bao giờ tự dọn).
- **Đã sửa**: chỉ remove khi `self.sessions.get(id).is_none()`.

### [P3] sandbox lib — `scrub_env` panic khi env cha có biến non-UTF8

- **File**: `crates/sandbox/src/lib.rs` — `scrub_env`.
- **Bug**: `std::env::vars()` PANIC nếu 1 biến env không valid Unicode (Windows: surrogate lỗi) → cả sandbox spawn chết vì biến rác.
- **Đã sửa**: `vars_os()` + `to_string_lossy()`.

---

## KHÔNG SỬA — ghi nhận/khuyến nghị

### [P1] sandbox — wait_with_output treo vĩnh viễn khi grandchild giữ pipe (timeout bị vô hiệu ở nhánh exit tự nhiên)

- **File**: `crates/sandbox/src/lib.rs` — vòng poll (line ~1182–1220) + nhánh không-limit (line ~1220).
- **Diễn biến**: `try_wait()` trả `Some` (child chính đã exit) → `break child.wait_with_output()?`. Con cháu (`cmd /C start /b …`, background job `&`, daemon) kế thừa stdout/stderr pipe → `read()` chờ EOF → **block vô hạn**; sau khi thoát vòng poll KHÔNG còn check timeout nào nữa. Kill-on-close chỉ nổ khi JobGuard drop — mà drop nằm SAU wait → không tự thoát. Comment của `kill_child_tree` đã thừa nhận đúng hiện tượng này cho nhánh kill, nhưng nhánh exit tự nhiên vẫn dính.
- **Khuyến nghị** (không sửa tay vì cần refactor có test riêng): sau khi reap child, drain pipe bằng vòng có deadline (hoặc `TerminateJobObject` ngay khi quá deadline bất kể child đã exit chưa), rồi mới `wait_with_output`. Không phải regression mới (pattern cũ cũng thế) nhưng là lỗ hổng timeout thực sự.

### [P3] pty — `args_to_commandline` drop arg = " " (1 space đơn)

- **File**: `crates/pty/src/windows.rs` — điều kiện quote có `chars().count() > 1`.
- **Kết luận**: ĐÃ VERIFY trực tiếp nguồn node-pty `src/windowsPtyAgent.ts` (fetch GitHub) — upstream cũng có `arg.length > 1` y hệt → port faithful 1:1, quirk là của upstream. Battery test 22 case mirror chính xác test chính thức của node-pty. Giữ nguyên để preserve parity.

### [P3] pty — `exit_code() as i32` truncation Windows STATUS code

- `crates/pty/src/lib.rs` cuối `drain_reader`: 0xC000013A (Ctrl-C) → -1073741510. node-pty trả unsigned. Frontend hiện chỉ so sánh với 0 — chấp nhận được, ghi nhận để không "sửa" lung tung khi bump.

### [P3] pty — kill path đồng bộ không timeout

- `kill_session` (và `pty_kill` napi, `terminal_create` kill-then-spawn) block trên `child.wait()` vô timeout. Nếu tree-kill fail (OpenProcess bị deny) → Tauri command / JS thread block. Điểm cộng: thiết kế `Arc<Mutex<child>>` tách khỏi session lock đã loại deadlock chính (comment còn nguyên). Khuyến nghị: wait có timeout hoặc wait thread phụ khi bump R-backlog.

### [P3] sandbox — ReadOnly/Strict trên Windows là containment MỀM (đã ghi nhận trong code)

- Overlay chỉ che write **tương đối** (cwd=upper) + redirect qua env; write đường TUYỆT ĐỐI và write không-qua-redirect vẫn ra filesystem thật (đúng giới hạn ghi ở `overlay.rs` header + `windows.rs::restrict_writes` no-op 3 blocker). Precheck bỏ qua `>` nhúng trong 1 token là chủ đích (test `overlay_strict_rolls_back_relative_writes` dựa vào điều này). Backlog ACL/codex-sandbox là giải pháp đúng — không có bug mới ở đây ngoài việc cần document rõ cho người dùng JS (`overlay_commit` doc đã nói).

### [P3] sandbox — nhánh `?` trong pipeline chính bỏ `finish_overlay`

- `try_wait()?` / `wait_with_output()?` giữa poll loop: Err → return sớm, overlay session dir (upper/temp/base) không rollback/commit → rác trong temp; child cũng không bị kill trên lỗi IO pipe (rất hiếm). Khuyến nghị: gom các `?` vào nhánh có `finish_overlay` hoặc drop-guard cho OverlaySession.

### [P3] sandbox win_job — IO budget chỉ đếm direct child (đã doc) + poll 25ms

- `GetProcessIoCounters(child_handle)` — cháu không tính; overage giữa 2 poll có thể vượt budget trước khi kill. Đã ghi nhận đúng trong comment `assign`. Chấp nhận ở mức budget best-effort.

### [P3] informational

- `crates/pty/index.d.ts` 0 byte — pattern chung toàn repo (sandbox/codegraph/... cũng 0 byte, chỉ patch/store có nội dung); không phải regression của track này.
- NapiSink `unref` TSFN — sidecar có thể thoát khi session còn sống (đúng chủ đích ghi trong comment; data-cửa sổ cuối cùng có thể mất) — informational.
- `JobGuard` TTL là CPU-user-time limit: process NGỦ không ăn CPU → TTL không backstop được sleeper; wall-clock poll là chính (đúng comment, nêu rõ để không dùng nhầm).

---

## Đánh giá chung các khu đã review

- **`apps/desktop/src-tauri/src/terminal.rs` (extract)**: contract giữ nguyên (terminal_create/write/resize/kill/list, event `terminal-data`/`terminal-exit`, serde rename exitCode); validation shell/cwd giữ hard-error. Tests adapter-level hợp lý. Không phát hiện bug mới trong adapter.
- **`.cargo/config.toml`**: scoping `cfg(all(windows, msvc))` đúng vấn đề GNU-ld /STACK (comment đầy đủ).
- **`scripts/build-native.mjs`**: thêm pty đúng pattern các crate anh em.
- **unsafe/FFI**: `windows-sys` calls (pty) và extern Job Object (sandbox) đều có cặp Open/CloseHandle đúng, không thấy leak handle; `getProcessTimes`/IOCounters struct layout đúng; Toolhelp ThreadEntry32 đủ 7 field đúng layout. `ThreadEntry32.dw_size` set đúng trước snapshot.
- **Test quality**: test sandbox assert outcome thật (state machine, QueryInformationJobObject đọc lại flags, io-budget kill thật với node, tree-kill thật với cmd-copy unique name) — có ý nghĩa. 2 test phụ thuộc môi trường: `io_write_budget_kills_runaway_writer` cần `node` trên PATH, `test_kill_session_reaps_process_tree` chậm (~20s) — đáng lưu ý cho CI.

## Kết quả test sau debug

- `cargo test -p ghita-pty -p ghita-sandbox` → **30 + 21 = 51/51 PASS** (sau các sửa trên).
- `cargo clippy -p ghita-pty -p ghita-sandbox -- -D warnings` (cả `--features addon`, `--all-targets`) → **sạch**.
- Không commit/push/tag — toàn bộ thay đổi nằm trong working tree.
