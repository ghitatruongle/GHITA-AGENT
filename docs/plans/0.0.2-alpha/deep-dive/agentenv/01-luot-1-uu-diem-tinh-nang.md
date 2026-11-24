# AgentEnv — Lượt 1: Tổng quan, tính năng & ưu điểm áp dụng

> **Dự án:** kvcache-ai/AgentENV v0.1.2 (AENV) — nền tảng Rust chạy agent environments quy mô lớn (Firecracker microVM), do MoonshotAI phát triển, powering agentic RL training cho Kimi K3 · **MIT** (đã xác minh LICENSE + Cargo.toml) · Rust ~151k LOC + Go ~14.5k, 72 commits (25/07–11/08/2026) — dự án rất trẻ nhưng production-proven (1.5M images) · clone: `refer_project/infra/AgentEnv`
> **Phương pháp:** 2 subagent khảo sát song song 22/11/2026, chỉ đọc mã nguồn. Subagent 1 = tổng quan & tính năng; Subagent 2 = ưu điểm & áp dụng vào Ghita.

## Tóm tắt nhanh (tổng hợp)

- Kiến trúc 3 tầng: per-node Rust server (Axum + orchestrator + Firecracker backend) / Go control plane (gateway + scheduler gRPC, Redis HA) / CLI `aenv` + E2B SDK làm client; guest chạy envd của E2B.
- Tính năng cốt: create/pause/resume/fork/snapshot sandbox; memory snapshot → overlaybd layer qua ublk refcount (boot/resume <50ms); fork 1 VM đang chạy thành N; memory ballooning 9.6x overcommit; template builder kiểu Dockerfile; P2P artifact iroh; disk rate limit; warm pools.
- API: 25 endpoints OpenAPI tương thích E2B hoàn toàn — drop-in replacement (dùng thẳng E2B Python/TS SDK).
- **Áp dụng được cho Ghita (Windows desktop):** ngay/dễ = Job Object resource limits, TTL auto-kill, audit hooks, counters; kế hoạch/trung = refactor `crates/sandbox` thành trait backend (`SandboxBackend` + lỗi Recoverable/Terminal) + overlay-dir rollback (sửa restrict_writes no-op ở `windows.rs:25-28`) + warm pool; xa/khó = egress policy WFP/proxy, WSL2 backend, VSS. Firecracker/ublk/P2P là Linux-only — chỉ học kiến trúc.
- **Không nên học:** tầng storage đồ sộ, control plane phân tán, tư thế no-auth (API không authorization).

---

# AgentEnv — Subagent 1: Tổng quan & tính năng

> Repo khảo sát: `D:\GHITA AGENT\refer_project\infra\AgentEnv` (clone `kvcache-ai/AgentENV`, HEAD `6e8deea`, branch `main`). Chỉ đọc, không chạy code.

## 1. Dự án là gì

- **AgentENV (AENV)** là nền tảng Rust để chạy **agent environments quy mô lớn** — mỗi sandbox là một Firecracker microVM cô lập (kernel + filesystem + netns riêng). README tuyên bố mục đích trực tiếp: "powering agentic RL training for **Kimi K3**" (`README.md:22`), tức do MoonshotAI (kvcache-ai) phát triển nội bộ để huấn luyện/serving agent, mở source làm hạ tầng chung.
- **Vấn đề giải quyết**: RL/serving agentic cần hàng triệu môi trường container/VM quay vòng nhanh — Docker chậm khi nạp image lớn, VM thường khởi động hàng giây, memory không overcommit được. AgentENV dùng Firecracker + overlaybd + ublk để boot/resume < 50 ms, pause < 100 ms, snapshot < 100 ms, scale tới **1.5 triệu image trong production** (`README.md:28-31`, trích tech report Kimi-K3), overcommit bộ nhớ **9.6x** nhờ memory ballooning.
- **Ai dùng**: team RL training của MoonshotAI (Kimi K3); ngoài ra hướng tới bất kỳ ai cần sandbox cho agent coding/benchmark qua **API tương thích E2B** (`README.md:108-113`).
- **Kiến trúc triển khai (3 tầng)** (`docs/src/internals/architecture.md:1-10`, `docs/src/concepts/overview.md`):
  1. **Per-node server** — binary Rust duy nhất `src/bin/server.rs`: Axum API (`src/api/`), orchestrator lifecycle (`src/orchestrator/`), sandbox backend Firecracker (`src/sandbox/firecracker/`), storage stack (overlaybd/ublk).
  2. **Control plane Go** — `services/gateway` (reverse proxy HTTP + `GET /nodes`) và `services/scheduler` (gRPC: `Schedule`, `LookupNode`, `RecordAssignment`, `Heartbeat`, discovery `static|kubernetes`, strategy `round_robin|random`, binding Redis cho HA query-only replica) (`CLAUDE.md:90`).
  3. **SDK/CLI** — `aenv` CLI Rust (`crates/aenv`) bọc HTTP API + envd Connect-RPC; bên cạnh đó khách hàng dùng thẳng **E2B Python/TS SDK** không đổi code.
