# node-pty — Lượt 1: Tổng quan, tính năng & ưu điểm áp dụng

> **Dự án:** microsoft/node-pty — PTY backend cross-platform đứng sau VS Code/Hyper/Theia (fork của chjj/pty.js) · MIT (3 lớp copyright: Jeffrey/Imms/Microsoft) · ~5.1k dòng TS + 1.8k dòng C++ · clone: `refer_project/desktop/node-pty` (v1.2.0-beta.17-4, commit mới nhất 02/11/2026)
> **Phương pháp:** 2 subagent khảo sát song song 22/11/2026, chỉ đọc mã nguồn. Subagent 1 = tổng quan & tính năng; Subagent 2 = ưu điểm & áp dụng vào Ghita.

## Tóm tắt nhanh (tổng hợp)

- API: `spawn(file, args, options)` → `IPty` (write/resize/kill/clear/setParentWindow/pause/resume) + `onData`/`onExit`; Unix dùng forkpty+execvp (Linux) vs posix_spawn+spawn-helper (macOS); Windows bắt buộc ConPTY (build ≥18309), winpty đã xóa.
- Điểm độc đáo: đóng gói sẵn `conpty.dll` + `OpenConsole.exe` của Windows Terminal trong `third_party/conpty/` (API clear/reparent không phụ thuộc version Windows); drain conout bằng worker_threads chống deadlock ClosePseudoConsole; exit detection bằng thread C++ riêng (kqueue/waitpid) thay vì SIGCHLD.
- **Khuyến nghị số 1 cho Ghita:** KHÔNG dùng node-pty trực tiếp (Tauri = Rust, addon Node không nhúng được) — dùng crate Rust **portable-pty** (MIT) và mượn 5 pattern: ConPTY 2-phase + drain-before-close, kill-tree console-aware (AttachConsole + GetConsoleProcessList), resize có pixel size, exit `{exitCode, signal}` thống nhất, escape commandline chuẩn CommandLineToArgvW.
- License MIT an toàn cho Ghita; credit tmux (ISC) nếu vendor `pty_getproc`. Rủi ro: node-gyp cần MSVC/Python, đuổi theo MS API, PTY không sandbox → agent phải gate lệnh ở tầng Ghita.

---

# node-pty — Subagent 1: Tổng quan & tính năng

> Repo khảo sát: `D:\GHITA AGENT\refer_project\desktop\node-pty` (clone microsoft/node-pty, HEAD `v1.2.0-beta.17-4-g35c28c7`, commit mới nhất 2026-11-02).

## 1. Dự án là gì

- **node-pty = "Fork pseudoterminals in Node.JS"** (`package.json:5`), tức binding cho `forkpty(3)`: cho phép Node.js spawn một tiến trình con gắn với **pseudo-terminal (PTY)** — terminal có `TERM`,-cols/rows, phản hồi control sequence như một terminal thật (`README.md:5-11`).
- **Vấn đề giải quyết**: Node chỉ có `child_process` (pipe thuần, không có tty). Muốn chạy bash/powershell bên trong một UI (VS Code terminal, Hyper...) cần PTY để chương trình con bật chế độ interactive, echo, màu ANSI, signal... node-pty lấp chỗ trống đó, hoạt động **cross-platform** (Linux/macOS/Windows) với một API duy nhất.
- **Ai dùng**: chính thức liệt kê trong `README.md:45-73` — **VS Code** (dẫn động lộ trình release, xem `README.md:88`), **Hyper**, **Theia**, **electerm**, **Extraterm**, **Wetty**, **OpenSumi**, ENiGMA½ BBS, NxShell... Tức là node-pty là **nền tảng hạ tầng terminal của cả hệ sinh thái Electron/Node**.
- **Nguồn gốc**: fork từ `chjj/pty.js` với mục tiêu hỗ trợ Node mới + Windows (`README.md:156-158`); license ghi 3 lớp copyright: Christopher Jeffrey 2012-2015, Daniel Imms 2016, Microsoft 2018 (`README.md:160-164`).

## 2. Kho tính năng / API

### 2.1 Hàm export (`src/index.ts`)

