# Nghiên cứu nền: crates/sandbox

> Subagent research 1 — READ-ONLY, 2026-11-22. Repo: `D:\GHITA AGENT`.

## 1. `crates/sandbox/src/lib.rs` (937 dòng) — cấu trúc đầy đủ

**Types chính**

- `SandboxProfile` (lib.rs:24-31): `Workspace` (ghi chỉ trong workspace + temp), `ReadOnly` (không ghi, đọc mọi nơi), `Strict` (read-only + chặn binary network). `as_str` → "workspace"/"read-only"/"strict" (34-40); `parse` (43-50).
- `STRICT_DENY_BINARIES` (54-56): curl, wget, ssh, scp, sftp, nc, netcat, telnet, ftp, rsync.
- `Enforcement` (168-175): `Landlock` / `Seatbelt` / `RestrictedToken` / `Supervised`; `as_str` (177-186). Comment lib.rs:170-174: RestrictedToken chỉ là probe codex preflight, spawn v1 đi supervised; ACL orchestration là backlog R2.
- `detect_enforcement()` (188-208): linux → Landlock nếu kernel hỗ trợ; macos → Seatbelt nếu có `/usr/bin/sandbox-exec`; windows (feature `win-sandbox`) → RestrictedToken nếu `windows::available()`; ngược lại `Supervised`.
- `SandboxOptions` (385-418): `profile`, `workspace`, `deny_globs`, `env_allow`, `timeout` (default `Some(120s)`), `memory_limit_mb` (default `None`), `process_limit` (default `Some(64)`). `new` (402-412), `with_deny_globs` (414-418).
- `SandboxViolation` (420-424) { reason, detail }; `SandboxRunResult` (426-436) { exit_code, stdout, stderr, duration_ms, enforcement, violations, blocked }.

**Hàm public**

- `glob_match(pattern, path)` (90-106): glob theo segment, hỗ trợ `**`, `*`, `?`; normalize `\` → `/` + lowercase (62-64). Helper: `segment_match` (67-80), `segments` (82-87), `path_denied` (108-115).
- `scrub_env(extra_allow)` (146-161): allowlist env từ `BASE_ENV_ALLOW` (121-144 — PATH, PATHEXT, SYSTEMROOT, TMP, HOME, CARGO_HOME…), so sánh case-insensitive, trả `BTreeMap`.
- `precheck(program, args, opts)` (481-541): (1) deny-glob trên mọi token giống path (485-494); (2) write-scope theo profile cho redirect targets — helper `write_targets` (453-471) bắt `>`, `>>`, `1>`, `1>>`, `2>`, `2>>`; Workspace cho phép dưới workspace + temp (497-519), ReadOnly/Strict chặn hết; (3) profile Strict chặn binary network (529-538). Helper `is_beneath` (473-478), `looks_like_path` (442-444), `binary_name` (446-450).
- `spawn_sandboxed(program, args, opts)` (696-816): precheck chặn trước khi chạy (blocked=true, 701-716) → detect enforcement → macos wrap `/usr/bin/sandbox-exec -p <SBPL>` (721-737; profile gen `seatbelt_profile` 547-561) → `Command::new` với `env_clear + envs(scrub)`, cwd=workspace, stdin null, stdout/stderr piped (742-750) → linux `pre_exec(landlock::restrict_writes)` (752-762; landlock raw-syscall inline module 218-363, stub non-linux 365-378) → spawn (764-781) → **Windows Job Object: `win_job::JobGuard::assign(&child, opts)` (783-784)** → timeout poll `try_wait` 25ms rồi `kill` (786-804) → trả `SandboxRunResult`.

**Module `win_job` (567-689) — Job Object hiện tại**

- `JobGuard::assign` (633-668): `CreateJobObjectW` → `SetInformationJobObject(JOB_OBJECT_EXTENDED_LIMIT_INFORMATION)` với limit flags `KILL_ON_JOB_CLOSE | ACTIVE_PROCESS` (640-642), `active_process_limit = opts.process_limit.unwrap_or(64)` (642); nếu có `memory_limit_mb` thì set `job_memory_limit` + `process_memory_limit` và thêm flags JOB/PROCESS_MEMORY (644-650) → `AssignProcessToJobObject(child.as_raw_handle())` (662-665).
- `Drop` → `CloseHandle` (671-677): kill-on-close giết cả cây process khi handle đóng.
- `IoCounters` (574-581) và `per_process_user_time_limit`/`per_job_user_time_limit` (586-595) được khai trong struct nhưng **không bao giờ set/đọc**.

## 2. `crates/sandbox/src/windows.rs` (30 dòng) — hiện trạng Windows

- Toàn bộ module chỉ compile khi feature `win-sandbox` (lib.rs:214-215).
- Doc comment (windows.rs:1-13): v1 trả FALSE có chủ đích — codex sandbox thật (ACL/restricted-token) chưa integrate do 3 blocker upstream: tokio-tungstenite "proxy" feature chỉ có ở fork openai-oss-forks; rama 0.3.0-alpha.4 phải ghim nguyên bộ theo codex Cargo.lock; codex-utils-pty không compile trên windows-GNU. Ghi chú: các spike log `docs/t3-spike-*.log` được tham chiếu nhưng **không còn tồn tại trong repo** (đã find, 0 kết quả).
- `#![expect(dead_code)]` (14).
- `available()` (21-23): luôn `false` — probe stub. Hệ quả: `detect_enforcement()` trên Windows **không bao giờ** trả RestrictedToken → luôn `Supervised` (t3_tests lib.rs:932-935 test điều này).
- **`restrict_writes(_write_roots)` (28-30): no-op `Ok(())`** — chặn path-level thực sự cần provisioning codex sandbox (backlog R2); enforcement spawn-level hiện là Job Object containment của đường supervised (đã mô tả ở §1 `win_job`).
- Thiếu so với backend Windows hoàn chỉnh: provisioning restricted-token/AppContainer thật; `restrict_writes` thật (ACL deny-write per SIDs); preflight probe; xử lý race spawn→assign (Job Object gán SAU khi spawn ở lib.rs:784 — cửa sổ escape nhỏ; backend hoàn chỉnh cần `CREATE_SUSPENDED` → assign → resume); CPU rate control, IO limits, TTL, UI limits (xem §6c).