- **In-guest**: daemon `envd` của E2B chạy trong VM thực thi lệnh/file/PTY; AgentENV chỉ sinh **client library** Rust cho envd (`thirdparty/envd/README.md:1-3`).

## 2. Kho tính năng đầy đủ (theo chủ đề)

### 2.1 MicroVM lifecycle (create / pause / resume / fork / snapshot / restore)

- State machine sandbox: `Creating → Running → Forking | Snapshotting | Pausing → Paused, Resuming, Killing` (`CLAUDE.md:102`, `src/orchestrator/service.rs`).
- **Fork**: một sandbox đang chạy fork thành N sandbox con độc lập trên cùng node — `fork_sandbox` tại `src/orchestrator/service.rs:484-511`, mỗi child có ID/resources riêng, event `SandboxLifecycleEventType::Fork` được phát cho scheduler.
- **Snapshot**: `capture_snapshot` chạy luồng `Running → Snapshotting → Running`, lỗi recoverable rollback về Running, lỗi terminal teardown sandbox (`CLAUDE.md:102`). Snapshot là "committed snapshot" first-class với repository backend POSIX/OSS, manifest chứa rootfs layers + attached-drive layers + VM state (`src/snapshot/`, `CLAUDE.md:108`).
- **Memory snapshot pipeline** (điểm cốt lõi): pause tạo Firecracker diff snapshot (`SnapshotType::Diff`) → `mem.bin` sparse → đóng gói thành overlaybd layer (`convert_sparse_mem_to_overlaybd`) → resume bằng read-only ublk device mount vào Firecracker làm file-backed memory backend, COW vào anonymous memory; nhiều sandbox cùng template **chia sẻ 1 memory device qua refcount** để tái dùng page cache (`CLAUDE.md:84`).
- **Graceful shutdown/persist**: khi server dừng, sandbox Running bị pause + persist; khởi động lại được restore về Paused và resume được (`SandboxPersister`, `CLAUDE.md:102`; `src/orchestrator/persistence/`).
- **Auto-eviction** sandbox hết TTL + API extend timeout; warm-pool watermark-based cho network slot / ublk device / Firecracker VM prewarm (`crates/warm-pool/src/lib.rs:1-8`, `config/default.toml` `[pool.firecracker] startup_prewarm`).
- **Memory ballooning**: virtio-balloon thu hồi guest memory về host — `set_balloon` tại `src/sandbox/firecracker/sandbox.rs:1751-1753` → 9.6x overcommit production.
- **CPU template harmonization**: dump cpu-config từng node, scheduler tính giao (AND) toàn cluster, áp vào VM mới qua `PUT /cpu-config` (`CLAUDE.md:104`).
- **Disk I/O rate limiting** (bandwidth + IOPS) cho Firecracker (`config/default.toml [machine.disk_rate_limit]`; commit `0369df1`).

### 2.2 Overlaybd storage

