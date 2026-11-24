# AgentEnv — Lượt 2: Kiến trúc & thuật toán

> **Dự án:** kvcache-ai/AgentENV v0.1.2 (MoonshotAI) · clone: `refer_project/infra/AgentEnv`
> **Phương pháp:** 2 subagent đọc sâu song song 22/11/2026, chỉ đọc mã nguồn. Subagent 1 = kiến trúc; Subagent 2 = thuật toán & kỹ thuật cốt lõi.

## Tóm tắt nhanh (tổng hợp)

- **Kiến trúc:** node Rust (Axum API tương thích E2B — `src/api/openapi.yml:4` + orchestrator per-node là source-of-truth) / Go control plane (gateway + scheduler) chỉ giữ metadata điều phối, không chạm runtime state; luồng tạo sandbox: gateway parse hint → gRPC `Schedule` (K8s EndpointSlice discovery, RoundRobin/Random) → `launch_sandbox` (service.rs:1909) → CAS Running → publish proxy route.
- **Abstraction:** trait `SandboxBackend`/`Factory` (backend.rs:172/263) + hợp đồng lỗi Recoverable/Terminal; state machine 8 trạng thái CAS (`update_state_if_state`); snapshot repo đa backend (OSS/posixfs/ACR); Go↔Rust sync = 1 file proto scheduler.v1 (13 RPC, tonic) + heartbeat mang version + Redis BindingStore.
- **Thuật toán đáng học:** snapshot = memory diff (sparse seek_data/hole hoặc dirty-pages qua process_vm_readv) → compact thành LSMT layer → rename nguyên tử; fork = pause → N child share 1 ublk device bộ nhớ (pool Weak + Arc strong count làm refcount, `device.rs:468-656`) → Firecracker LoadSnapshot nhận `/dev/ublkbN` → lazy page-in → resume <50ms; LSMT bitfield 50/14/55 bit + merge theo tag + compact 2-phase + group commit; token bucket refill 1000ms pin + trick sentinel bucket(0,0) xoá limit; warm pool watermark Fill/Drain + fill_target ratchet ×2 + TTL evict qua BTreeSet expiry index; kill = vòng lặp wait-then-retry; notify qua watch channel `send_replace`.
- **Port được cho Ghita (Windows):** WarmPool, state machine CAS + watch, LRU cache refcount, template-builder workflow, iroh P2P, token-bucket → Job Objects IO rate. Linux-only (học ý tưởng): ublk/io_uring/LSMT (thay bằng overlay-dir COW), process_vm_readv, DAMON balloon.
- **Điểm yếu:** HTTP contract Go↔Rust không schema, metadata node không replicate (node chết mất sandbox Running), khóa API surface E2B, chưa có authorization.

---

# AgentEnv — Subagent 1: Kiến trúc

> Repo: `refer_project/infra/AgentEnv` (kvcache-ai/AgentENV, v0.1.2). Rust workspace ~152k dòng (132,344 tay + 20,072 generated — đo bằng `wc -l` trên src+crates+storage+thirdparty). Tất cả path dưới đây tương đối với root repo, kèm dòng bằng chứng.

## 1. Bản đồ module & ranh giới component

### Workspace (Cargo.toml:13-26)

Members: crate gốc `agentenv` (server per-node) + `adev` (dev tool), `crates/{aenv, benchmarks, e2e-tests, linux-cap, observability, object-store-operator, shell-util, test-support, warm-pool}`, `src/api/generated`, `thirdparty/{firecracker-client, envd}`, `storage/{util, overlaybd, ublk, ublk-daemon}`.

### Tầng Rust per-node (src/, src/lib.rs:1-18)