## 3. Tests hiện có của crate sandbox

8 `#[test]` trong lib.rs (grep `#[test]` = 8):

| Test                                                        | Dòng                      | Coverage                                                            |
| ----------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------- |
| `profile_roundtrip`                                         | lib.rs:827                | `SandboxProfile::parse` 3 profile + bogus → None                    |
| `glob_matching`                                             | lib.rs:844                | `glob_match` `**`, `*`, `?`, phân biệt subdir                       |
| `env_scrub_drops_unlisted_vars`                             | lib.rs:854                | `scrub_env` allowlist                                               |
| `write_target_extraction`                                   | lib.rs:861                | `write_targets` (chỉ 1 case `>`)                                    |
| `precheck_blocks_deny_glob_and_out_of_scope_writes`         | lib.rs:873                | precheck: deny-glob arg, write-outside-scope, strict-network (curl) |
| `spawn_runs_and_blocks_per_policy`                          | lib.rs:898                | spawn_sandboxed: blocked path + happy path (echo)                   |
| `enforcement_as_str_covers_all_tiers`                       | lib.rs:923                | `Enforcement::as_str` đủ 4 tier                                     |
| `detect_on_windows_v1_reports_supervised_until_provisioned` | lib.rs:932 (windows-only) | detect_enforcement = Supervised                                     |

Chưa có test: JobGuard (memory/process limit thật sự hiệu lực), timeout-kill path, `write_targets` biến thể `2>`/`1>>`, `seatbelt_profile`, landlock `restrict_writes` (cần linux), Windows `restrict_writes`.

## 4. Napi addon + nạp native

- `crates/sandbox/src/napi.rs` (117 dòng): `SandboxOptionsInput` (12-28 — profile/workspace/deny_globs/env_allow/timeout_ms/memory_limit_mb/process_limit), `SandboxViolationOutput` (30-34), `SandboxRunOutput` (36-47). `#[napi] spawn_sandboxed(command, args, options)` (51-108): default profile=workspace, timeout 120s, process_limit=64; `#[napi] detect_enforcement()` (113-116). Gated bởi feature `addon` (lib.rs:15-16).
- `Cargo.toml`: crate-type `cdylib, rlib` (9); napi2 `dyn-symbols` — không cần libnode.dll khi link (20); feature `win-sandbox` rỗng (17). `build.rs` no-op.
- `package.json`: `@ghita/sandbox-native` v1.1.1, `napi.name: "sandbox"` (crates/sandbox/package.json:2,6-9). Prebuilt binaries có sẵn: `sandbox.win32-x64-gnu.node` + `sandbox.win32-x64-msvc.node` trong crates/sandbox/. Lưu ý: `index.d.ts` **rỗng (0 byte)** — kiểu TS do consumer tự khai.
- Nạp: `loadNative('sandbox', fallback)` — packages/native-bridge/src/sandbox-native.ts:29 (detect) và :45 (run); `loadNative` tại native-bridge/src/index.ts:90-110 quét candidates: module đã register → Electron resourcesPath → `crates/<name>/*.node` → `crates/<name>/target/release`, `require()` file .node đầu tiên tồn tại, fail thì JS fallback.
- `sandbox-native.ts` expose `tryDetectEnforcementNative` (28-37) và `tryRunSandboxedNative` (39-55 — chỉ truyền `{profile, workspace}`, không deny_globs/timeout).
- Grep `spawnSandboxed` trong packages/: chỉ có packages/native-bridge/src/sandbox-native.ts + packages/security/src/sandbox/runner.ts:106-116. **Không có** gọi trong packages/agents.

