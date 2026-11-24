# node-pty — Lượt 2: Kiến trúc & thuật toán

> **Dự án:** microsoft/node-pty v1.1.0 (post-refactor — winpty đã xóa sạch) · clone: `refer_project/desktop/node-pty`
> **Phương pháp:** 2 subagent đọc sâu song song 22/11/2026, chỉ đọc mã nguồn. Subagent 1 = kiến trúc; Subagent 2 = thuật toán & kỹ thuật cốt lõi.

## Tóm tắt nhanh (tổng hợp)

- **Kiến trúc:** `Terminal` abstract (`src/terminal.ts`) → `WindowsTerminal` + `WindowsPtyAgent` + `ConoutConnection` (drain conout bằng worker_threads) HOẶC `UnixTerminal` (forkpty/posix_spawn + tty.ReadStream + CustomWriteStream tự xử EAGAIN); chọn backend bằng `require` điều kiện (`src/index.ts:12-16`); build node-gyp/node-addon-api, prebuild tự chế 6 combo qua AzDO, conpty.dll versioned `third_party/conpty/1.25.260303002`, CI matrix 6 OS.
- **Luồng Windows:** startProcess tạo 2 named pipe + CreatePseudoConsole → worker READY → outSocket relay → native.connect (CreateProcessW + PSEUDOCONSOLE attribute) → data pipe→worker→socket→onData; exit qua thread C++ + ThreadSafeFunction.
- **Thuật toán đáng học:** ConPTY 2-phase init (ConnectNamedPipe sync → bắt buộc chờ worker ready, timeout 5s fail sạch — deadlock được chứng minh bằng ETW); drain conout trước ClosePseudoConsole + flush đuôi 1000ms; kill-tree bằng helper process FreeConsole→AttachConsole→GetConsoleProcessList (theo quan hệ console, chính xác hơn taskkill /T — còn race PID-reuse chưa fix); Unix block-signal quanh forkpty + close_range(CLOEXEC) + exit thread waitpid/kqueue (không SIGCHLD vì libuv chiếm); write queue {buffer, offset} + EAGAIN→setImmediate retry (không cap — Ghita nên thêm backpressure); resize Unix có pixel size, Windows chỉ COORD.
- **Điểm yếu:** handshake Windows nhiều tầng dựa timer + pipe name `Math.random()`, trạng thái global C++ `ptyHandles` dễ rò handle, API bất đối xứng + legacy.
- **Kết luận cho Ghita:** 9 khuyến nghị port pattern sang Rust (portable-pty) — xem Phần B.

---

# node-pty — Subagent 1: Kiến trúc

> Đối tượng phân tích: `D:\GHITA AGENT\refer_project\desktop\node-pty` — clone microsoft/node-pty, `package.json` version **1.1.0** (`package.json:7`). Chỉ đọc, không chạy code.

## 0. Lưu ý lệch pha với đề bài

Đề bài nhắc `ConPtyTerm`, `WinPtyAgent`, `PtyFactory/index.ts`, `deps/` — các thực thể này **không tồn tại** ở nhánh 1.1.0 này. Đây là bản sau refactoring lớn: winpty đã bị **xoá hoàn toàn** (grep toàn `src/` chỉ còn 2 comment: `src/interfaces.ts:132`, `src/windowsPtyAgent.ts:295`), backend Windows chỉ còn ConPTY theo 2 chế độ: kernel32 (`CreatePseudoConsole`) hoặc conpty.dll bundle (`useConptyDll`). Việc chọn backend làm bằng `require` có điều kiện trong `index.ts`, không có PtyFactory. Báo cáo dưới mô tả **kiến trúc thực tế**.

## 1. Bản đồ module