- **src/api** — Control-plane HTTP (Axum). `openapi.yml:4` tiêu đề nguyên văn `"title: E2B API"` → sinh code bằng openapi-generator 7.22 (`openapitools.json`) thành `src/api/generated` (apis: admin, sandboxes, snapshots, templates). Implement tay trong `src/api/impls/` (sandbox.rs 1,501 dòng: `sandboxes_post`, `sandboxes_cold_post`:385, pause/resume/fork/timeout/network...). `api/server.rs:8-20` merge router generated + `/proxy/*` (api/proxy.rs — reverse proxy HTTP+WebSocket tới IP VM) + `/metrics`.
- **src/orchestrator** — Trái tim node. `service.rs` 2,507 dòng: `Orchestrator` với create/fork/delete/pause/resume/capture_snapshot/shutdown/evict_expired. State: `store/mod.rs:56-101` trait `MetadataStore` (CAS `update_state_if_state`:61, `update_if_state`:73, `wait_while_in_states`:96); metadata持久 qua `persistence/file_backed.rs` (RocksDB `records.db`, `RECORD_VERSION=1`:11, `PersistedPausedRecord`:22-32); proxy route table (`orchestrator/proxy.rs:5-36`).
- **src/sandbox** — Abstraction backend + hiện thực Firecracker. `backend.rs:172-256` trait `SandboxBackend`; `:263-291` trait `SandboxBackendFactory`; `:305-390` trait `SandboxExecutor` (run_command/start_process qua envd). `firecracker/`: sandbox.rs 2,337 dòng (start_fresh:1196, start_resume:1373, pause:629, snapshot_to_dir:663, fork), overlaybd_snapshot.rs 1,280 dòng (memory/disk diff → overlaybd layer, `close_seal + restack`:1-11), factory.rs, pool.rs, mmds.rs. `network/` (manager.rs — iptables NAT, slot pool, address plan), `ublk/` (quản lý thiết bị block user-space).
- **src/image + storage/** — Image & block-storage stack: `image/cache/` (graph.rs, gc.rs, store.rs — node-local cache OCI→overlaybd, GC có hold/release theo `RuntimeImageOwner::StartingSandbox/PausedSandbox` store.rs:44-47); `storage/overlaybd` (layering + index + virtual_file), `storage/ublk` + `ublk-daemon` (thiết bị block qua io_uring, lib.rs:34 spawn_data_io_ring_worker).
- **src/snapshot** — `manager.rs` (SnapshotManager: create/publish/publish_captured/get/resolve_runnable, try_start_build:269); `repository/interfaces.rs:117` trait `SnapshotRepository` + `:198` `SnapshotRuntimeResolver`; backends `repository/backends/{oss (S3-compatible), posixfs, common/acr (OCI registry)}`; `image_export/` (regctl push image); `p2p.rs` chia sẻ artifact.
- **src/template** — Build system kiểu Dockerfile: `builder.rs:39-68` `build_and_publish` / `build_from_snapshot_and_publish`; build_spec, runner, step_executor (chạy bước build trong sandbox thật, publish thành snapshot).
- **src/p2p** — P2P artifact transport bằng iroh (iroh/endpoint.rs, transport.rs, catalog.rs), discovery qua scheduler (`p2p/discovery/scheduler.rs`) hoặc static.
- **src/observability** — `reporter.rs:18` gRPC client scheduler: heartbeat định kỳ + `ReportSandboxEvent` cho lifecycle events; host/machine metrics; prometheus.
- **src/types, identity, virtualization** — SandboxId (uuid v7), `NodeIdentity` (identity.rs:12-18: id/cluster_id/commit/version), `VirtualizationMode {Kvm, Pvm}` (virtualization.rs:6-10).
- **crates/aenv** — CLI `aenv` (commands: pull, start, build, snapshot, pause, resume, exec, upload...). `grpc/mod.rs:1-3` nói rõ: "envd (forked from e2b-dev) speaks the ConnectRPC" — CLI nói Connect protocol qua reverse proxy tới envd.
- **thirdparty/envd** — Guest agent trong VM (fork từ e2b-dev): gRPC `Process` (proto/process.proto: Start/Connect/StreamInput/SendSignal) và `Filesystem` (filesystem.proto: Stat/MakeDir/WatchDir...); `http-client` sinh từ OpenAPI của envd.
- **thirdparty/firecracker-client** — Generated client cho Firecracker microVM API.

### Tầng Go control plane (services/)

- **gateway** (`gateway/cmd/main.go`, internal/) — Entrypoint HTTP cho cluster: parse hint từ body (`schedule_hint.go:19-45` cho POST /sandboxes, /sandboxes-cold), gọi `Scheduler.Schedule` gRPC, `proxyRequest` (`server.go:291`) tới node, route traffic sandbox theo host/header (`server.go:33-37`: `x-agentenv-sandbox-id`/`e2b-sandbox-id`; `host_route.go:22` parseHostRoute theo sandbox proxy domains), endpoint `/nodes` (`node_list.go:99`).
- **scheduler** (`scheduler/cmd/main.go`, internal/) — Placement + registry: node discovery theo mode `kubernetes` (EndpointSlice informers — kubernetes_discovery.go:64-93) hoặc static list (main.go:63-73); strategy RoundRobin/Random (`strategy.go:13-51`); filter resource limit (`service.go:81`); BindingStore sandbox→node: in-memory hoặc Redis (`redis_store.go:14-28`); artifact index cho P2P (`store.go:171`); heartbeat TTL → NodeStatus READY/UNHEALTHY/LINGERING (scheduler.proto:103-111).
- **shared/** — config, logging (zap), observability dùng chung gateway/scheduler.

### Ranh giới cốt lõi

Go control plane **chỉ giữ metadata điều phối** (node registry, sandbox→node binding, P2P index) — không bao giờ chạm runtime state. Sandbox state (metadata + paused record + VM) là source-of-truth trên node Rust; scheduler chết không ảnh hưởng sandbox đang chạy. Node chạy độc lập ở single-node mode (README quick start) mà không cần gateway/scheduler.

## 2. Luồng end-to-end

### Tạo sandbox (warm path, từ snapshot)

1. Client (E2B SDK / aenv CLI) → **Gateway (Go)** POST /sandboxes; gateway buffer body ≤64KB để parse hint (schedule_hint.go:47-48) rồi restore body.
2. Gateway → **Scheduler** gRPC `Schedule` (scheduler.proto:7, ScheduleRequestHint oneof `new_cold_sandbox`/`new_sandbox`:32-55).
3. Scheduler: snapshot registry → FilterByResourceLimit → `strategy.Select` → trả Node{endpoint} (scheduler/internal/service.go:71-108).
4. Gateway `proxyRequest` tới node; `RecordAssignment` ghi binding sandbox→node vào Redis/in-memory (server.go:260 `shouldRecordAssignment`).
5. **Node (Rust)**: `impls/sandbox.rs` map request → `Orchestrator.create_sandbox` (service.rs:320) → `create_sandbox_inner`:337 chọn `SandboxLaunchSource::Snapshot` hoặc `::Image`, dựng `SandboxMetadata` transitional, gói thành `LaunchPlan`.
6. `launch_sandbox` (service.rs:1909-2079) — thứ tự rất kỹ: `build_sandbox` (2081) → `factory.build_from_snapshot` (firecracker/factory.rs) → `protect_image_refs` giữ artifact khỏi image-GC (1927-1941) → `start_nowait` → `store.add` (persist trước khi công bố) → `wait_for_ready` (probe envd trong guest) → CAS `update_if_state` transitional→Running (2029-2049) → `upsert_proxy_route` (2064-2069) → publish event Create → reporter gửi `ReportSandboxEvent` lên scheduler.
7. **Backend create**: Firecracker VM mount rootfs là thiết bị ublk/overlaybd xếp layer từ local cache (lazy pull từ object store/P2P khi miss); envd trong guest expose gRPC; metadata qua MMDS (`extra_mmds` — sandbox/mod.rs:63-66).
8. **Expose endpoint**: node publish `ProxyRoute{ip}` (orchestrator/proxy.rs:5-10); traffic sandbox đi gateway theo host domain hoặc header → node → `/proxy/*` (api/proxy.rs) → IP VM. Cold start (/sandboxes-cold, sandbox.rs:385-514): resolve OCI ref + attached drives → `SandboxLaunchSource::Image`.

### Pause / Resume / Snapshot / Fork

- **Pause** (service.rs:1003-1127): CAS Running→Pausing (1005-1008, conflict → `join_concurrent_pause` 1015); protect image refs; allocate artifact root; detach handle + proxy route; `backend.pause` → Firecracker pause API + diff dirty pages (4KB — overlaybd_snapshot.rs:26) + `close_seal + restack` overlaybd upper; persist `PersistedPausedRecord`. Lỗi **Recoverable** → trả sandbox về Running; **Terminal** → stop + remove (1102-1114).
- **Resume**: CAS Paused→Resuming; decode paused state qua `factory.decode_paused_state` (backend.rs:279); `build_from_paused_state`; sau khi ready xoá persisted record (2071-2075). Crash recovery: `reconcile_paused_at_startup` (service.rs:291) nạp lại paused record từ RocksDB lúc boot.
- **Snapshot** (service.rs:1349; firecracker/sandbox.rs:302-333): pause_to_dir vào `live_snapshot_root` riêng, **resume source ngay sau đó** (sandbox chạy tiếp), `CapturedSandboxSnapshot` → `SnapshotManager.publish` → SnapshotRepository (OSS/posixfs/ACR) ghi layer incremental + memory layer.
- **Fork** (service.rs:503-648; sandbox.rs:335-384): CAS Running→Forking; backend.fork: pause VM → resume source → build + start mỗi child đồng thời (`join_all`) từ cùng snapshot config (memory CoW qua shared snapshot); register từng child (clone metadata); lỗi terminal → hủy source (551-557).

### State machine 8 trạng thái + CAS

`SandboxState`: Creating, Resuming, Running, Snapshotting, Forking, Pausing, Paused, Killing (orchestrator/types.rs:57-66). Mọi chuyển tiếp đi qua `MetadataStore.update_state_if_state/update_if_state` với `expected_states` (store/mod.rs:61-80); conflict trả `StoreError::StateConflict` kèm actual state (34-41). `wait_while_in_states` (96-100) + `join_concurrent_pause/resume` (service.rs:1731, 1765) xử lý nhiều caller cùng tác động một sandbox.

## 3. Abstraction then chốt & đánh đổi

1. **trait `SandboxBackend`** (backend.rs:172-256): start/start_nowait/wait_for_ready/pause/resume/snapshot/fork/stop + host_interaction_ip/runtime_info/update_network_policy. **Hợp đồng lỗi** `SandboxCaptureError::{Recoverable, Terminal}` (50-69): Recoverable = sandbox đã được trả lại trạng thái chạy được; Terminal = runtime đã bị mutate, caller phải bỏ (doc tại 192-197). Impl duy nhất production: `FirecrackerSandbox` (sandbox.rs:260-433); mock cho test (sandbox/mock.rs).
2. **`SandboxBackendFactory`** (263-291): build (từ image), build_from_snapshot, decode/build_from_paused_state — điểm đóng duy nhất giữa orchestrator và công nghệ ảo hoá; `PausedSandboxState`/`CapturedSandboxSnapshot` là **opaque** (31-38, 127-157, `Box<dyn Any>`) — orchestrator chỉ vận chuyển, không hiểu cấu trúc → thêm backend mới không phải sửa orchestrator (nhưng hiện chỉ có 1 impl thật → abstraction chưa được kiểm chứng bởi pluralism).
3. **Storage trait**: `MetadataStore` (runtime, in-memory) tách khỏi `SandboxPersister` (durable, RocksDB file-backed) — dual-store chủ ý: memory store nhanh + persister cho crash recovery. `SnapshotRepository` (interfaces.rs:117) + `SnapshotRuntimeResolver` (198) đa backend OSS/posixfs/ACR. Image cache GC với hold/release theo owner (image/cache/store.rs:44-47) chống xoá layer đang bị sandbox/paused record dùng.
4. **Template/build system**: `TemplateBuilder` chạy build-spec (giống Dockerfile) trong sandbox thật rồi publish snapshot (builder.rs:39-68); `SnapshotRuntimeVersions` (snapshot/types/version.rs:11-16: kernel/firecracker/envd/tools_drive) probe lúc build và check tương thích khi launch (VirtualizationModeMismatch — orchestrator/mod.rs:50-57).
5. **E2B-compatible API**: openapi.yml là spec E2B gốc (openapi.yml:4), headers tương thích e2b-sandbox-id/e2b-sandbox-port (gateway/server.go:33-37), envd giữ ConnectRPC của e2b-dev (aenv/grpc/mod.rs:1-3). **Đổi lấy**: miễn phí ecosystem SDK Python/TS (README "E2B compatibility"), nhưng bị khóa API surface (phải giữ /v2/sandboxes:1404, /v3/templates:1928), và chuẩn E2B không có khái niệm node-local fork/snapshot 8-state → phải mở rộng bằng endpoint riêng (/sandboxes/{id}/fork, /refreshes, /custom-extension-params).

## 4. Giao tiếp Go ↔ Rust

- **Contract duy nhất**: `services/api/proto/scheduler.proto` — package `scheduler.v1`, go_package `agentenv/services/api/proto`, 13 RPC (Schedule, LookupNode, RecordAssignment, Heartbeat, ReportSandboxEvent, ListObservedNodes, ListP2pPeers, Record/Lookup/ForgetP2pArtifact, GetNode, UnregisterNode — scheduler.proto:7-27). Rust sinh code tonic (`src/proto.rs:1-3` include_proto scheduler.v1), Go dùng scheduler.pb.go — **một file proto = schema sync tự nhiên**; versioning theo phong cách proto3: `reserved 1` cho hint cũ (57), oneof hint mở rộng thêm loại mới, enum có UNSPECIFIED (100).
- **Version tương thích runtime**: HeartbeatRequest mang version + commit + MachineInfo (161-170); NodeIdentity inject commit lúc build (identity.rs:8-18) — scheduler thấy build cũ của node qua ObservedNode. Snapshot metadata mang runtime versions để chặn mismatch (mục 3.4).
- **Data plane HTTP không có schema chung**: gateway forward nguyên văn request; các header định tuyến (x-agentenv-sandbox-id, x-agentenv-target-port...) và hint parse body là **contract phụ thủ công** giữa Go và Rust — điểm yếu nhất của việc sync 2 ngôn ngữ (mục 5).
- **Redis HA**: `BindingStore` 2 impl — InMemoryBindingStore và RedisBindingStore (go-redis v9, prefix `agentenv:scheduler:bindings`, TTL binding + node-index TTL 1h — redis_store.go:14-16). Scheduler có mode `--query-only` chỉ phục vụ LookupNode đọc Redis (scheduler/cmd/main.go:31, 52-54); gateway có `QueryOnlySchedulerAddr` tách traffic đọc sang scheduler replica (gateway/cmd/main.go:50-62) → scale read + HA qua Redis, scheduler chính không stateful-heavy.

## 5. Đánh giá kiến trúc

**Điểm mạnh**

1. **Ranh giới runtime/control-plane rất sạch**: Go chỉ điều phối metadata; state machine + VM nằm hoàn toàn ở node Rust; node chạy standalone được — một node chết không mất sandbox nào ngoài sandbox của chính nó, scheduler chết không ảnh hưởng sandbox đang chạy.
2. **Kỷ luật state/lỗi cao**: CAS state machine 8 trạng thái với expected_states, hợp đồng Recoverable/Terminal error, persistence dual-store (memory + RocksDB) + reconcile khi boot, rollback có phân tầng FailedLaunchStage (service.rs:1990-2058) — thiết kế crash-safe và concurrency-safe thực thụ, hiếm thấy ở codebase cỡ này.
3. **Kiến trúc phục vụ hiệu năng**: overlaybd lazy-load layer + image cache GC có runtime-ref holding + P2P iroh chia sẻ layer giữa node + warm/paused pool + memory ballooning — đúng như README mô tả (1.5M image, boot/resume <50ms, 9.6x overcommit); tầng storage tách thành crate riêng có thể test độc lập.

**Điểm yếu**

1. **Dual-language leakage ở data plane**: HTTP contract giữa gateway (Go) và node (Rust) chỉ là header + hint parse body hai lần (schedule_hint.go:19-45) — không có schema; khi Rust API thêm field, hint của Go có thể lệch im lặng; logic scheduling ("cold sandbox", metadata) rò rỉ vào gateway.
2. **Metadata per-node không có replication**: `InMemoryMetadataStore` + RocksDB local (orchestrator/store/in_memory.rs, persistence/file_backed.rs) — node chết mất toàn bộ sandbox Running (chỉ paused record có thể khôi phục nếu còn disk); binding ở scheduler có TTL → stale binding chỉ được vá bằng ReconcileNode qua heartbeat (store.go:77).
3. **API bị ràng buộc bởi spec E2B + thiếu auth**: giữ nguyên spec E2B nghĩa là duy trì nhiều thế hệ endpoint (/v2/sandboxes:1404, /v3/templates:1928), error mapping thủ công 400/500 từng handler (impls/sandbox.rs:502-514) dễ drift; README cảnh báo trực tiếp "does not support authorization" (README:66-69) — plataforma khó exposure công khai nếu không dựng auth proxy bên ngoài.

---

# AgentEnv — Subagent 2: Thuật toán & kỹ thuật cốt lõi

Repo: `D:\GHITA AGENT\refer_project\infra\AgentEnv` (kvcache-ai/AgentENV). Mọi path:line bên dưới tính từ repo root. Chỉ đọc, không chạy code.

## 1. Snapshot / Fork — đóng gói, share, refcount

**Pipeline pause → snapshot** (`src/sandbox/firecracker/sandbox.rs:629+`, `overlaybd_snapshot.rs`):

1. **Memory**: Firecracker pause API xuất `vm_state.bin` + mem sparse (`SnapshotType::Diff`) — chỉ trang dirty có dữ liệu, trang còn lại là hole (comment `overlaybd_snapshot.rs:670-677`). Hai đường đóng gói:
   - Sparse file → scan `seek_data`/`seek_hole`, chỉ pack extents có data: `convert_sparse_mem_to_overlaybd` (`overlaybd_snapshot.rs:680-732`).
   - Dirty-pages tracking: Firecracker trả `DirtyMemoryRanges`; chuyển thành `SegmentMapping` (offset ảnh = `image_offset`, nguồn = HVA của process VMM) rồi đọc **trực tiếp từ bộ nhớ process Firecracker qua `ProcessVmReader`** (process_vm_readv) — không ghi mem.bin ra disk: `dirty_ranges_to_segment_mappings` (`overlaybd_snapshot.rs:738-816`), `convert_dirty_memory_to_overlaybd` (`:819-845`). Trick lớn: snapshot memory không chạm disk, đọc thẳng VM live.
2. **Đóng gói layer**: `compact_to` ghi vào file `.tmp` rồi `rename` nguyên tử (`publish_memory_overlaybd_layer`, `overlaybd_snapshot.rs:632-668`); nén chỉ áp dụng cho memory layer (ZFile LZ4/Zstd), rootfs luôn Raw (`overlaybd_snapshot.rs:378-379`, `src/sandbox/ublk/overlaybd.rs:18-24`).
3. **Rootfs (restack)**: ublk daemon "seal" upper hiện tại thành lower mới + mở upper trắng; nếu khác filesystem thì copy nguyên tử + kiểm tra size với descriptor (`capture_live_overlaybd_snapshot`, `overlaybd_snapshot.rs:468-557`; RPC `restack_snapshot_device` `src/sandbox/ublk/device.rs:398-448`). Image config live được rewrite để trỏ lower mới.
4. **Layer chain + compaction**: image.json giữ mảng `lowers` theo thứ tự base→mới; khi tổng số lower vượt 32 (`DEFAULT_MAX_OVERLAYBD_SNAPSHOT_LAYERS`, `overlaybd_snapshot.rs:37`) thì compact hậu tố runtime-owned thành 1 layer duy nhất (`rewrite_lowers_with_runtime_roots`, `overlaybd_snapshot.rs:424-445`). Trick: remote lowers (rỗng file) bị chặn compact để không kéo dữ liệu về.

**Fork 1 VM → N** (`src/orchestrator/service.rs:505-648`, `sandbox.rs:335-384`):

- CAS `Running → Forking` trên source (`service.rs:521-523`), pause + resume source để có `FirecrackerSnapshotConfig`, rồi tạo N child từ cùng config (`from_snapshot_config_with_id`) và `join_all(child.start())` chạy song song (`sandbox.rs:359-383`).
- **Share bộ nhớ qua 1 ublk device duy nhất**: child resume dùng `get_or_create_shared_mem` keyed bằng canonical path của mem image config (`device.rs:468-570`). Device pool là map `PathBuf → Weak<SharedMemDeviceInner>`; hit = upgrade Weak (không tạo mới), miss = acquire daemon rồi insert qua entry API chống race (người thua tự dọn device thừa, `device.rs:547-567`). Refcount = `Arc::strong_count`; handle cuối Drop → spawn task release async + `Notify` bảo vệ giai đoạn release (`device.rs:586-656`).
- **Restore <50ms** (claim `README.md:29`): Firecracker `LoadSnapshot` nhận memory backend là chính `/dev/ublkbN` chia sẻ (`load_snapshot_file(&vm_state_src, &mem_device_path, ...)`, `sandbox.rs:1572-1579`) — trang memory được lazy page-in từ block device LSMT khi guest fault, không copy toàn bộ RAM. Thêm warm VMM process pool: `start_resume` lấy sẵn process Firecracker + netns từ `FirecrackerPool` (`sandbox.rs:1406-1413`).

## 2. Storage stack — LSMT tự viết + io_uring/ublk

File: `storage/overlaybd/src/lsmt/` (Rust port tự viết của overlaybd C++).

- **Key layout**: đơn vị 512B. `Segment{offset: u64, length: u32(14 bit)}` + `SegmentMapping{segment, moffset, zeroed, tag}` (`lsmt/index.rs:13-49`). On-disk bitfield nén chặt: OFFSET 50 bit / LENGTH 14 bit / MOFFSET 55 bit / zeroed 1 bit / tag 8 bit (`lsmt/format.rs:15-20`); header/trailer 390 byte, magic `0x00020100544d534c` = "LSMT" + version, flag data/index, sealed, sparse_rw, hybrid_rw (`format.rs:74-138`).
- **Index ghi (upper)**: `MutableIndex = BTreeSet<SegmentMapping>`; `insert` overwrite: xoá các mapping giao nhau, cắt phần trái/phải của mapping cũ còn dư (`index.rs:489-540`) — chuẩn interval overwrite O(log n) mỗi lần.
- **Index đọc (stack lowers)**: `ReadOnlyIndex::merge` gộp N layer, `tag = i` (0 = layer mới nhất, nhỏ hơn = mới hơn, trùng offset → tag nhỏ thắng) (`index.rs:192-206`); `lookup` binary search `partition_point` rồi cắt đầu/cuối segment theo query (`index.rs:214-243`). Có thêm `LinearizedBptree` 8 key/node, 10 mức cho index lớn (`index.rs:246-300`).
- **Compaction**: `compact_to` hai phase — gom mappings thành chunk đúng cỡ buffer writer, zero-mapping không chiếm chỗ; copy song song theo chunk, zero-detection khi ghi (`lsmt/file/helper.rs:1217+`). `commit_with_args` = lookup toàn bộ virtual size → compact_to (`lsmt/file/readwrite.rs:499-513`).
- **Group commit cho index write**: buffer pending `DiskSegmentMapping`, flush theo capacity (`readwrite.rs:515-553`) — giảm số write nhỏ vào index file. `compress_raw_index` gộp segment kề nhau cùng tag/moffset (`index.rs:110-148`).
- **io_uring**: các overlaybd file I/O đi qua `VirtualFile` + io_uring lane worker pool dùng chung cho task ngắn hạn (`storage/overlaybd/src/io/transient_io_ring.rs:11-46`).
- **Rate limit disk I/O — token bucket ở VMM, không phải host daemon**: per-sandbox virtio-blk `bandwidth_bytes_per_sec` + `iops`, mỗi bucket refill 1000ms (pin để `*_per_sec` = rate/giây thật), burst là `one_time_burst` **không được bù lại** (`sandbox.rs:59-97`, `config/default.toml:173-181`). Trick lưu ý: để xoá limit kế thừa từ snapshot khi resume, PATCH cần bucket sentinel `size==0 && refill_time==0` (bucket vắng mặt = "giữ nguyên") (`sandbox.rs:119-149`).
- **Admission gate download nền** (không phải token bucket): 2 counter in-flight toàn process (foreground remote read vs background download); background bị park khi foreground bận nhưng luôn cho 1 block nền qua (floor=1) để không đói; backoff 200ms (`storage/overlaybd/src/download_gate.rs:13-28`). Cộng thêm "hold đến khi sandbox envd-ready" (fallback 20s) để không tải trước khi cần.

## 3. Warm pool + scheduler + ballooning

**`crates/warm-pool/src/lib.rs` (608 dòng, thuần std — generic `WarmPool<T>`)**:

- Watermark Fill/Drain: `compute_maintenance_action` — dưới `fill_target` → Fill(chênh), trên `high_watermark` → Drain toàn phần dư trong 1 chu kỳ (`lib.rs:146-164`). Maintenance worker thread + Condvar (`lib.rs:337-372`).
- **Trick "ratchet"**: `fill_target` khởi đầu = low_watermark; mỗi lần acquire miss/gây áp lực thì `target = max(target, low, 1) * 2` capped high (`lib.rs:170-183`), và **không bao giờ giảm** trong đời process (`lib.rs:90-94`) — node từng thấy burst sẽ giữ warm capacity. Release cho phép vượt high khi maintenance bật (worker tự drain) (`lib.rs:272-292`).
- **FirecrackerPool** (`src/sandbox/firecracker/pool.rs`): warm resource = _process Firecracker đã spawn + API socket ready + network slot đã cấp_ (`create_warm_async`, `pool.rs:288-338`); refill theo batch concurrency, gặp lỗi thì dừng batch (`pool.rs:245-285`).
- **TTL auto-evict**: store giữ index `BTreeSet<(expires_at, id)>` (`in_memory.rs:33, 81-91`), `list_expired` (`in_memory.rs:296-310`), task chạy interval `auto_evict_interval_ms` gọi evict theo `timeout_action` (pause hoặc stop) (`service.rs:192-194, 1794-1850`). Cập nhật expires_at = deindex + reindex (`in_memory.rs:130-131, 204-206`).
- **Scheduler (Go, `services/scheduler/internal/`)**: 2 bước — filter ngưỡng cứng (max sandbox count, CPU/mem used %, CPU/mem **allocated** % cho overcommit, và các "including paused" = active + reservation của paused VM, `filter.go:14-88`) rồi strategy chọn node: `round_robin` = atomic counter mod n hoặc `random` (mặc định round_robin, `strategy.go:16-60`). Node registry xoá node theo `observedTTL` heartbeat (`node_registry.go:54-74`); metric snapshot từ heartbeat, không phải discovery mỗi request (`services/README.md:111`).
- **Memory ballooning 9.6x** (`README.md:31`): không inflate chủ động — boot VM với `virtio-balloon` chỉ bật **free page reporting** + `deflate_on_oom=true` (`instance.rs:412-423`), ghép **DAMON reclaim** trong boot args của guest để thu hồi pagecache lạnh; balloon báo host các trang guest đã free để VMM `MADV_DONTNEED` (`sandbox.rs:1750-1753`, `docs/src/configuration/reference.md:44`). Overcommit scheduler chặn bằng `max_memory_allocated_percent` (`services/README.md:126-128`).

## 4. State machine 8 trạng thái + CAS

- Enum: `Creating, Resuming, Running, Snapshotting, Forking, Pausing, Paused, Killing` (`src/orchestrator/types.rs:56-66`). Transitional = mọi state trừ Running/Paused/Killing.
- **CAS**: `update_state_if_state(id, new, expected[])` trong write lock, sai expected → `StoreError::StateConflict`, trả về previous state (`in_memory.rs:140-170`). Không phải atomic nguyên thủy mà là CAS logic trên `RwLock<HashMap>` — đủ vì store 1 process.
- Chuyển tiếp hợp lệ: Running→Pausing→Paused (`service.rs:1007`, `1144`); Paused→Resuming→Running (`service.rs:1281, 1316`); Running→Snapshotting→Running (`service.rs:1374-1377`); Running→Forking→Running (`service.rs:521, 561-565`); Running|Paused→Killing→remove (`service.rs:843-847`).
- **Race handling**:
  - Pause: CAS trượt vào `Pausing` (người khác đang pause) → `join_concurrent_pause` chờ kết quả thay vì chạy lại; `Paused` → coi như Ok; `Killing` → 404 (`service.rs:1011-1028`).
  - Delete: **vòng lặp CAS** — gặp transitional thì `wait_for_transition` rồi thử CAS lại; gặp Killing thì chờ, nếu người kia rollback thì retry CAS (tránh 2 deleter song song); nếu stop backend lỗi thì rollback metadata về `previous_state` (`service.rs:840-932`).
  - Mỗi lỗi giữa đường đều rollback state về trước đó qua CAS ngược (`update_state_if_state(..., Running, &[<transitional>])`).
- **Lock-free waiting**: mỗi sandbox 1 `tokio::sync::watch<Option<SandboxState>>`; `wait_while_in_states` subscribe rồi `watch_for(predicate)` (`in_memory.rs:323-356`). 2 trick: dùng `send_replace` thay `send` để giá trị channel luôn cập nhật kể cả khi 0 receiver (tránh watcher đến sau đọc stale) (`in_memory.rs:49-61`), và notify **sau khi** thả write lock (`in_memory.rs:134-136`). `wait_for_transition` có timeout cứng (`service.rs:1676-1688`).

## 5. Template builder (Dockerfile-like)

- Spec: `TemplateBuildSpec` + `TemplateBuildStepKind` = Run/Env/Workdir/User/ExposedPort/Volume/Label + apt() sugar (`src/template/build_spec.rs:22-79`).
- **Thuật toán build**: không có buildkit — boot 1 microVM thật (từ rootfs image hoặc từ base snapshot) bằng `TemplateBuildRunner` trên thread riêng (current-thread runtime) (`runner.rs:121-165, 189-231`), thực hiện từng step qua envd exec (`step_executor.rs:23-123`), giữ `CommandContext` (user, env, workdir — resolve tương đối, normalize `.`) như Dockerfile context, rồi `ensure_default_user`, chạy startup command, probe runtime versions, cuối cùng **commit VM thành snapshot** (layer chain = lowers của snapshot đó) và publish (`builder.rs:53-100`, `runner.rs:225-231`).
- **Cache**: không có per-step cache; tái sử dụng = build kế thừa base snapshot (`build_from_snapshot_and_publish`, `builder.rs:80`) với ràng buộc: không đổi resources, không reuse build_snapshot_id, không trộn 2 kiểu base (tests `builder.rs:402-433`). Sharing tầng layer do image cache đảm nhiệm: metadata store holds (pin theo owner namespace/key) + capacity eviction (`src/image/cache/graph.rs:75-196`).

## 6. Kỹ thuật khác đáng chú ý

- **P2P iroh artifact sharing** (`src/p2p/iroh/transport.rs`, `src/overlaybd/p2p/facade.rs`): iroh-blobs, key `agentenv:p2p:v1:*`, catalog DB nội bộ, GC gated theo interval 5 phút (`transport.rs:42-45, 749`); fetch có 3 nguồn: local / peer remote / origin fallback (`transport.rs:407, 449-489`); hỗ trợ **byte-range fetch** cho đọc từng phần layer (`transport.rs:557`). HTTP facade phía trước P2P: descriptor cache TTL 5 phút, miss-cache TTL 5s, tối đa 16k entry (`facade.rs:30-34`); layer snapshot publish content-addressed theo sha256 hoặc UUID sealed layer (`src/snapshot/p2p.rs:57-73`).
- **Node-local artifact cache** (`src/snapshot/artifact_cache.rs`): 10GB mặc định, LRU theo `last_accessed`, evict về target 80% dung lượng, **pin bằng refcount** (`CacheHandle::drop` → release, `artifact_cache.rs:23-44`), dedupe fetch đồng thời qua `watch` channel in-flight (`artifact_cache.rs:75-84`) — N caller chờ 1 lần materialize.
- **Retry/backoff**: regctl image copy exponential backoff ×2 mỗi lần, chỉ retry khi lỗi "layer chưa ready" hoặc 5xx; 4xx không tiêu budget retry (`src/image/oci_image.rs:544-547, 786-818`).
- **Health check**: envd readiness = probe `GET /health` với per-probe timeout + deadline tổng (`src/sandbox/envd.rs:72-104`); sau ready mới thả background download đang hold (`sandbox.rs:590-603`).
- **Disk quota**: không có quota filesystem; thay bằng rate limiter token bucket (mục 2) + cache eviction theo capacity.

## 7. Ghi chú portability sang Windows (crates/sandbox của Ghita)

**Port được trực tiếp (cross-platform)**:

- State machine 8 trạng thái + CAS theo expected-states + rollback + `tokio::sync::watch` wait (`src/orchestrator/store/in_memory.rs` thuần tokio, không syscall lạ).
- `WarmPool<T>` watermark + ratchet ×2 (`crates/warm-pool`) — thuần std::sync, copy y nguyên được.
- LRU artifact cache refcount-pinned + in-flight dedupe (`src/snapshot/artifact_cache.rs`) — logic thu Rust thuần.
- Template builder workflow (boot sandbox → chạy step script → commit snapshot workspace) — chỉ đổi executor phía dưới.
- P2P iroh (Rust, chạy Windows được) cho artifact sharing.
- Rate limit ý tưởng token bucket: trên Windows map vào **Job Objects** (`JOB_OBJECT_IO_RATE_CONTROL` cho IO rate per-process) thay vì Firecracker drive limiter.

**Chỉ học ý tưởng (Linux-only)**:

- ublk + io_uring + LSMT block layers: Windows thay bằng overlay-dir copy-on-write cấp file (hoặc VHD differencing) — giữ nguyên thuật toán index overwrite + merge theo tag để làm "layer index" cho overlay-dir.
- `ProcessVmReader` (process_vm_readv) đọc dirty memory trực tiếp của VMM: Windows không có tương đương sạch; thay bằng self-managed snapshot khi pause (dump vùng nhớ) hoặc external assistance.
- Restack "seal upper" dựa trên rename/atomic + hardlink cùng filesystem (`overlaybd_snapshot.rs:136-194` `link_or_copy`): trên NTFS có thể thay bằng `ReFS block cloning` (nếu có) hoặc copy + rename nguyên tử; mất hardlink giữa runtime và snapshot → tốn I/O copy.
- Free page reporting + DAMON, netns/tap, cgroup quota: Windows thay bằng Job Objects memory limits + thư mục làm việc riêng; ý tưởng "reported free pages giảm host memory" không port được — chỉ giữ ý tưởng overcommit accounting (allocated vs used, including-paused) trong scheduler filter.
- Shared mem device (1 ublk cho N fork): Windows analog = memory-mapped file read-only chia sẻ giữa các sandbox clone, hoặc một VHD differencing chung cha.