- **overlaybd** (`storage/overlaybd/`): định dạng image phân lớp LSMT tự implement — layers r/o nén zstd có jump-table random access + 1 upper r/w; backends cắm được: `LocalFile` (io_uring, O_DIRECT), `registryfs_v2` (đọc trực tiếp OCI registry, không tải blob), `tar` (`CLAUDE.md:72`).
- **ublk** (`storage/ublk/`): block device userspace qua driver Linux ublk + io_uring, `UVMUblkCtrl` ADD/DEL vào `/dev/ublk-control`, target `OverlaybdTarget` đầy đủ; hỗ trợ `UBLK_F_AUTO_BUF_REG` kernel 6.8+ (`CLAUDE.md:76`).
- **ublk-daemon** (`storage/ublk-daemon/`): daemon quản mọi ublk device trong 1 process, IPC Unix socket JSON length-prefixed với RPC `CreateOverlaybd`, `RestackSnapshot`, warm pool device, watchdog (`CLAUDE.md:78`).
- **Image pipeline OCI**: mọi registry access qua `regctl`; OCI tar image → convert từng layer thành `.commit`; overlaybd-native image → remote-ref đọc thẳng registry; cache content-addressed `{commits,indexes,configs}` (`CLAUDE.md:33`). Benchmark conversion: `crates/benchmarks/benches/oci_conversion_pipeline_benchmark.rs`.
- **close_seal + restack**: khi pause, upper layer đang viết được "niêm phong" thành lower mới nhất và mở upper mới in-place (`CLAUDE.md:72`).
- Local disk chỉ là **bounded cache** (hot data giữ, cold evict) — footprint image/snapshot vượt local disk vài bậc độ lớn vẫn chạy (`README.md:28`).

### 2.3 Networking

- Mỗi sandbox 1 network namespace riêng: veth pair (prefix `veth-`), iptables isolation (`src/sandbox/network/mod.rs:18`, `manager.rs`, `iptables_util.rs`, `policy.rs`, `address_plan.rs`, `slot.rs`).
- Network slot pool (warm-pool) cấp/tái dùng địa chỉ; `[network.egress]` / `[network.internal]` config (`config/default.toml`).
- Reverse proxy HTTP/WebSocket vào trong VM qua headers `x-agentenv-sandbox-id`, `x-agentenv-target-port` (`src/api/proxy.rs`, `CLAUDE.md:100`); design doc `docs/src/internals/proxy-design.md`.

### 2.4 Orchestration / Scheduler / phân tán

- Per-node: orchestrator + metadata store in-memory + proxy route table + counters (`src/orchestrator/service.rs`, `metrics.rs`).
- Cluster: Go scheduler gRPC với binding sandbox→node (seeded từ `RecordAssignment`, reconcile từ heartbeat roster, TTL expire), Redis binding cho HA, query-only scheduler replica cho data-plane (`CLAUDE.md:90`); gateway route theo sandbox ID (`docs/src/concepts/overview.md` multi-node diagram).
- **P2P artifact transport** (điểm hiếm gặp): dùng `iroh` + `iroh-blobs` transfer layer/snapshot node-to-node, mặc định disabled; scheduler giữ index artifact→node (heartbeat advertise, `LookupP2pArtifact`); overlaybd đọc range qua facade `/p2p-http/{*origin}` (`CLAUDE.md:35`, `src/p2p/`, design `docs/src/internals/p2p-design.md`).
- Observability: heartbeat gRPC định kỳ, node metrics (CPU/mem/disk), build version/commit, machine info từ `/proc/cpuinfo` (`src/observability/`, `CLAUDE.md:104`).

### 2.5 API / SDK surface

- **25 HTTP endpoints** OpenAPI (`src/api/openapi.yml`), tiêu đề "E2B API" server URL mẫu `https://api.e2b.app` (`src/api/openapi.yml:4-7`): `/sandboxes` CRUD, `/sandboxes/{id}/pause|resume|fork|connect|timeout|network|refreshes|snapshots|custom-extension-params`, `/sandboxes-cold`, `/snapshots`, `/templates` (v1/v2/v3) + `/templates/{id}/builds/{buildID}` + `/templates/aliases/{alias}`, `/nodes`, `/health`. Implementations tại `src/api/impls/` (sandbox.rs, snapshots.rs, template.rs, admin.rs, auth.rs, pagination.rs).
- **CLI `aenv`**: `auth, pull, template, start, cn (connect), exec, ls, pause, resume, timeout, delete/rm, snapshot, build, upload, download, completion` (`crates/aenv/src/commands/` — 17 file lệnh). Output TTY table/JSON (`README.md:137-138`).
- **E2B compat**: trỏ `E2B_API_URL` → dùng E2B Python/TS SDK không đổi code (`README.md:108-113`); có cả E2B local benchmark script `.github/workflows/e2b-benchmark.yml` + `scripts/e2b/run-e2b-benchmark.sh`.
- **Template builder kiểu Dockerfile**: build spec declarative RUN/ENV/WORKDIR steps → committed snapshot (`src/template/build_spec.rs`, `builder.rs`, `step_executor.rs`, `runner.rs`; `CLAUDE.md:108`), API build async theo dõi status.
- **Snapshot image export tool**: `aenv-snapshot-image` (`src/bin/aenv-snapshot-image.rs`) publish rootfs snapshot ra OCI image overlaybd-native qua regctl, idempotent theo manifest digest (`CLAUDE.md:112`).
- **Custom extension hooks**: dịch vụ HTTP ngoài tuỳ chọn với 4 hook `start-fresh`, `start-resume`, `patch-params`, `stop`, params JSON opaque per-sandbox (`CLAUDE.md:114`, `src/sandbox/custom_extension/`).