| Thành phần                         | Vai trò                                                                                                                                                                                                                        | Bằng chứng                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `src/index.ts`                     | Entry công khai: `spawn()`/`fork()`/`createTerminal()` (deprecated)/`open()`/`native`. Chọn lớp theo platform: `win32 → WindowsTerminal`, ngược lại `UnixTerminal`                                                             | `src/index.ts:12-16,30-32`                             |
| `src/terminal.ts`                  | Base abstract `Terminal implements ITerminal`: event model, flow-control XON/XOFF, kiểm tra kiểu cho JS thuần, passthrough socket (pause/resume/pipe/end)                                                                      | `src/terminal.ts:24-98,120-147`                        |
| `src/interfaces.ts`                | `ITerminal` (contract nội bộ) + `IPtyForkOptions`/`IWindowsPtyForkOptions`                                                                                                                                                     | `src/interfaces.ts:10-148`                             |
| `src/typings công khai`            | `typings/node-pty.d.ts` khai báo `IPty` riêng cho consumer npm                                                                                                                                                                 | `typings/node-pty.d.ts:18,117`                         |
| `src/eventEmitter2.ts`             | `EventEmitter2<T>` + `IEvent<T>` trả về `IDisposable` (pattern event của VSCode)                                                                                                                                               | `src/eventEmitter2.ts:11-48`                           |
| `src/windowsTerminal.ts`           | Wrapper Windows: defer mọi thao tác tới `ready_datapipe`/data đầu tiên                                                                                                                                                         | `src/windowsTerminal.ts:44-91,188-212`                 |
| `src/windowsPtyAgent.ts`           | Agent giữa Terminal và native conpty: out/in socket, handshake kết nối, kill, exitCode, `argsToCommandLine` (escape MSDN, copy từ winpty)                                                                                      | `src/windowsPtyAgent.ts:39-291,296-346`                |
| `src/windowsConoutConnection.ts`   | `ConoutConnection implements IConoutConnection, IDisposable`: spawn worker_threads đọc conout, drain trước khi close                                                                                                           | `src/windowsConoutConnection.ts:37-103`                |
| `src/worker/conoutSocketWorker.ts` | Worker thread: client của pipe `-out`, relay server pipe `<name>-worker`, `pipe()` về main thread                                                                                                                              | `src/worker/conoutSocketWorker.ts:11-22`               |
| `src/shared/conout.ts`             | Hợp đồng worker: `IWorkerData`, `ConoutWorkerMessage.READY`, `getWorkerPipeName`                                                                                                                                               | `src/shared/conout.ts:5-15`                            |
| `src/conpty_console_list_agent.ts` | Tiến trình con (fork) gọi native `getConsoleProcessList` — phải tách tiến trình vì 1 process chỉ attach 1 console                                                                                                              | `src/conpty_console_list_agent.ts:6-22`                |
| `src/unixTerminal.ts`              | Backend Unix: `tty.ReadStream(fd)` đọc + `CustomWriteStream` tự quản write queue/EAGAIN                                                                                                                                        | `src/unixTerminal.ts:26-167,321-395`                   |
| **Ranh giới TS↔C++**               | `src/native.d.ts`: `IConptyNative` (startProcess/connect/resize/clear/reparent/kill) và `IUnixNative` (fork/open/process/resize)                                                                                               | `src/native.d.ts:5-19`                                 |
| `src/win/conpty.cc` (682 dòng)     | napi `conpty.node`: tạo named pipe server, CreatePseudoConsole, CreateProcessW với attribute pseudoconsole, thread chờ exit, resize/clear/reparent/kill                                                                        | `src/win/conpty.cc:672-682`                            |
| `src/win/conpty_console_list.cc`   | napi `conpty_console_list.node`: FreeConsole/AttachConsole/GetConsoleProcessList                                                                                                                                               | `src/win/conpty_console_list.cc:9-44`                  |
| `src/unix/pty.cc` (876 dòng)       | napi `pty.node`: forkpty (Linux/BSD), posix_spawn (macOS), openpty, ioctl TIOCSWINSZ, pty_getproc (từ tmux), thread waitpid/kqueue                                                                                             | `src/unix/pty.cc:868-874`                              |
| `src/unix/spawn-helper.cc`         | Executable macOS (23 dòng): mở lại slave tty để nhận controlling terminal, chdir, execvp                                                                                                                                       | `src/unix/spawn-helper.cc:6-22`                        |
| `src/utils.ts`                     | `loadNativeModule`: chuỗi fallback `build/Release → build/Debug → prebuilds/<platform>-<arch>`, thử cả thư mục cha (unbundled) và thư mục hiện tại (bundled), xử lý asar.unpacked ở caller                                     | `src/utils.ts:12-29`                                   |
| `third_party/conpty/`              | DLL ConPTY bundle: `1.25.260303002/win10-{x64,arm64}/conpty.dll + OpenConsole.exe`                                                                                                                                             | `third_party/conpty/1.25.260303002/`                   |
| `scripts/`                         | `prebuild.js` (exit 0 nếu có prebuild), `post-install.js` (dọn build/, copy dll vào `build/Release/conpty`), `increment-version.js` (beta bump), `linux/install-sysroot.js` + `verify-glibc-requirements.sh` + `checksums.txt` | `scripts/post-install.js:46-74`                        |
| `pipelines/` + `publish.yml`       | Azure DevOps 1ES: build 6 combo → Archive artifact `prebuilds-<sha>`; publish npm beta/stable                                                                                                                                  | `pipelines/prebuilds.yml:23-145`, `publish.yml:35-107` |

Không có thư mục `deps/` ở version này.

## 2. Luồng dữ liệu end-to-end

### Windows — spawn (handshake 4 bước)