| Export                       | Ghi chú                                                              | Bằng chứng                                             |
| ---------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------ |
| `spawn(file, args, options)` | API chính, route theo platform sang `WindowsTerminal`/`UnixTerminal` | `src/index.ts:30-32`, `src/index.ts:12-16`             |
| `fork()`                     | deprecated alias của spawn                                           | `src/index.ts:35-37`                                   |
| `createTerminal()`           | deprecated alias                                                     | `src/index.ts:40-42`                                   |
| `open(options)`              | openpty thuần (không fork child) — **chỉ Unix**, Windows throw       | `src/index.ts:44-46`, `src/windowsTerminal.ts:141-143` |
| `native`                     | expose module `.node` thô, "not public API", chỉ non-Windows         | `src/index.ts:52`                                      |

### 2.2 Spawn options (`typings/node-pty.d.ts`)

- **Dùng chung** `IBasePtyForkOptions` (`typings/node-pty.d.ts:20-77`): `name` (đặt `$TERM`), `cols`, `rows`, `cwd`, `env`, `encoding?: string|null` (null = nhận Buffer nhị phân thay vì string), `handleFlowControl`, `flowControlPause`, `flowControlResume` (3 cái sau đánh dấu EXPERIMENTAL).
- **Unix-only** `IPtyForkOptions` (`typings/node-pty.d.ts:79-86`): `uid`, `gid` — kèm cảnh báo bảo mật về leak file descriptor đặc quyền.
- **Windows-only** `IWindowsPtyForkOptions` (`typings/node-pty.d.ts:88-112`):
  - `useConpty` — **deprecated, bị bỏ qua** vì winpty đã bị xóa hoàn toàn (`README.md:14`, issue #871).
  - `useConptyDll` — dùng `conpty.dll` đóng gói sẵn trong package thay vì kernel32 của Windows.
  - `conptyInheritCursor` — flag `PSEUDOCONSOLE_INHERIT_CURSOR` (`src/win/conpty.cc:293`).
- `args` kiểu `string[]` (argv) hoặc `string` (command line đã escape, chỉ Windows); trên Unix string sẽ throw (`src/unixTerminal.ts:50-52`).

### 2.3 Đối tượng IPty — methods & events (`typings/node-pty.d.ts:117-216`)

- **Properties**: `pid`, `cols`, `rows`, `process` (tên tiến trình foreground), `handleFlowControl` (bật/tắt lúc runtime).
- **Methods**:
  - `write(data: string | Buffer)` (`:197`) — có interceptor flow-control ở `src/terminal.ts:79-93`.
  - `resize(columns, rows, pixelSize?)` (`:166`) — `pixelSize` set `ws_xpixel/ws_ypixel` trên Unix qua `TIOCGWINSZ`, bỏ qua trên Windows; Unix validate số dương (`src/unixTerminal.ts:271-274`).
  - `kill(signal?)` (`:205`) — mặc định `SIGHUP`; Windows **throw** nếu truyền signal (`src/windowsTerminal.ts:178-186`); Unix dùng `process.kill` (`src/unixTerminal.ts:249-253`).
  - `clear()` (`:174`) — no-op trên Unix, chỉ có tác dụng trên Windows/ConPTY để đồng bộ buffer với frontend.
  - `setParentWindow(handle: Buffer)` (`:191`) — **mới tháng 10/2026**: ConPTY làm cửa sổ host thành owner của console window (cho dialog sign-in nổi đúng); chỉ hoạt động với `useConptyDll` (commit `1012192`, `src/win/conpty.cc:591-611`).
  - `pause()` / `resume()` (`:208-215`) — pause/resume socket đọc (flow control tùy biến), trên `src/terminal.ts:129-137` ủy quyền cho `net.Socket`.
- **Events**: `onData: IEvent<string>` và `onExit: IEvent<{exitCode, signal?}>` — kiểu listener trả về `IDisposable` (`:149-156`); nội bộ dùng `EventEmitter2` tự viết (`src/eventEmitter2.ts`, 48 dòng). Ngoài ra tầng `ITerminal` nội bộ còn ủy quyền toàn bộ `on/once/emit/listeners` xuống socket, event `'close'` tách qua `_internalee` (`src/terminal.ts:149-163`, `src/interfaces.ts:93-160`).
- Mặc định: 80×24 (`src/terminal.ts:13-14`), file mặc định `sh`/`cmd.exe` (`src/unixTerminal.ts:22`, `src/windowsTerminal.ts:14`), TERM mặc định `xterm`.

### 2.4 Windows specifics (ConPTY)

- **winpty đã bị xóa sạch** — không còn code winpty trong `src/`, chỉ còn comment "copied from winpty project" cho hàm escape (`src/windowsPtyAgent.ts:293-295`); yêu cầu Windows 10 1809+ (build 18309) (`README.md:14`).
- Native addon `conpty.node`: `CreatePseudoConsole` lấy bằng `GetProcAddress` từ kernel32, hoặc load `conpty\conpty.dll` đóng gói khi `useConptyDll` (`src/win/conpty.cc:170-190, 211`).
- **third_party/conpty/1.25.260303002/** (bản Windows Terminal) chứa `conpty.dll` + `OpenConsole.exe` cho `win10-x64` và `win10-arm64` — cho phép dùng API mới (`ConptyClearPseudoConsole`, `ConptyReparentPseudoConsole`) kể cả khi Windows cũ (`src/win/conpty.cc:534-552, 591-611`).
- Tạo process bằng `CreateProcessW` + `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`, `bInheritHandles=false` ("VERY IMPORTANT") (`src/win/conpty.cc:432-444`); stdin/stdout nối qua named pipe `conin`/`conout`.
- **ConOUT phải được drain ở worker thread riêng** để tránh deadlock khi `ClosePseudoConsole` (`src/windowsConoutConnection.ts:22-30`, tham chiếu issue #375, vscode#76548); sau đó `conptyNative.connect()` mới gọi `ConnectNamedPipe` (`src/windowsPtyAgent.ts:96-124`).
- `kill()` lấy toàn bộ console process list bằng cách **fork một process con** `conpty_console_list_agent` rồi `process.kill` từng PID (`src/windowsPtyAgent.ts:206-252`).
- Thứ tự thực thi defer: mọi write/resize/kill đều được xếp hàng tới khi nhận data đầu tiên (`ready_datapipe`) (`src/windowsTerminal.ts:67-91, 129-186`).
- `SetConsoleCtrlHandler(NULL, FALSE)` khôi phục Ctrl+C mặc định (`src/win/conpty.cc:297`).

### 2.5 Unix specifics

- **Hai đường spawn khác nhau** trong `src/unix/pty.cc`:
  - **Linux/FreeBSD**: `forkpty(3)` (`pty.cc:439`), chặn toàn bộ signal quanh fork để tránh race trong openpty, child reset mọi signal handler về SIG_DFL, `chdir` → `setgid/setuid` → `pty_close_inherited_fds` (chống leak master fd) → `execvp` (`pty.cc:431-489`).
  - **macOS/OpenBSD**: `pty_posix_spawn()` với `POSIX_SPAWN_CLOEXEC_DEFAULT|SETSIGDEF|SETSIGMASK|SETSID`, `posix_openpt/grantpt/unlockpt`, lấy slave name bằng `ioctl(TIOCPTYGNAME)` thay vì `ptsname()` để **tránh vấn đề threading** (`pty.cc:739-830`, đặc biệt `pty.cc:780-786`); kèm binary helper `spawn-helper` 23 dòng mở slave tty để có controlling terminal rồi `chdir`+`execvp` (`src/unix/spawn-helper.cc:6-22`).
- **Resize**: `ioctl(TIOCSWINSZ)` (`pty.cc:567, 810`); openpty dùng cho `open()` (`pty.cc:524`).
- **Xử lý exit KHÔNG dùng SIGCHLD**: `SetupExitCallback` tạo `std::thread` riêng + `Napi::ThreadSafeFunction` (tránh giới hạn `UV_THREADPOOL_SIZE` — `pty.cc:149-153`); trên macOS dùng **kqueue `EVFILT_PROC/NOTE_EXIT`** (`pty.cc:170-199`), trên Linux dùng vòng `waitpid` (`pty.cc:200-216`); trả `{exit_code, signal_code}` về JS.
- Slave fd bọc trong `tty.ReadStream`; ghi qua `CustomWriteStream` tự viết xử lý backpressure/EAGAIN bằng `setImmediate`, ghi chú workaround bug readline của bash 3.2 trên macOS (`src/unixTerminal.ts:321-394`, issue #833).
- Dọn env khi `opt.env === process.env`: xóa `TMUX`, `TMUX_PANE`, `STY`, `WINDOW`, `WINDOWID`, `TERMCAP`, `COLUMNS`, `LINES` (`src/unixTerminal.ts:291-306`); tự set `TERM`/`PWD` (`unixTerminal.ts:66-73`).
- Lấy tên tiến trình foreground: `pty_getproc` — đọc `/proc` trên Linux, `libproc`/sysctl trên macOS (`pty.cc:61-72`, dùng ở `src/unixTerminal.ts:258-265`).

### 2.6 Platform hỗ trợ

- Runtime: Linux, macOS, Windows 10 1809+; FreeBSD/OpenBSD có include tương ứng (`pty.cc:44-50`) nhưng CI chỉ test ubuntu 22.04 (x64/arm), macOS 14/15, Windows Server 2022 + Windows 11 ARM (`.github/workflows/ci.yml` build-test matrix).
- Node 16+/Electron 19+ (`README.md:88`); devEngines ép Node ≥24 khi phát triển (`package.json` devEngines).

## 3. Trạng thái dự án

- **License**: MIT, file `LICENSE` chứa 3 khối bản quyền (Christopher Jeffrey / Daniel Imms / Microsoft) — khớp `package.json:license: "MIT"`.
- **Ngôn ngữ**: TypeScript (~5.125 dòng trong 20 file `.ts` của `src/` + `typings/`) + **C++ native 1.787 dòng** (`pty.cc` 876 dòng cho Unix, `conpty.cc` 682 dòng cho Windows, `spawn-helper.cc`, `path_util.cc`, `conpty_console_list.cc`) — build bằng node-gyp (`binding.gyp`), binding qua `node-addon-api ^7.1.0` (dependency runtime duy nhất, `package.json` dependencies).
- **Cấu trúc top-level**: `src/` (TS + C++), `typings/node-pty.d.ts` (API công khai chính thức), `scripts/` (prebuild/post-install), `third_party/conpty/` (dll + OpenConsole), `examples/` (electron, fork, killDeepTree), `test/`, `pipelines/`, `publish.yml`, `.github/workflows/ci.yml`.
- **Version**: `package.json` = **1.1.0** (bản stable đã phát hành); clone đang ở nhánh beta **v1.2.0-beta.17-4** (git describe) — series 1.2.0-beta phát hành liên tục đến beta.17.
- **Activity**: rất tích cực — commit mới nhất 2026-11-02, tháng 10/2026 có feature mới `setParentWindow` (commit `1012192`, PR #995) và nhiều commit hạ tầng publish/Node 24. Kích thước repo ~15MB.
- **Phân phối native**: `install` script = `node scripts/prebuild.js || node-gyp rebuild` (`package.json:40`) — dùng prebuilt binary theo `<platform>-<arch>`, opt-out bằng `npm_config_build_from_source` (`scripts/prebuild.js:20-24`); loader thử `build/Release` → `build/Debug` → `prebuilds/` (`src/utils.ts:10-24`); có xử lý `app.asar.unpacked` cho Electron (`src/unixTerminal.ts:19-20`).
- **Khardening bảo mật khi build**: Spectre mitigation, `/guard:cf`, `/sdl`, `-fstack-protector-strong` (`binding.gyp:7-30`).

## 4. 5 điểm độc đáo nhất

1. **Đóng gói cả ConPTY của Windows Terminal** (`third_party/conpty/1.25.260303002/` gồm `conpty.dll` + `OpenConsole.exe`): consumer có thể opt-in `useConptyDll` để dùng API ConPTY mới nhất (clear buffer, reparent window, release) **không phụ thuộc version Windows cài đặt** — không PTY library nào khác làm điều này.
2. **Kiến trúc chống deadlock trên Windows**: conout được drain trong `worker_threads` riêng trước khi `connect()` gọi `ConnectNamedPipe`, có timeout 5s và luồng fail-safe (`src/windowsPtyAgent.ts:96-125`) — giải quyết lớp bug nổi tiếng (#375, vscode#76548) mà mỗi terminal emulator tự mò sẽ chết.
3. **Exit notification bằng thread + kqueue/waitpid thay vì SIGCHLD**: mỗi pty có một thread C++ riêng chờ exit (kqueue trên macOS, `waitpid` trên Linux) đẩy kết quả qua `Napi::ThreadSafeFunction` (`src/unix/pty.cc:149-250`) — không can thiệp global signal handler của process Node, không bị chặn bởi `UV_THREADPOOL_SIZE`.
4. **Hai pipeline spawn Unix hoàn toàn khác nhau cho cùng một API**: `forkpty+execvp` trên Linux vs `posix_spawn` với đầy đủ flags + binary `spawn-helper` riêng trên macOS/OpenBSD (kể cả mẹo `TIOCPTYGNAME` thay `ptsname` vì vấn đề thread-safe) (`src/unix/pty.cc:415-494` vs `739-830`, `spawn-helper.cc`) — mức độ chuyên sâu PTY hiếm thấy.
5. **Flow control XON/XOFF tùy biến ngay trong thư viện**: chặn chuỗi pause/resume ở tầng JS trước khi ghi xuống pty, cấu hình được chuỗi thay thế để tránh đụng độ với app tái định nghĩa XON/XOFF (oh-my-zsh) (`src/terminal.ts:21-22, 79-93`, `README.md:125-146`) — giải quyết mất dữ liệu khi buffer terminal tràn.

## 5. Cảnh báo / giới hạn đáng chú ý

- **Không thread-safe**: chạy node-pty trong nhiều worker thread sẽ lỗi (`README.md:123`).
- ConPTY build ≥18309 bắt buộc; build 17134 có ConPTY nhưng "quá unstable" để bật mặc định (`typings/node-pty.d.ts:90-95`).
- Windows: không hỗ trợ `encoding`, không hỗ trợ signal trong `kill`, `open()` không khả dụng (`src/windowsTerminal.ts:33-35, 141-143, 178-186`).
- Cảnh báo bảo mật README: process con chạy cùng quyền level process cha, khuyến nghị chạy trong container nếu expose ra internet (`README.md:119`).

---

# node-pty — Subagent 2: Ưu điểm & áp dụng vào Ghita

> Repo phân tích: `D:\GHITA AGENT\refer_project\desktop\node-pty` (microsoft/node-pty v1.1.0, chỉ đọc).
> Mọi path dưới đây là tương đối trong repo đó, kèm dòng để đối chiếu.

## 0. Tổng quan nhanh

- Kiến trúc: JS layer (`src/*.ts`) + 2 native addon node-api: `pty.node` (Unix, `src/unix/pty.cc`) và `conpty.node` (Windows, `src/win/conpty.cc`) + `conpty_console_list.node` (kill-tree helper).
- Nhịp hoạt động: `spawn()` → chọn Terminal class theo platform (`src/index.ts:12-16`) → native fork/connect → `net.Socket`/`tty.ReadStream` bọc fd → `onData`/`onExit` events.
- Sản phẩm thực chiến: powers VS Code, Hyper, Theia, electerm (README "Real-world Uses").

## 1. Ưu điểm nổi bật (xếp hạng theo giá trị kỹ thuật)

1. **API surface nhỏ mà đủ** — `typings/node-pty.d.ts:18` chỉ xuất `spawn` (+`open`, +2 deprecated); `IPty` gồm đúng những gì terminal UI cần: `onData/onExit/write/resize/kill/pause/resume/clear/setParentWindow` (`typings/node-pty.d.ts:117-216`). Kể cả flow control XON/XOFF customize được (`typings/node-pty.d.ts:64-76`, `src/terminal.ts:21-22,79-93`).
2. **Abstraction per-platform sạch** — abstract `Terminal` giữ phần chung (flow control, type-check cho JS callers, env parsing: `src/terminal.ts:52-117`); platform-specific tách hẳn `UnixTerminal`/`WindowsTerminal`. Native API khác nhau hoàn toàn (`pty.fork` vs `conpty.startProcess+connect`) nhưng không lộ ra ngoài.
3. **Process lifecycle Unix chuẩn mực**: block toàn bộ signals trước `forkpty` để tránh race + reset sigaction trong child (`src/unix/pty.cc:430-449`); `close_range()` (Linux 5.9+) hoặc set CLOEXEC thủ công chống rò fd sang child (`src/unix/pty.cc:127-147,477`); macOS dùng `posix_spawn` với `POSIX_SPAWN_CLOEXEC_DEFAULT|SETSID` và spawn-helper binary để có controlling terminal đúng cách (`src/unix/pty.cc:739-861`, `src/unix/spawn-helper.cc:5-16`).
4. **Exit detection hai nhánh platform, xử lý cả race**: Linux `waitpid` trong thread riêng qua `Napi::ThreadSafeFunction` (không đụng UV_THREADPOOL_SIZE); macOS kqueue `EVFILT_PROC/NOTE_EXIT` + xử lý "zombie death race" bằng `waitpid(WNOHANG)` → SIGKILL fallback (`src/unix/pty.cc:149-250`). Trả về `{exitCode, signal}` phân biệt WEXITSTATUS/WTERMSIG (`src/unix/pty.cc:225-231`).
5. **Kill process tree trên Windows đúng bản chất console**: fork 1 process con ngắn hạn chạy `conpty_console_list` addon — `FreeConsole()` + `AttachConsole(pid)` + `GetConsoleProcessList()` để lấy đúng các process đang gắn console, rồi `process.kill()` từng PID (`src/windowsPtyAgent.ts:215-223,236-252`, `src/win/conpty_console_list.cc:18-30`, `src/conpty_console_list_agent.ts`). Đây là cách chính xác hơn `taskkill /T` vì bắt cả process detach. Kèm `ClosePseudoConsole` + `TerminateProcess` fallback khi dùng bundled dll (`src/win/conpty.cc:619-666`).
6. **ConPTY 2-phase spawn chống block event loop**: `startProcess` tạo named pipes conin/conout trước; chỉ gọi `ConnectNamedPipe` (bản chất blocking) sau khi conout đã có client kết nối từ worker thread (`src/windowsPtyAgent.ts:99-124`, `src/win/conpty.cc:388-389`). Fix issue #763 — pattern bắt buộc nếu ai tự viết ConPTY.
7. **Tránh deadlock khi đóng ConPTY**: conout phải được drain trên `worker_threads` riêng, vì `ClosePseudoConsole` chờ conout drain trong khi terminal đang xuất dữ liệu (`src/windowsConoutConnection.ts:19-30` trích dẫn vscode#76548, terminal#1810); kèm timeout 5s cho kết nối (`src/windowsPtyAgent.ts:24,110-112`).
8. **Buffering/backpressure chủ động**: `CustomWriteStream` (Unix) tự queue write vào fd, xử lý EAGAIN bằng `setImmediate` retry, giữ đúng thứ tự, không dùng `net.Socket` wrapper hay bị mask lỗi (`src/unixTerminal.ts:321-395`); comment ghi rõ trade-off bash 3.2 macOS (issue #833).
9. **Error handling quanh "process chết" chi li theo trải nghiệm thật**: swallow EAGAIN/EIO/errno-5 khi child chết (`src/unixTerminal.ts:115-145`, `src/windowsTerminal.ts:94-110`); macOS race socket không bao giờ close → timer 200ms destroy (`src/unixTerminal.ts:78-103`); Windows flush dữ liệu cuối 1s sau exit trước khi destroy socket (`src/windowsPtyAgent.ts:23,265-290`).
10. **Backward-compat & defensive coding**: deprecated aliases `fork`/`createTerminal` (`src/index.ts:34-42`); `useConpty` deprecated có ghi chú issue #871 (`typings/node-pty.d.ts:88-97`); `_checkType` chặn sai kiểu từ JS trước khi xuống C++ (`src/terminal.ts:65-74`); mutex bảo vệ baton list trong native (`src/win/conpty.cc:58-72`); build flags hardening `/guard:cf /sdl Spectre -fstack-protector-strong` (`binding.gyp:7-33`).

## 2. Cái hay áp dụng vào Ghita

### (a) node-pty làm dependency cho terminal desktop?

- **License: MIT — ĐẠT.** `package.json:21` khai báo `"license": "MIT"`; file `LICENSE` gồm 3 khối MIT (Christopher Jeffrey 2012-2015, Daniel Imms 2016, Microsoft). Không GPL/AGPL. Hai điểm phụ cần credit khi vendor: `pty_getproc` chép từ tmux (ISC, tương thích — `src/unix/pty.cc:639-654`) và `third_party/conpty/*/conpty.dll + OpenConsole.exe` (bản build từ microsoft/terminal, MIT).
- **Build**: `install: node scripts/prebuild.js || node-gyp rebuild` (`package.json:scripts.install`) → ưu tiên prebuilt trong `prebuilds/<platform>-<arch>`, fallback node-gyp; CI build 6 nền tảng x64/arm64 (`pipelines/prebuilds.yml`). Loader runtime thử `build/Release → build/Debug → prebuilds` (`src/utils.ts:12-29`). Cần compiler MSVC + Python nếu không có prebuild. Lưu ý cứng: `devEngines.runtime >= node 24` (`package.json`).
- **Khớp Ghita không trọn vẹn**: apps/desktop là **Tauri (Rust)** — node-pty là Node native addon, không nhúng được vào Rust main process. Nó chỉ hợp nếu Ghita chạy sidecar Node (giống pattern packages TS). **Khuyến nghị: dùng crate Rust `portable-pty` (wezterm, MIT) cho backend PTY của Tauri, và mượn thiết kế của node-pty ở tầng API/bản đồ hành vi.** Giá trị node-pty trực tiếp: trung; giá trị tham khảo thiết kế: cao.

### (b) Pattern đáng lấy (giá trị / độ khó khi port sang Rust)

| Pattern                                                                                                       | Bằng chứng                                                                                                   | Giá trị                                      | Độ khó với Rust/portable-pty                                                                                                     |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| ConPTY spawn 2-phase + named pipes conin/conout, chỉ `ConnectNamedPipe` khi client sẵn sàng                   | `src/windowsPtyAgent.ts:99-124`, `src/win/conpty.cc:293-326,388-389`                                         | cao                                          | trung (portable-pty đã làm sẵn; tự viết thì dễ sai)                                                                              |
| Kill process tree qua `GetConsoleProcessList` (AttachConsole trong process tạm) — chính xác hơn `taskkill /T` | `src/win/conpty_console_list.cc:18-30`, `src/conpty_console_list_agent.ts`, `src/windowsPtyAgent.ts:215-252` | cao                                          | trung (Rust: 1 lần dùng `CreateToolhelp32Snapshot` hoặc gọi `taskkill /PID x /T /F` là đủ; portable-pty có `kill(TreePriority)`) |
| Resize: `ioctl(TIOCSWINSZ)` + pixel size; Windows `ResizePseudoConsole`                                       | `src/unix/pty.cc:546-582`, `src/unixTerminal.ts:271-280`, `src/win/conpty.cc:482-519`                        | cao                                          | dễ (portable-pty `resize` + `PtySize{cols,rows,pixel_width,pixel_height}`)                                                       |
| Exit codes + signals tách bạch: `WEXITSTATUS`/`WTERMSIG` → `{exitCode, signal}`; Windows `GetExitCodeProcess` | `src/unix/pty.cc:225-231`, `src/win/conpty.cc:99-104`                                                        | cao                                          | dễ (nhưng phải gom về 1 event type thống nhất)                                                                                   |
| Drain conout bằng worker thread riêng + flush deadline 1s trước khi đóng (chống deadlock ConPTY)              | `src/windowsConoutConnection.ts:19-30,93-102`, `src/windowsPtyAgent.ts:23,265-290`                           | cao                                          | trung (Rust: spawn task đọc conout trước khi `close()`; bỏ qua = treo terminal khi exit có output)                               |
| Write queue với EAGAIN-retry, giữ order, không mask lỗi                                                       | `src/unixTerminal.ts:321-395`                                                                                | trung                                        | dễ (Rust: blocking write + thread; tokio app thì backpressure tự nhiên)                                                          |
| `argsToCommandLine` escape chuẩn CommandLineToArgvW (backslash + quote)                                       | `src/windowsPtyAgent.ts:296-346`                                                                             | cao (agent Ghita chạy lệnh Windows liên tục) | dễ (reuse thuật toán; hoặc dùng `std::process::Command` trên Rust vẫn cần cho commandline-string của ConPTY)                     |
| Sanitize env trước spawn (TMUX/STY/WINDOWID/COLUMNS/LINES/TERM)                                               | `src/unixTerminal.ts:291-306`                                                                                | trung                                        | dễ                                                                                                                               |
| Flow control XON/XOFF tùy biến, chuyển message → pause/resume socket                                          | `src/terminal.ts:21-22,79-93`                                                                                | thấp-trung                                   | dễ                                                                                                                               |
| Typed event `IEvent<T>` trả `IDisposable` (VS Code style) thay vì EventEmitter stringly                       | `src/eventEmitter2.ts:15-48`, `typings/node-pty.d.ts:229-231`                                                | cao cho packages TS Ghita                    | dễ                                                                                                                               |

### (c) Mapping vào cấu trúc Ghita

- **crates Rust (khuyến nghị chính)**: tạo `crates/ghita-pty` bọc `portable-pty`; port API shape của node-pty: `spawn(shell, args, {cwd, env, cols, rows})` → `PtySession { read_stream, writer, resize(), kill(), on_exit }`. Feature `addon` + `src/napi.rs` chỉ cần nếu muốn expose Pty cho sidecar Node (nạp qua packages/native-bridge như pattern hiện có).
- **apps/desktop terminal**: xterm.js UI → Tauri command/channel stream bytes từ ghita-pty; dùng `clear()` semantics của ConPTY (sync buffer backend/frontend: `typings/node-pty.d.ts:168-174`, `src/win/conpty.cc:521-558`) khi xterm.js clear.
- **packages/communication** (hoặc package `ghita/pty` TS): nếu agent-side TS cần chạy lệnh qua PTY, expose API giống `IPty` (onData/onExit/write/resize/kill) để UI và agent dùng chung; giữ tên event `onData`/`onExit` cho quen thuộc với hệ sinh thái xterm.
- **Agent chạy lệnh trong PTY**: lấy pattern exit `{exitCode, signal}` để agent đánh giá kết quả lệnh; dùng kill-tree pattern khi user hủy lệnh đang chạy (Ctrl-C qua `write('\x03')` hoặc kill tree thật).

## 3. Hạn chế / rủi ro

- **Native build Windows**: node-gyp cần VS Build Tools + Python; không có prebuild là chặn CI. Tauri không dùng được addon Node trực tiếp → nói ở (a). Thêm `devEngines` Node>=24 ràng buộc môi trường (`package.json`).
- **Bảo trì với MS API thay đổi**: phải `GetProcAddress` từng API ConPTY vì kernel32 theo bản build Windows (`src/win/conpty.cc:30-42,209-211`); nhánh `useConptyDll` thêm một biến thể API nữa (`ConptyCreatePseudoConsole`, `ConptyReparentPseudoConsole` chỉ có trong bundled dll: `src/win/conpty.cc:44-45,591-594`). Dính theo = theo dõi microsoft/terminal liên tục.
- **Shipping binary**: `third_party/conpty/1.25.260303002/` dll+exe ~ hàng MB vào npm package (`scripts/post-install.js` copy vào build/Release) — review supply-chain và kích thước package tăng.
- **Security khi agent chạy trong PTY**: node-pty không sandbox — child có toàn quyền user; agent Ghita cần gate lệnh trước khi đưa vào PTY (allowlist/prompt), giữ TERM/env sạch như `unixTerminal._sanitizeEnv`, chặn FD leak (như `pty_close_inherited_fds`) nếu tự port.
- **Chi tiết platform còn lộ**: `args` dạng string bị chặn trên Unix (`src/unixTerminal.ts:50-52`); `encoding` không hỗ trợ trên Windows (`src/windowsTerminal.ts:33-35`); `kill(signal)` throw trên Windows (`src/windowsTerminal.ts:178-186`); `WindowsTerminal.process` trả tên shell tĩnh, không phải foreground process (`src/windowsTerminal.ts:214`).

## 4. Ba thứ KHÔNG nên học

1. **Giữ rác deprecated trong API công khai**: `fork`, `createTerminal`, `open` positional-args cũ vẫn tồn tại vì compat (`src/index.ts:34-42`, `src/unixTerminal.ts:181-190`). Ghita 0.0.2-alpha chỉ nên có MỘT entry-point `spawn` — app riêng không cần gánh lịch sử của VS Code.
2. **Một thread chặn cho mỗi PTY để đợi exit**: cả Unix lẫn Windows đều `new std::thread` + `waitpid`/`WaitForSingleObject(INFINITE)` cho từng terminal (`src/unix/pty.cc:149-163`, `src/win/conpty.cc:78-91`). Mở 20 tab = 20 thread idle. Port sang Rust thì dùng 1 task async/conwait thread gộp, hoặc event từ portable-pty.
3. **Pipe name random + hack nội bộ**: `conpty-${Math.random() * 10000000}` dễ trùng và không cryptographic (`src/windowsPtyAgent.ts:258-260`); kèm các `HACK: This is unsafe` và kênh event 2 lớp (`_socket` + `_internalee` special-casing 'close': `src/terminal.ts:25,150-163`). Thiết kế Ghita nên dùng GUID/uuid cho pipe và một event model nhất quán ngay từ đầu.

## 5. Kết luận cho Ghita

- Không bán phụ thuộc node-pty cho Tauri; **portable-pty + thiết kế mượn từ node-pty** là tuyến tính tối ưu (license MIT cả hai).
- 5 pattern bắt buộc port: ConPTY 2-phase + drain conout trước khi close; kill process tree console-aware; resize có pixel size; `{exitCode, signal}` thống nhất; escape commandline Windows chuẩn CommandLineToArgvW.
- API cho packages TS của Ghita: copy shape `IEvent<T> → IDisposable` của `eventEmitter2.ts` — chi phí thấp, đỡ nhiều về sau.