### 2.6 Tích hợp bên ngoài

- **RL framework**: không hard-code framework nào; các RL harness (Kimi K3 trainer) gọi qua E2B-compatible API. Repo không nhắc SWE-bench/verl/OpenRLHF (grep không kết quả — tích hợp происходит ở tầng API, không nằm trong repo).
- **E2B ecosystem**: client SDK E2B + envd E2B trong guest.
- **OCI registry bất kỳ** (Docker Hub, ghcr, private registry có docker login), **S3-compatible object storage** qua OpenDA (`Cargo.toml:49`, `crates/object-store-operator`), snapshot OSS backend có thể publish delta về **source registry** (`snapshot_image_storage = "source_registry"`, `CLAUDE.md:110`).
- **Kubernetes**: DaemonSet node + gateway Deployment + kustomize overlays (`deploy/k8s/base/agentenv-daemonset.yaml`, `gateway-deployment.yaml`); Docker Compose (`deploy/docker-compose.yml`).
- **Virtualization fallback**: mode `kvm` hoặc `pvm` (kvm_pvm cho host không có KVM chuẩn, chỉ x86_64) (`src/virtualization.rs:16-47`, `README.md:40`).
- ARM64 support (`commit 8b29280 feat: add ARM64 support`), openEuler detection (`33ac534`).

## 3. Trạng thái dự án

| Mục                | Giá trị                                                                                                                                                                                                                                                                                                                                                                           | Bằng chứng                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| License            | **MIT** (Copyright 2026 AgentENV)                                                                                                                                                                                                                                                                                                                                                 | `LICENSE:1-3`, `Cargo.toml:5`          |
| Ngôn ngữ chính     | **Rust** (~151.312 LOC `.rs`, 347 file rs+go)                                                                                                                                                                                                                                                                                                                                     | `wc -l` toàn repo                      |
| Ngôn ngữ phụ       | Go ~14.520 LOC (services gateway+scheduler); Python ~758 LOC (scripts/tests)                                                                                                                                                                                                                                                                                                      | `find … wc -l`                         |
| Version            | **0.1.2** (tags v0.1.0 → v0.1.2)                                                                                                                                                                                                                                                                                                                                                  | `Cargo.toml:31`, `git tag`             |
| Activity           | 72 commits; đầu 2026-07-25, mới nhất 2026-08-11 (commit `6e8deea`) — ~3 tuần tuổi, phát triển rất dày                                                                                                                                                                                                                                                                             | `git rev-list --count HEAD`, `git log` |
| Contributors       | 8: Sixing Lin (20), Yingdi Shan (12), huajq (9), Tao Lin (5), Linzhi Zheng (5), huang-jl (3), morluto (2), +1                                                                                                                                                                                                                                                                     | `git log --format="%an"`               |
| Cấu trúc top-level | 18 workspace members Rust: root `agentenv`, `adev` (CI tooling), `crates/{aenv,benchmarks,e2e-tests,linux-cap,object-store-operator,observability,shell-util,test-support,warm-pool}`, `src/api/generated`, `src/custom_extension_api/generated`, `thirdparty/{firecracker-client,envd}`, `storage/{util,overlaybd,ublk,ublk-daemon}` + Go module `services/` (`Cargo.toml:8-28`) | —                                      |
| CI/CD              | 13 GitHub workflows: ci, integration-tests, mutation-tests, coverage, benchmark, e2b-benchmark, ublk-tests, envd-tests, services-ci, docs, release (static Linux binaries + bundle OverlayBD tools, `19c8bd3`), publish-tools-image, open-code-review                                                                                                                             | `.github/workflows/`                   |
| Yêu cầu chạy       | Linux kernel 6.8+, `/dev/kvm` (hoặc PVM); **chưa có authorization** — cảnh báo không expose public (`README.md:37-49`)                                                                                                                                                                                                                                                            | —                                      |
| Docs               | mdBook `docs/src/` (concepts, deployment, configuration, integration/e2b, internals incl. architecture + p2p-design) + swagger-ui                                                                                                                                                                                                                                                 | `docs/src/SUMMARY.md`                  |
| Testing            | unit + integration cần root/kvm (`tests/integration/` 7 file), e2e OSS snapshot (`crates/e2e-tests/tests/snapshot_oss_e2e_test.rs`), 4 criterion benches (snapshot, ublk_overlaybd, oci_conversion, orchestrator_store)                                                                                                                                                           | —                                      |