1. JS `spawn()` → `new WindowsTerminal` → `new WindowsPtyAgent(...)` (`windowsTerminal.ts:51`).
2. `conptyNative.startProcess(file, cols, rows, debug, pipeName, inheritCursor, useConptyDll)` (`windowsPtyAgent.ts:87`) → conpty.cc: `LoadConptyDll` — kernel32 hoặc `conpty\conpty.dll` cạnh conpty.node (`conpty.cc:166-191`); tạo 2 named-pipe server `\\.\pipe\<pipeName>-in|-out`, 1 instance, byte mode, buffer 128KB (`conpty.cc:138-164`); gọi `CreatePseudoConsole`/`ConptyCreatePseudoConsole` (`conpty.cc:209-229`); trả `{pty: id, fd:-1, conin, conout}`. Pipe name random: `` `conpty-${Math.random()*10000000}` `` (`windowsPtyAgent.ts:258-260`).
3. Trước khi connect: spawn `ConoutConnection` worker **trước** rồi mới `connect()` để `ConnectNamedPipe` không block event loop (fix #763) (`windowsPtyAgent.ts:96-113`). Worker connect vào pipe `-out`, mở relay server `-worker`, gửi READY (`worker/conoutSocketWorker.ts:13-21`).
4. READY → `_outSocket.connect(<name>-worker)` → `conptyNative.connect(pty, cmdline, cwd, env, useConptyDll, exitCb)` (`windowsPtyAgent.ts:114-124,148`) → conpty.cc `PtyConnect`: `ConnectNamedPipe(hIn/hOut)`, `UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE)`, `CreateProcessW` (`conpty.cc:388-444`), đóng handle server-side, optional `ConptyReleasePseudoConsole` (dll), cài thread chờ exit, trả pid.

### Windows — conout → onData

OpenConsole (do ConPTY quản) ghi vào pipe `-out` → worker thread drain (`conoutSocket.pipe(workerSocket)`) → relay `-worker` → `_outSocket` (net.Socket utf8) trong main thread → `WindowsTerminal._socket` → event `'data'` → `_forwardEvents` fire `_onData` → consumer `pty.onData` (`terminal.ts:95-98`). Event `'data'` đầu tiên đặt `_isReady = true` và xả các thao tác deferred (`windowsTerminal.ts:72-91`). Worker thread tồn tại vì `ClosePseudoConsole` deadlock nếu conout không được drain (#375, vscode#76548, terminal#1810 — `windowsConoutConnection.ts:19-30`).

### Windows — write → conin

`write()` → kiểm tra flow-control XON/XOFF (`terminal.ts:79-93`) → defer → `agent.inSocket.write(data)`; inSocket là `new Socket({fd: fs.openSync(term.conin,'w'), readable:false, writable:true})` (`windowsPtyAgent.ts:130-135`) → pipe `-in` → ConPTY đưa vào console input của tiến trình con.

### Windows — resize / clear / setParentWindow / kill

- `resize`: guard sau-exit (`windowsPtyAgent.ts:186-188`) → `ResizePseudoConsole`/`ConptyResizePseudoConsole` (`conpty.cc:482-519`); `pixelSize` bỏ qua trên Windows (`interfaces.ts:31-35`).
- `clear`, `reparent`: **chỉ hoạt động với conpty.dll** (API `ConptyClearPseudoConsole`, `ConptyReparentPseudoConsole` không có trong kernel32) (`conpty.cc:521-558,574-617`; prototype `conpty.h:29-41`).
- `kill`: nhánh !dll — fork `conpty_console_list_agent` lấy process list, `process.kill` từng pid, rồi `ClosePseudoConsole` (`windowsPtyAgent.ts:206-234`, `conpty.cc:619-666`); nhánh dll — destroy inSocket + ClosePseudoConsole + `TerminateProcess(hShell,1)` (`conpty.cc:660-662`).

### Windows — exit flow

Thread C++ `WaitForSingleObject(hShell, INFINITE)` → `GetExitCodeProcess` → xoá baton khỏi `ptyHandles` → `Napi::ThreadSafeFunction::BlockingCall` về main thread (không dùng AsyncWorker vì giới hạn UV_THREADPOOL_SIZE) (`conpty.cc:78-128`) → JS `_$onProcessExit` đặt `_exitCode`, !dll: timer flush 1000ms rồi destroy outSocket (`windowsPtyAgent.ts:265-290`) → socket `'close'` → `emit('exit', exitCode)` (`windowsTerminal.ts:113-116`).

### Unix — fork/spawn

`pty.fork(..., onexit)` (`unixTerminal.ts:106`). Linux/BSD: `forkpty(3)`, child chdir/setuid/setgid, `pty_close_inherited_fds` (close_range trên Linux 5.9+, fallback CLOEXEC), `execvp` (`pty.cc:439-491`). macOS: `posix_spawn` với flags `CLOEXEC_DEFAULT|SETSIGDEF|SETSIGMASK|SETSID`, dup2 slave → std fds, argv[0] = spawn-helper (`pty.cc:759-847`, `spawn-helper.cc:7-21`). termios mặc định set thủ công trong C++, IUTF8 khi encoding utf8 (`pty.cc:350-386`). Master fd nonblock → `tty.ReadStream(fd)` → `'data'` → onData (`unixTerminal.ts:108-111`).

### Unix — write / resize / exit

- Write: `CustomWriteStream` — queue tự viết, `fs.write` thô vào fd, EAGAIN → retry bằng setImmediate; comment ghi rõ lý do tránh wrapper Node che lỗi + bug bash 3.2 (#833) (`unixTerminal.ts:321-395`).
- Resize: `ioctl(fd, TIOCSWINSZ)` với cả ws_xpixel/ws_ypixel (`pty.cc:546-582`; TS `unixTerminal.ts:271-280`).
- Exit: thread C++ — Linux `waitpid` loop; macOS kqueue `EVFILT_PROC/NOTE_EXIT` + xử lý "zombie death race" (`pty.cc:149-250`) → tsfn → JS `onexit(code, signal)` → chờ socket close (guard 200ms cho bug macOS 10.13.2, `unixTerminal.ts:78-103`) → `emit('exit')`.

## 3. Abstraction then chốt

- **`ITerminal`** (`src/interfaces.ts:10-110`): pid/process/write/resize/clear/setParentWindow/destroy/kill/pause/resume/on/listeners... — contract nội bộ; consumer dùng `IPty` trong `typings/node-pty.d.ts:117`.
- **Chọn backend**: `require` theo `process.platform` ngay trong `src/index.ts:12-16` (không có factory pattern; đơn giản nhưng gắn cứng).
- **Base `Terminal`**: giữ socket chung, template method `_write`/`resize`/`clear`/`destroy`/`kill` abstract (`terminal.ts:77,181-189`); event `'close'` đi qua `_internalee` riêng, các event khác delegate xuống socket (`terminal.ts:150-163`).
- **Ba thế hệ backend Windows còn lại 1**: `WindowsTerminal` + `WindowsPtyAgent` + `ConoutConnection`; winpty đã xoá; 2 chế độ ConPTY phân biệt bởi cờ `useConptyDll` xuyên suốt TS→C++.
- **Event model kép**: (a) event socket Node cổ điển cho data/exit phía Terminal; (b) typed `IEvent<T>`/`EventEmitter2<T>` + `IDisposable` cho `onData`/`onExit` (`terminal.ts:43-46`) và sự kiện nội bộ `onError`/`onReady` (`windowsPtyAgent.ts:48-49`, `windowsConoutConnection.ts:31-47`).
- **Seam native**: `IConptyNative`/`IUnixNative` (`src/native.d.ts:5-19`); loader có fallback 6 đường (`src/utils.ts:12-29`). Testability: `IWindowsPtyAgentOptions.conoutConnectionFactory` inject được (`windowsPtyAgent.ts:26-34`).

## 4. Build system

- **node-gyp + node-addon-api ^7.1.0** (`package.json:63`). `binding.gyp`: Windows → targets `conpty` (+shlwapi) và `conpty_console_list`; non-Windows → `pty` (-lutil, trừ mac/solaris) (`binding.gyp:36-75`); macOS thêm executable `spawn-helper` (`binding.gyp:135-148`).
- **Hardening**: Spectre mitigation, `/guard:cf`, `/sdl`, stack-protector (`binding.gyp:7-33`). Linux cross-compile arm64 qua sysroot tải từ vscode-linux-build-agent (checksum trong `scripts/linux/checksums.txt`), verify glibc 2.28 / glibcxx 3.4.25 (`.github/workflows/ci.yml:76-82`).
- **Prebuilt strategy — tự chế, không phải prebuildify/prebuild-install**: pipeline AzDO `prebuilds.yml` build 6 job (win/darwin/linux × x64/arm64) → stage Archive gói artifact `prebuilds-<sha>` (`pipelines/prebuilds.yml:23-145`). Khi user `npm install`: `"install": "node scripts/prebuild.js || node-gyp rebuild"` — prebuild.js exit 0 nếu tồn tại `prebuilds/<platform>-<arch>`, ngược lại build từ source (`package.json:54`, `scripts/prebuild.js:21-34`). `post-install.js` dọn `build/Release` và copy `conpty.dll`/`OpenConsole.exe` từ third_party vào `build/Release/conpty` (`scripts/post-install.js:46-74`). npm package ship cả `prebuilds/`, `third_party/`, `src/**/*.{cc,h}` (`package.json:15-25`).
- **conpty.dll versioning**: thư mục version `third_party/conpty/1.25.260303002/`; post-install lấy thư mục đầu tiên (`readdirSync[0]`) theo arch `win10-x64|win10-arm64` (`scripts/post-install.js:59-73`); runtime nạp DLL từ thư mục chứa conpty.node, resolve export có tiền tố `Conpty*` bằng GetProcAddress (`conpty.cc:172-190,209-211`).
- **CI 6 OS**: GitHub Actions lint + matrix `ubuntu-22.04, macos-14, windows-2022, macos-15-intel, ubuntu-22.04-arm, windows-11-arm` (`.github/workflows/ci.yml:33`); AzDO cho prebuild/publish chính thức (publish beta/stable qua template vscode-engineering, `publish.yml:35-107`).

## 5. Đánh giá kiến trúc

**Điểm mạnh**

1. **Ranh giới platform sạch, test được**: một `ITerminal` + base `Terminal`, contract native đóng gói trong `native.d.ts`, `conoutConnectionFactory` inject để test (`windowsPtyAgent.test.ts`); phần phức tạp Windows bị nhốt trong WindowsPtyAgent/worker, consumer chỉ thấy `spawn()`.
2. **Thiết kế concurrency sắc bén, có dẫn chứng issue**: drain conout bằng worker_threads chống deadlock ClosePseudoConsole (`windowsConoutConnection.ts:19-30`), thứ tự worker→connect chống block ConnectNamedPipe (`windowsPtyAgent.ts:99-113`), ThreadSafeFunction thay AsyncWorker cho exit callback (`conpty.cc:79-90`), CustomWriteStream xử lý EAGAIN (`unixTerminal.ts:352-394`).
3. **Phân phối thực dụng**: prebuild 6 combo platform/arch, fallback loader nhiều đường (build/Debug/Release/prebuilds), bundle conpty.dll để cập nhật ConPTY độc lập với Windows (mở khoá clear/reparent/release), hardening flags và verify glibc trong CI.

**Điểm yếu**

1. **Bề mặt API bất đối xứng, rác legacy**: `fork`/`createTerminal` deprecated, `useConpty` deprecated, `open()` throw trên Windows (`windowsTerminal.ts:141-143`), `master`/`slave` throw trên Windows, encoding không hỗ trợ Windows (`windowsTerminal.ts:33-35`); `Terminal._socket` đánh dấu `// HACK: This is unsafe` (`terminal.ts:25`); hai bộ typings (`ITerminal` nội bộ vs `IPty` public) dễ trôi.
2. **Handshake Windows nhiều tầng, phụ thuộc timer/heuristic**: chuỗi worker-READY → outSocket connect → native.connect → data đầu tiên → `_isReady`, với timeout 5s (`windowsPtyAgent.ts:110-113`); pipe name dùng `Math.random` dễ va chạm (`windowsPtyAgent.ts:258-260`); flush/destroy dựa timer 1000ms/200ms (`windowsPtyAgent.ts:23,273-290`, `unixTerminal.ts:24`); nhánh `useConptyDll` làm nhân đôi logic kill/cleanup với guard no-op (`windowsPtyAgent.ts:206-290`).
3. **Trạng thái toàn cục C++ và rò rỉ tiềm ẩn**: `ptyHandles` là vector global + mutex, baton chỉ được xoá khi thread exit chạy (`conpty.cc:58-72,101-108`); resize/kill trả giá trị im lặng khi handle không tồn tại (`conpty.cc:502,635`); `clear`/`setParentWindow` no-op tuỳ backend khiến hành vi lệch giữa hai chế độ; còn sót API chết như `IUnixProcess.pty` trên Windows (`windowsTerminal.ts:63`).

---

# node-pty — Subagent 2: Thuật toán & kỹ thuật cốt lõi

> Repo: `D:\GHITA AGENT\refer_project\desktop\node-pty` (clone microsoft/node-pty, v1.1.0, `package.json:7`).
> Phạm vi: đọc src C++/TS, không build/chạy. Đường dẫn tương đối tính từ gốc repo.

## 1. ConPTY lifecycle — 2-phase init + drain conout bằng worker thread

**Kiến trúc 2 phase** (tách `startProcess` / `connect`):

- **Phase 1 — `PtyStartProcess`** (`src/win/conpty.cc:246-327`): load kernel32 hoặc bundled `conpty.dll` (`conpty.cc:166-191`,GetProcAddress theo tên `CreatePseudoConsole` / `ConptyCreatePseudoConsole` `conpty.cc:209-211`); tạo 2 named-pipe SERVER `\\.\pipe\{name}-in` / `-out` (`createDataServerPipe` `conpty.cc:138-164`: `nMaxInstances=1`, buffer 128KB, `PIPE_TYPE_BYTE`, `FILE_FLAG_FIRST_PIPE_INSTANCE` `conpty.cc:148` để bắt lỗi trùng tên); truyền 2 server handle vào `CreatePseudoConsole` (`conpty.cc:293`, flag `inheritCursor ? 1` `conpty.cc:293`); `SetConsoleCtrlHandler(NULL, FALSE)` để agent không ăn Ctrl+C (`conpty.cc:296`); đăng ký baton vào `ptyHandles` có mutex (`conpty.cc:58-72, 305-309`).
- **Phase 2 — `PtyConnect`** (`conpty.cc:329-480`): env block double-NUL (`conpty.cc:376-386`) → `ConnectNamedPipe(hIn/hOut, nullptr)` **đồng bộ, không OVERLAPPED** (`conpty.cc:388-389`) → `STARTUPINFOEXW` + `UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE)` (`conpty.cc:407-430`) → `CreateProcessW` với `bInheritHandles=false` ("VERY IMPORTANT", `conpty.cc:433-444`) → `ConptyReleasePseudoConsole` chỉ khi dùng dll (`conpty.cc:456-464`) → đóng 2 server handle (`closePipeHandles` `conpty.cc:392-397, 472`) → `SetupExitCallback` (`conpty.cc:78-128`).

**Tại sao bắt buộc chờ worker ready trước `connect()`**: `ConnectNamedPipe` synchronous sẽ block cho tới khi client cắm vào. Nếu gọi trên Node main thread trước khi conout worker (client của pipe `-out`) connect xong → event loop đóng băng. Bằng chứng handshake: `src/windowsPtyAgent.ts:99-124` — `_conoutSocketWorker.onReady(...)` rồi mới `conptyNative.connect(...)`; comment "Never call connect() before the worker is ready" (`windowsPtyAgent.ts:108-112`); timeout 5s → `_failPtyConnection` (kill pty + dispose + fire onError, `windowsPtyAgent.ts:110-112, 164-176`). Commit `8f218f6` (#943) ghi lại case thật: debugger (VS Code agent host) pause conout worker ở `Debugger.enable`, fallback cũ "connect luôn sau 5s" đã block event loop → thấy ngay qua ETW stack; fix = readiness là điều kiện cứng, timeout giờ **fail** thay vì connect mù.

**Vì sao drain conout phải nằm trên thread riêng**: `ClosePseudoConsole` block tới khi ConPTY xuất hết dữ liệu output; nếu reader ở main thread (bận hoặc đang destroy) → deadlock kinh điển. Comment gốc: `src/windowsConoutConnection.ts:19-30` (issues node-pty#375, vscode#76548, terminal#1810). Worker (`src/worker/conoutSocketWorker.ts:11-22`) connect vào pipe conout, dựng server relay `{name}-out-worker` và `conoutSocket.pipe(workerSocket)`, gửi message READY (`src/shared/conout.ts:9-15`). Main thread chỉ nhận data qua socket worker (`windowsPtyAgent.ts:97-98, 119`).

**Cơ chế chống block khi đóng**: sau exit, flush đuôi bằng `FLUSH_DATA_INTERVAL=1000ms` — mỗi data event mới reset timer, hết 1s mới destroy socket (`windowsPtyAgent.ts:23, 265-290`; `windowsConoutConnection.ts:17, 80-98`). Kill path dll: destroy inSocket (EOF) → native kill → dispose worker khi data cuối trôi qua (`windowsPtyAgent.ts:226-233`).

**Exit callback native**: dedicated `std::thread` + `Napi::ThreadSafeFunction` (không dùng `Napi::AsyncWorker` vì bị chặn bởi `UV_THREADPOOL_SIZE`, `conpty.cc:79-90`); `WaitForSingleObject(hShell)` → `GetExitCodeProcess` → xoá baton under mutex → `tsfn.BlockingCall` (`conpty.cc:91-127`).

## 2. Kill process tree Windows — AttachConsole + GetConsoleProcessList

- **Thuật toán liệt kê** (`src/win/conpty_console_list.cc:9-37`): một process chỉ attach được 1 console nên phải chạy trong **process fork riêng** (`windowsPtyAgent.ts:241` fork `conpty_console_list_agent`; giải thích `src/conpty_console_list_agent.ts:5-7`): `FreeConsole()` → `AttachConsole(shellPid)` → `GetConsoleProcessList(buf=64)`, nếu count > 64 thì resize + gọi lại (`conpty_console_list.cc:24-29`) → `FreeConsole()` → trả list về qua IPC. Lỗi AttachConsole (process đã chết) → trả list rỗng (`conpty_console_list_agent.ts:15-20`).
- **Chính xác hơn `taskkill /T`**: GetConsoleProcessList trả mọi process **đã attach console đó** (quan hệ console, không phải cây cha-con) — vẫn đúng khi con spawn với `DETACHED` rồi vẫn ngồi chung console, hoặc cây cha-con đã đứt do cha chết. Mỗi PID → `process.kill(pid)` (TerminateProcess, ignore ESRCH) `windowsPtyAgent.ts:215-223`; fallback 5s trả về `[innerPid]` (`windowsPtyAgent.ts:246-250`).
- **Không dùng `GenerateConsoleCtrlEvent`**: phiên bản hiện tại chỉ TerminateProcess + ClosePseudoConsole. Ctrl+C cho pty đi qua conin thay vì signal.
- **Race conditions phân tích**:
  1. _PID reuse_: ClosePseudoConsole làm console chết → PID con có thể tái sử dụng; nếu lấy list SAU khi close có thể kill nhầm process lạ. Commit `271faf3` đã fix (lấy list trước khi close + guard `_killStarted`, đặt `_ptyNative.kill` vào `.then(kill)`) nhưng **bị revert** ở `fae2ee9` ("Revert fix(win): collect console processes before closing ConPTY") → code hiện tại (`windowsPtyAgent.ts:212-225`) vẫn gọi kill đồng thời với `_getConsoleProcessList().then(...)` async → race vẫn tồn tại upstream.
  2. _AttachConsole ESRCH_: con chết trước khi helper attach → list rỗng, chỉ còn ClosePseudoConsole dọn dư.
  3. _Helper timeout_: fork agent thất bại/treo → 5s fallback chỉ kill shell PID, con cháu có thể sót.
- dll path kill: `TerminateProcess(hShell, 1)` phòng hè (`conpty.cc:660-662`).

## 3. Unix lifecycle — forkpty + execvp, signal, close_range, exit thread

- **Linux path** (`src/unix/pty.cc:418-491`): dựng `termios` thủ công đủ c_cc map + B38400 (`pty.cc:351-386`) → **block toàn bộ signal** bằng `pthread_sigmask(SIG_SETMASK, sigfillset)` trước `forkpty` — comment: race condition trong openpty + tránh handler của parent chạy trong child trước exec (`pty.cc:430-437`) → child reset mọi handler NSIG về `SIG_DFL` (`pty.cc:441-449`) → khôi phục mask ở parent (`pty.cc:452`) → child: `chdir` → `setgid/setuid` → `pty_close_inherited_fds` → `execvp` với environ swap (`pty.cc:457-486`). Master set `O_NONBLOCK` (`pty.cc:488-490, 627-632`).
- **close_range()**: Linux 5.9+/glibc 2.34: một syscall `SYS_close_range(3, ~0U, CLOSE_RANGE_CLOEXEC)` đánh CLOEXEC mọi fd ≥3; fallback vòng fcntl fd=3.. (bỏ cuộc sau lỗi đầu tiên nếu fd>15) (`pty.cc:115-147`). Mục đích: không leak master fd của pty _khác_ xuống child (child giữ fd thừa sẽ keeps-alive các terminal khác).
- **macOS path — không fork**: `pty_posix_spawn` (`pty.cc:738-861`): chiếm 3 low-fd bằng `posix_openpt` để slave fd không đè stdin/stdout/stderr (`pty.cc:753-757`); master qua `posix_openpt/grantpt/unlockpt`; dùng `ioctl(TIOCPTYGNAME)` thay `ptsname()` vì không thread-safe (`pty.cc:789`); `tcsetattr` + `TIOCSWINSZ` trên slave; flags `POSIX_SPAWN_CLOEXEC_DEFAULT|SETSIGDEF|SETSIGMASK|SETSID` (`pty.cc:759-762`), sigdefault=fillset, sigmask=empty. Child là binary `spawn-helper` (`src/unix/spawn-helper.cc:6-23`): `ttyname(STDIN)` + `open()` không `O_NOCTTY` → **implicitly acquire controlling terminal**, `chdir`, `execvp`. Lý do: fork trong process có nhiều thread (Node) không an toàn; posix_spawn chỉ gọi 2 syscall.
- **Exit detection — thread chờ, KHÔNG SIGCHLD** (`SetupExitCallback` `pty.cc:149-250`):
  - Linux: vòng `waitpid(pid, &stat, 0)` blocking, xử lý `EINTR` và `ECHILD` (`pty.cc:208-224`).
  - macOS: `kqueue` + `EVFILT_PROC NOTE_EXIT` (`pty.cc:174-206`); xử lý "zombie death race" khi `kevent` trả `ESRCH`: thử `waitpid(WNOHANG)` → nếu 0 thì `SIGKILL` rồi `waitpid` blocking; sau khi fire event đóng kq fd (commit `f285d90` #931 fix leak).
  - Tại sao không SIGCHLD: Node/libuv đã tự cài handler SIGCHLD để reap child_process của nó; signal không mang PID nên handler phải waitpid loạn, dễ "cướp" zombie của libuv hoặc bị libuv cướp. Thread waitpid riêng cho từng pid không đụng ai, không cần global handler, tương thích cả embedding (Electron).
  - Kết quả decode `WIFEXITED/WIFSIGNALED` (`pty.cc:225-231`) đẩy về JS qua TSFN.
- **TS side**: exit KHÔNG emit ngay — đợi socket close (data đuôi trên master), kèm timeout 200ms phòng bug macOS 10.13.2 socket không close (`src/unixTerminal.ts:78-103, 24`). Read error: nuốt `EAGAIN` (bình thường cho nonblocking), `EIO`/`errno 5` = process chết → close im lặng (`unixTerminal.ts:115-145`).

## 4. Write queue — EAGAIN retry & backpressure (Unix `CustomWriteStream`)

`src/unixTerminal.ts:321-395`, hàng đợi `IWriteTask {buffer, offset}`:

- `write()` đẩy task vào queue; chỉ khi queue trước đó rỗng mới kick `_processWriteQueue` (`unixTerminal.ts:337-350`).
- Ghi bằng `fs.write` thẳng fd, **không dùng** `net.Socket`/`tty.WriteStream` vì wrapper "swallow and mask errors like EAGAIN and can cause the thread to block indefinitely" (`unixTerminal.ts:360-364`).
- `EAGAIN` → `setImmediate` re-attempt (nhả event loop rồi thử lại, `unixTerminal.ts:366-369`); lỗi khác → xoá sạch queue + log (`unixTerminal.ts:370-373`).
- Partial write: cập nhật `task.offset`, chỉ shift khi ghi đủ; sau mỗi lần thành công loop tiếp tới khi EAGAIN hoặc hết queue (`unixTerminal.ts:378-392`).
- **Không có cap** cho queue: nếu producer ghi nhanh hơn pty tiêu thụ thì JS buffer phình không giới hạn — upstream chấp nhận (trade-off tốc độ paste; cả bug bash 3.2 macOS ghi nhanh gây hỏng readline cũng chấp nhận, issue #833 `unixTerminal.ts:384-391`). Đây là điểm Ghita nên làm khác (thêm cap + tín hiệu pause).
- Windows: write đi qua `inSocket` = `net.Socket` trên fd mở từ `fs.openSync(conin,'w')` (`windowsPtyAgent.ts:130-136`), write bị defer tới khi `ready_datapipe` + data đầu (`src/windowsTerminal.ts:67-91, 129-135`).

## 5. Resize — TIOCSWINSZ vs ResizePseudoConsole + pixel size + reparent

- **Unix** (`pty.cc:546-582`): `ioctl(fd, TIOCSWINSZ, winsize)` với `ws_xpixel/ws_ypixel` — API mới `resize(cols, rows, pixelSize?)` (`src/interfaces.ts:31-35`; `unixTerminal.ts:271-280` default 0). Kernel sẽ phát `SIGWINCH` cho foreground pgrp; pixel size cho app hỗ trợ (như sixel/underline thickness). Validate >0, không NaN/Infinity.
- **Windows**: `ResizePseudoConsole` / `ConptyResizePseudoConsole` nhận COORD cols,rows (`conpty.cc:482-519`) — **pixelSize bị bỏ qua trên Windows** (`interfaces.ts:31-35`; `windowsTerminal.ts:149-158` không truyền pixel xuống agent). Resize bị defer tới ready (`windowsTerminal.ts:153-157`).
- **setParentWindow / ConptyReparentPseudoConsole** (`conpty.cc:574-617`; `windowsTerminal.ts:166-170`): hwnd truyền dạng Buffer đúng `sizeof(HWND)` bytes (Electron `getNativeWindowHandle()`), chỉ có tác dụng với bundled conpty.dll (kernel32 không export `ConptyReparentPseudoConsole` — `conpty.cc:44-45, 591-594`); ConPTY áp dụng **async**, biến console window thành owned bởi HWND host để dialog (VD WAM sign-in) xếp trên app. Không defer vì pseudoconsole có sẵn từ lúc tạo agent (`windowsTerminal.ts:166-170`). Prototype có trong `src/win/conpty.h` cùng `ConptyClosePseudoConsoleTimeout`, `PSEUDOCONSOLE_RESIZE_QUIRK=2`, `PSEUDOCONSOLE_PASSTHROUGH_MODE=8` (chưa dùng trong conpty.cc).
- **clear()**: `ConptyClearPseudoConsole` — chỉ dll path (`conpty.cc:521-558`).

## 6. Kỹ thuật khác đáng chú ý

- **Escape commandline CommandLineToArgvW-compatible** (`argsToCommandLine` `src/windowsPtyAgent.ts:296-346`, copy từ winpty): quote nếu rỗng hoặc chứa space/tab và chưa được quote; đếm backslash chạy (`bsCount`): gặp `"` → phát `bsCount*2+1` dấu `\` + `"`; hết arg quoted → `bsCount*2` dấu `\`; có nhánh `xOr` phát hiện quote lệch. Cho phép truyền string đã-escape nguyên khối (`ArgvOrCommandLine`, `src/types.ts`, `src/index.ts:21-23`).
- **Pipe naming**: tên sinh `conpty-${Math.random()*10000000}` (`windowsPtyAgent.ts:258-260`) — entropy yếu (~10^7), kèm `FILE_FLAG_FIRST_PIPE_INSTANCE` (`conpty.cc:148`) chặn trùng tên; suffix `-in`/`-out` (`conpty.cc:146`) và `-out-worker` cho relay (`shared/conout.ts:13-15`).
- **Flow control pause/resume** (`src/terminal.ts:17-22, 52-59, 79-93`): mặc định `\x13` (XOFF) = pause, `\x11` (XON) = resume; `write()` chặn 2 chuỗi này KHÔNG đưa vào pty mà gọi `socket.pause()/resume()`; chuỗi cấu hình được vì oh-my-zsh rebind XON/XOFF. Bật bằng `handleFlowControl`.
- **winpty đã xoá sạch**: không còn file/binary/target build winpty (`binding.gyp` chỉ có `conpty`, `conpty_console_list`, `pty`, `spawn-helper`; grep toàn src chỉ còn 2 mention: ghi công origin code escape `windowsPtyAgent.ts:295` và doc deprecate `src/interfaces.ts:130-138` + `typings/node-pty.d.ts:91`). Option `useConpty` deprecated-ignored. Còn lại 2 backend ConPTY: kernel32 và bundled dll `third_party/conpty/1.25.260303002/{win10-x64,win10-arm64}/conpty.dll + OpenConsole.exe` (chọn bằng `useConptyDll`, dll mở theo đường dẫn cạnh `conpty.node` `conpty.cc:172-190`). Sạch — chỉ "rác" là doc/comment.
- **Load native**: thử `build/Release` → `build/Debug` → `prebuilds/{platform}-{arch}`, cả 2 mức relative (`src/utils.ts:10-27`) — prebuild ship sẵn tránh node-gyp ở user máy.
- CreateProcessW fail giờ surface qua onError/exit thay vì uncaughtException (`windowsPtyAgent.ts:147-161`, commit `372d312` #934); fail spawn thì close pipe handles + attribute list (`conpty.cc:391-449`, commit `25b9b0e` #935).

## 7. Điểm đáng port sang Rust (portable-pty) cho Ghita

1. **2-phase init + worker-thread conout drain** (bắt buộc): thread riêng sở hữu conout; `ConptyClosePseudoConsole` chỉ gọi khi drain worker vẫn sống; handshake "client pipe connect xong mới CreateProcess/ConnectNamedPipe"; timeout → fail sạch (kill pty + dispose) thay vì connect mù.
2. **Kill tree đúng thứ tự**: lấy `GetConsoleProcessList` **trước khi** ClosePseudoConsole (thứ tự mà upstream đã fix rồi revert — Ghita nên giữ fix: gate `_killStarted`, kill-list-then-close trong helper process riêng, phòng PID-reuse). Helper process là điều kiện hiển nhiên vì AttachConsole 1-console-per-process.
3. **Exit detection không SIGCHLD**: thread `waitpid` blocking mỗi pty (Linux) / kqueue EVFILT_PROC + xử lý ESRCH-zombie-race (macOS); đợi socket close trước khi emit exit + timeout nhỏ (200ms) cho data đuôi.
4. **Unix pre-exec hygiene**: block-signal quanh forkpty, reset NSIG handlers trong child, `close_range(3, ~0, CLOSE_RANGE_CLOEXEC)` + fallback fcntl, nonblock master. Nếu Rust dùng `posix_spawn` (macOS): chiếm low-fd trước, `TIOCPTYGNAME` thay `ptsname`, `POSIX_SPAWN_CLOEXEC_DEFAULT|SETSID`.
5. **Write queue kiểu CustomWriteStream**: queue {buffer, offset}, EAGAIN → yield + retry, partial-write tracking; Ghita NÊN thêm cap queue + backpressure signal (node-pty để unbounded).
6. **resize pixelSize trên Unix, bỏ qua Windows**; thêm `clear()` (dll-only) và `setParentWindow(hwnd-buffer)` như API tùy chọn khi bundle conpty.dll.
7. **Env block double-NUL cho CreateProcessW**; escape commandline kiểu CommandLineToArgvW (so sánh với CommandBuilder của portable-pty, giữ nhánh "string đã escape").
8. **Pipe name**: dùng entropy mạnh hơn (uuid) nhưng giữ `FILE_FLAG_FIRST_PIPE_INSTANCE` làm guard.
9. Cảnh báo: `setEncoding('utf8')` trên conout (Node) có thể cắt rune UTF-8 giữa chunk — Rust nên giữ raw bytes, decode ở tầng UI.