## 5. Runtime hiện chạy lệnh thế nào

- Chain: `SandboxRunner.run` (packages/security/src/sandbox/runner.ts:77-165): (1) governance `checkCommand` (exec-policy.ts:242, DEFAULT_EXEC_RULES dòng 47) deny → blocked trước spawn (86-102); (2) native addon qua `loadNative('sandbox')` (64-65) gọi `spawnSandboxed` với đủ options — profile default 'workspace', deny_globs/env_allow/timeout_ms/memory_limit_mb/process_limit (105-116); (3) fallback JS `spawnSync` với timeout, enforcement='fallback-js' (134-152).
- **deny-glob configured thế nào**: chỉ qua `SandboxRunnerOptions.denyGlobs` (runner.ts:16) truyền thẳng xuống addon (runner.ts:111); grep toàn repo không thấy production code đặt denyGlobs — chỉ test (packages/security/tests/sandbox-runner.test.ts, 5 test: block destructive, native simulate, ask effect…).
- **Điểm nối còn hở**: `SandboxRunner` được export từ packages/security (index.ts:58) nhưng chưa có consumer production nào trong apps/packages. packages/agents chỉ khai hook tùy chọn `runInSandbox` trong BlockContext (blocks/types.ts:77, builtins.ts:387-395 — block `code_sandbox` tự báo lỗi khi chưa wire, autogpt/executor.ts:68,242) — **không có chỗ nào wire nó vào ghita-sandbox**. `runInSandbox` khác cùng tên ở packages/computer-use/src/sandbox.ts:423 là hệ riêng, không liên quan. ReAct agent (react/agent.ts:26-31) chỉ derive action 'execute' cho policy guard, không chạm sandbox. Skill v2 có Docker sandbox riêng (packages/skills/src/v2/sandbox.ts, enabled=false default, deny-default) — độc lập với crate.

## 6. Đánh giá khoảng cách

**(a) Trait backend + state machine CAS** — Khoảng cách trung bình. Hiện enforcement là enum + `detect_enforcement` + các khối `cfg`, `spawn_sandboxed` monolithic (696-816). Raw material đã tách sẵn: landlock inline module (218-363), seatbelt gen (547-561), win_job (567-689), windows.rs stub — tách thành `trait SandboxBackend { prepare/spawn/await/cleanup }` thuần cơ học, chỉ đụng lib.rs, napi surface giữ nguyên. State machine CAS hoàn toàn mới: hiện không có state tracking (JobGuard chỉ RAII, không query status); cần thêm Job state handle (Running/Killed/Completed) + `QueryInformationJobObject`.

**(b) Overlay-dir rollback** — Khoảng cách lớn nhất, chưa có viên gạch nào: không snapshot, không copy-on-write. Write-scope chỉ kiểm tra redirect target lúc precheck (498-526); ghi thật của process con trên Windows không bị chặn (không minifilter). Làm được bằng cách chạy với workspace=overlay root rồi diff + commit/rollback — cần xử lý junction/symlink và có thể redirect TEMP qua env scrub. Rủi ro: process ghi ngoài workspace (hard-coded path) vẫn lọt — chỉ giải quyết triệt để khi (a)+(c) hoặc ACL thật.

**(c) Job Object limits (memory/IO/TTL)** — Khoảng cách nhỏ. Hạ tầng sẵn: `ExtendedLimitInformation` (598-605) đã có field TTL (`per_process_user_time_limit`/`per_job_user_time_limit`) và `IoCounters` (574-581) nhưng bị bỏ trống; memory limit đã implement (644-650) nhưng napi default để None (napi.rs:87). Cần: set JOB_TIME flags; thêm `JOB_OBJECT_LIMIT_IO_RATE_CONTROL` (Win8+); `QueryInformationJobObject` để report peak memory/IO; UI limits + breakaway. Chủ yếu bổ sung flag trong `JobGuard::assign` + API query — effort thấp-trung.

**Lưu ý nhỏ khác**: doc comment `SandboxRunOutput.enforcement` (napi.rs:42) và TS `SandboxExecutionResult` (runner.ts:34) đều thiếu giá trị 'restricted-token' trong union dù backend có thể trả ra khi R2 xong.