## 4. Năm điểm độc đáo nhất

1. **Memory snapshot thành block device**: RAM VM được đóng gói thành overlaybd layers và restore qua read-only ublk device được mmap làm memory backend của Firecracker, **chia sẻ qua refcount giữa mọi sandbox cùng template** — boot/resume < 50 ms và page cache dùng chung cho cả storage lẫn memory (`CLAUDE.md:84`, `README.md:29,31`). Cách tiếp cận này gần như không có ở dự án sandbox khác.
2. **Storage stack tự chế từ đầu trong Rust**: định dạng LSMT layered image, ublk userspace block device, io_uring slab-allocated, daemon quản lý device qua Unix socket — thay vì dựng trên overlaybd Go của containerd; scale 1.5M image với local disk chỉ là bounded cache (`storage/overlaybd/`, `storage/ublk/`, `README.md:28`).
3. **Drop-in thay thế E2B**: API OpenAPI clone E2B + chạy chính envd của E2B trong guest + benchmark so sánh trực tiếp với E2B local — kho client E2B Python/TS dùng được ngay không sửa code (`src/api/openapi.yml:4`, `thirdparty/envd/README.md`, `scripts/e2b/`).
4. **Fork VM đang chạy thành N sandbox + snapshot incremental < 100 ms** là primitive API first-class (`POST /sandboxes/{id}/fork`), phục vụ chính xác pattern RL rollout song song / multi-agent workflow (`CLAUDE.md:102`, `service.rs:484`).
5. **Production-proven cho frontier RL + P2P iroh + memory ballooning 9.6x**: là hạ tầng chạy Kimi K3 training; có thêm lớp P2P truyền artifact node-to-node (iroh-blobs) tích hợp scheduler index và PVM mode cho host thiếu KVM — ba thứ không thấy cùng lúc ở bất kỳ open-source sandbox platform nào (`README.md:22,31,40`, `CLAUDE.md:35`).

## 5. Điểm yếu / giới hạn ghi nhận

- Không có authorization/authentication thực — chỉ API key dummy, cảnh báo chạy mạng tin cậy (`README.md:46-50`).
- Scheduler mặc định in-memory (binding mất khi restart nếu không bật Redis); observed-node state + P2P index luôn ephemeral (`CLAUDE.md:90`).
- Dự án rất trẻ (< 1 tháng commit history public), v0.1.x, API đang dịch chuyển (templates v1→v3).
- Yêu cầu root + kernel 6.8+ + KVM — không chạy được trên macOS/Windows, không có chế độ container-only (Docker run vẫn `--privileged -v /dev:/dev`, `README.md:69`).

---

# AgentEnv — Subagent 2: Ưu điểm & áp dụng vào Ghita

Repo: `D:\GHITA AGENT\refer_project\infra\AgentEnv` (kvcache-ai/AgentENV, tag `v0.1.2`, 843 deps trong Cargo.lock).
Phạm vi: đọc sâu orchestrator/sandbox/snapshot/network/storage/envd/API. Chỉ đọc, không chạy code.

## 0. Xác minh license (quan trọng)

- **MIT, sạch.** `LICENSE:1-3` — "MIT License, Copyright (c) 2026 AgentENV"; `Cargo.toml:5` khai `license = "MIT"`. **Không có GPL/AGPL trong mã nguồn repo** (grep Cargo.toml/Cargo.lock không ra GPL/AGPL trực tiếp). Báo cáo trước ghi "không rõ" → nay xác nhận: **được phép tham khảo, copy pattern, và copy code (giữ license notice) vào Ghita.**
- Lưu ý phụ: `Cargo.lock:6524` có `rocksdb` (AgentENV dùng cho `src/local_store.rs`, CLAUDE.md:37). RocksDB là dual-license GPLv2+FOSS-exception / Apache-2.0 — nếu Ghita muốn dùng crate này thì chọn nhánh Apache-2.0, không vi phạm ràng buộc cấm GPL.

## 1. Ưu điểm nổi bật (xếp hạng theo giá trị tham khảo cho Ghita)

1. **Trait lifecycle backend + lỗi có phân loại Recoverable/Terminal** — `src/sandbox/backend.rs:172-256`: `SandboxBackend` trait (start/pause/resume/snapshot/fork/stop) + `SandboxCaptureError::{Recoverable,Terminal}` (`backend.rs:49-69`): lỗi Recoverable cam kết sandbox đã quay về Running trước khi trả lỗi; Terminal nghĩa là runtime đã bị biến đổi, phải teardown. Đây là hợp đồng lỗi hiếm thấy được thiết kế kỹ đến mức này.
2. **Snapshot/fork là citizen hạng nhất** — fork = pause → resume nguồn → spawn N con từ snapshot config (`src/sandbox/firecracker/sandbox.rs:335-384`); orchestrator giữ state machine + rollback trạng thái khi fork lỗi (`src/orchestrator/service.rs:503-596`). Trạng thái paused là handle opaque (`PausedSandboxState`, `backend.rs:31-38`; `CapturedSandboxSnapshot`, `backend.rs:127-157`) — orchestrator không hiểu chi tiết backend.
3. **State machine lifecycle tường minh** — 8 trạng thái `Creating/Resuming/Running/Snapshotting/Forking/Pausing/Paused/Killing` (`src/orchestrator/types.rs:56-66`), chuyển trạng thái kiểu CAS `update_if_state(..., &[expected_states])` (`service.rs:521-535`) — chống race giữa pause/fork/delete.
4. **Storage layering LSMT (overlaybd)** — layer r/o nén zstd + 1 upper r/w append-only, read đi qua stack top-down, snapshot = `close_seal + restack` biến upper thành lower mới và mở upper mới tại chỗ (`docs/src/internals/architecture.md:61-81`, CLAUDE.md:72). Mọi write của sandbox chỉ vào upper → **rollback miễn phí**.
5. **Nhớ cấp phát tài nguyên đếm được + fail-closed GC** — image refs pin/unpin cho artifact runtime, startup reconcile fail-closed rồi mới chạy maintenance (`service.rs:196-217, 250-313`); disk cache có watermark 0.95/0.70 (`config/default.toml:108-110`).
6. **Network isolation per-sandbox, đổi policy runtime** — `SandboxNetworkPolicy` allowOut (CIDR+domain) / denyOut (CIDR-only), allow ưu tiên (`src/sandbox/network/policy.rs:17-59`), set lại policy trên sandbox đang chạy (`firecracker/sandbox.rs:417-429`, `network/slot.rs:451`). Domain-allow cần TCP egress proxy (`policy.rs:111-113`).
7. **Warm pool generic theo watermark** — crate tái sử dụng cho network slot + ublk device + Firecracker pre-spawn (`crates/warm-pool/src/lib.rs:17-53`); refill/drain async, shutdown an toàn, atexit cleanup.
8. **TTL + auto-eviction có chính sách** — timeout_action (kill hoặc pause) chạy nền mỗi interval, bỏ qua tick lỡ (`service.rs:1827-1878`), TTL gia hạn được (`aenv timeout <id> 600`).
9. **Persistence qua restart** — paused sandbox persist file-backed (`src/orchestrator/persistence/file_backed.rs:86-108`), restore về Paused khi khởi động lại (`service.rs:159-171`) thay vì mất hết.
10. **Testability + observability + CI nghiêm** — MockSandboxBackend/MockBackendFactory cho unit test orchestrator không cần VM (`src/sandbox/mock.rs:1-42`); counters tăng dần + watch channel (`src/orchestrator/metrics.rs:14-51`); 13 workflow CI gồm mutation-tests, coverage, benchmark (`.github/workflows/`).

## 2. Cái hay áp dụng vào Ghita

### (a) Pattern đáng lấy cho môi trường chạy lệnh của agent

- **Hợp đồng backend + lỗi snapshot**: định nghĩa trait "môi trường chạy lệnh" tách rời cách thực thi; mọi thao tác nguy hiểm (snapshot/rollback) phải trả lỗi 2 lớp: rollback được (env còn dùng được) vs hỏng luôn (phải teardown). Ghita nên copy trực tiếp taxonomy này.
- **Rollback = ghi vào upper, bỏ upper**: không cần chụp toàn bộ workspace trước mỗi lần chạy. Trên Windows: chạy lệnh hướng vào **overlay directory** (thư mục ghi đè / temp workspace), rollback = xóa upper; dữ liệu thật chỉ merge khi lệnh được chấp nhận.
- **Snapshot checkpoint giá rẻ theo chu kỳ**: checkpoint = seal upper hiện tại thành "lớp trước", mở upper mới — lịch checkpoint dạng stack, undo nhiều bước.
- **Network policy dạng declarative cho process**: allow/deny CIDR+domain gắn vào phiên sandbox, sửa được giữa chừng; mặc định deny.

### (b) Mapping cụ thể sang crates/sandbox + packages/security + packages/computer-use

| Pattern AgentEnv                                                                                                                                                              | Ghita — áp dụng trên Windows                                                                                                                                                       | Giá trị | Độ khó                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------- |
| Trait `SandboxBackend` + `SandboxCaptureError` (backend.rs:172, 49)                                                                                                           | Nâng `crates/sandbox` (hiện `SandboxProfile` + Job Object ở `crates/sandbox/src/windows.rs:12-28`) thành trait backend: `SupervisedBackend` (Job Object) ↔ tương lai `Wsl2Backend` | Cao     | Trung                     |
| Upper-layer rollback (LSMT)                                                                                                                                                   | Overlay dir per-run trong crates/sandbox: ghi vào `%TEMP%`/thư mục upper, commit mới merge về workspace. Chỉnh `restrict_writes` (windows.rs:25-28 đang no-op) thành redirect-ghi  | Cao     | Trung                     |
| Resource limits (disk_rate_limit config/default.toml:173; memory ballooning)                                                                                                  | Job Object native: `JOB_OBJECT_LIMIT_PROCESS_MEMORY` + CPU rate control + IO counters — thêm vào `windows.rs`                                                                      | Cao     | Dễ                        |
| TTL + auto-evict (service.rs:1827)                                                                                                                                            | TTL per-session sandbox: timeout_action kill (Job Object terminate) hoặc "pause" (ghi log + đóng); gia hạn TTL khi agent còn hoạt động                                             | Cao     | Dễ                        |
| Network policy allow/deny (policy.rs:17-59)                                                                                                                                   | packages/security PolicyEngine sinh policy; thực thi bằng Windows Firewall per-app (WFP) hoặc local egress proxy cho domain-allow (chính AgentEnv cũng cần proxy cho domain)       | Cao     | Khó (WFP) / Trung (proxy) |
| Warm pool (crates/warm-pool)                                                                                                                                                  | Pool shell/worker đã spawn sẵn (PowerShell, Node) tái dùng giữa các lần chạy lệnh; copy gần nguyên ý tưởng watermark                                                               | Trung   | Dễ                        |
| Persist qua restart (file_backed.rs:86)                                                                                                                                       | Lưu trạng thái session sandbox opaque vào profile Ghita để phục hồi/audit sau restart                                                                                              | Trung   | Dễ                        |
| Lifecycle hooks start/stop (CLAUDE.md:114)                                                                                                                                    | packages/security audit-hook khi sandbox tạo/bắt đầu/kết thúc — khớp audit-runner hiện có                                                                                          | Trung   | Dễ                        |
| envd process/filesystem API (`thirdparty/envd/proto/process.proto`: Start/StreamInput/SendSignal/PTY/CloseStdin; filesystem.proto: Stat/MakeDir/Move/ListDir/Remove/WatchDir) | Làm "operator contract" cho packages/computer-use: tập lệnh/giám sát process + FS xem như service có schema, không ad-hoc                                                          | Trung   | Trung                     |
| Counters + watch channel (metrics.rs:14)                                                                                                                                      | Metrics sandbox (số lệnh, bytes ghi, violation) gắn vào status/GUI                                                                                                                 | Trung   | Dễ                        |

**Chỉ là ý tưởng xa (không nên làm trong 0.0.2-alpha):**

- Firecracker microVM: cần Linux kernel 6.8+ bare-metal với `/dev/kvm` (README.md:37-38, CLAUDE.md:5) — **không dùng được trên Windows desktop**.
- overlaybd/ublk/io_uring, memory-snapshot ublk restore (archi.md:83-99, 125-133): hoàn toàn Linux kernel driver.
- VSS snapshot rollback workspace: khả thi về kỹ thuật nhưng cần admin/COM, dễ gãy trên máy người dùng — chỉ cân nhắc nếu overlay-dir không đủ.
- WSL2 backend: nếu sau này cần isolation mạnh hơn, hiện thực hóa `Wsl2Backend` theo đúng trait — nơi đó overlayfs/ns/rollback kiểu AgentEnv mới tồn tại thật.
- Gateway/Scheduler đa node (services/): ngoài phạm vi desktop local-first.

### (c) Tổng kết giá trị/độ khó

- **Làm ngay (cao/dễ):** Job Object resource limits, TTL auto-evict, audit hooks, metrics counters.
- **Kế hoạch (cao/trung):** trait backend refactor + overlay-dir rollback (sửa restrict_writes no-op), warm pool.
- **Xa (cao/khó hoặc trung/khó):** egress network policy thực thi thật (WFP/proxy), WSL2 backend, VSS.

## 3. Hạn chế / rủi ro

- **License:** đã xác minh MIT (`LICENSE:1`, `Cargo.toml:5`) — an toàn với ràng buộc cấm GPL/AGPL của Ghita. Cảnh báo duy nhất: dep `rocksdb` (`Cargo.lock:6524`) dual GPLv2+FOSS-exception/Apache-2.0 — chỉ chọn nhánh Apache-2.0 nếu dùng.
- **Firecracker chỉ chạy Linux bare-metal** (`/dev/kvm`, README.md:37-38): toàn tầng VM/snapshot-memory/ublk không mang sang Windows được; chỉ lấy được **thiết kế/khái niệm**, không lấy được code runtime.
- **Không có authorization** — README.md:47-49 cảnh báo rõ "does not support authorization", API key `dummy`; `src/api/impls/auth.rs:19` còn TODO validate credentials. Chỉ an toàn trong trusted network.
- **Độ chín OSS còn non:** tag `v0.1.0–v0.1.2`, bản quyền 2026; production-tested ở scale Moonshot (1.5M images, README.md:28) nhưng mặt OSS trẻ. Scheduler binding chỉ in-memory, mất khi restart (archi.md:245). `storage/uffd-core` bị loại khỏi build (để tham khảo).
- **Độ phức tạp vận hành rất cao:** setup-host root một lần (kvm group, ublk perms, sysctls — CLAUDE.md:31), Docker `--privileged` mount `/dev` (README.md:69), phụ thuộc regctl/umoci, 843 crates deps — chi phí vận hành không phù hợp sản phẩm desktop.

## 4. 3 thứ KHÔNG nên học

1. **Tầng storage đồ sộ (LSMT/overlaybd/ublk-daemon/iroh P2P)** — `storage/` 86 file.rs + `src/p2p/`: giải quyết bài toán 1.5 triệu image trên cluster; desktop Ghita không có bài toán đó. Học _khái niệm upper-layer rollback_, không học _cách cài đặt_.
2. **Control plane phân tán (gateway + scheduler + heartbeat + binding TTL)** — `services/` Go module, chỉ cần cho nhiều node; desktop là 1 máy, thêm lớp này chỉ tạo phức tạp và failure mode mới.
3. **Tư thế "trusted network, không auth"** — API mở không xác thực (README.md:47-49). Ghita chạy trên máy người dùng nhưng vẫn phải đi qua PolicyEngine/packages/security cho từng lệnh — không bao giờ copy lối bỏ xác thực dù "chỉ local".

## 5. Kết luận

AgentENV đáng học nhất ở **tầng thiết kế hợp đồng** (trait backend + lỗi Recoverable/Terminal + state machine CAS + opaque paused state), không phải ở tầng triển khai Linux-specific. Bộ 4 việc cao/dễ (Job Object limits, TTL evict, audit hooks, counters) có thể bắt tay ngay; trait-backend refactor + overlay-dir rollback là nâng cấp cấu trúc quan trọng nhất cho crates/sandbox trước khi cân nhắc WSL2. License MIT đã xác minh — tự do tham khảo cả code.
