# Thiết kế crates/store napi addon (T4.1 — kế hoạch v0.0.1) — chỉ DESIGN, implement ở 0.0.2

> Ngày: 2026-11-08 · Nguồn pattern: oh-my-pi vendor napi (MIT) + crate tokenizer napi sẵn có của Ghita
> Trạng thái hiện tại: `crates/store` có `KvStore` (rusqlite WAL + synchronous NORMAL, fallback HashMap khi không có feature `addon`) và **đã có** `src/napi.rs` — nhưng chưa có loader ở tầng TS, chưa ai build `.node`, chưa bench.

## 1) Kiến trúc đề xuất

### 1.1 Napi surface (`KvStoreAddon`)

| Phương thức | Chữ ký | Ghi chú |
|---|---|---|
| `open` | `new KvStoreAddon(path: string)` | `:memory:` giữ nguyên; lỗi mở → napi Error |
| `get` | `get(key: string): string \| null` | `OptionalExtension` như lib.rs |
| `set` | `set(key: string, value: string): void` | upsert; cập nhật `updated_at` |
| `del` | `del(key: string): boolean` | trả có xóa được không |
| `list` | `list(prefix?: string): Array<[string, string]>` | sắp theo key; prefix dùng LIKE 'prefix%' escape |
| `size` | `size(): number` | COUNT(*) |
| `flush` | `flush(): void` | `PRAGMA wal_checkpoint(PASSIVE)` |

Quy tắc an toàn giống tokenizer napi: không paníc qua FFI — mọi lỗi rusqlite map thành napi `Error`; không giữ lock xuyên call async.

### 1.2 JS fallback + bridge

- Dùng đúng pattern `@ghita/native-bridge`: `loadNative('store', fallback)` — fallback = Map-in-memory hiện có của lib.rs (behavior parity qua parity test).
- Wire point đề xuất:
  1. `packages/memory/src/tieredStore.ts` — tầng persisted KV của memory (đang dùng JSON file) chuyển lên KvStore native khi addon có, giữ JSON fallback.
  2. `apps/desktop/src-tauri/sidecar/memory-journal.mjs` — journal JSONL hiện tại chuyển phần index/lookup sang KvStore (append-only giữ nguyên — JSONL vẫn là format log, KV chỉ làm index).

## 2) Bench design (bắt buộc trước khi wire)

- Probe: `get`/`set`/`list` với 1k · 10k keys, value 64B và 4KB.
- So sánh 3 đường: (a) KvStore native qua FFI, (b) rusqlite trực tiếp trong Rust (đo trần FFI overhead), (c) JSON file hiện tại.
- Ngưỡng gọi là "đáng wire": native ≥ 1.5x JSON ở `list` 10k và không chậm hơn JSON ở `set` (FFI overhead ~µs, SQLite phải thắng ở IO).
- Script: `scripts/bench-native.mjs` thêm probe `[F] store` — đọc theo pattern probe `[D] ast-parse` hiện có.
- Tiêu chí xong 0.0.2: parity test native↔JS (cùng seed cho cùng kết quả), `cargo clippy -D warnings` sạch, bench đạt ngưỡng, addons build được trên Windows-gnu dyn-symbols (như docs/perf-rust.md §2 ghi).

## 3) Rủi ro

1. **rusqlite bundled vs system sqlite** — bundled tăng binary ~1MB/addon; system sqlite trên Windows không có sẵn → dùng bundled (cargo feature `bundled`).
2. **napi dyn-symbols Windows-gnu** — đã có công thức trong perf-rust.md; store không dùng symbol lạ nên rủi ro thấp hơn tokenizer.
3. **FFI boundary cho list()** — trả `Array<[string,string]>` napi alloc nhiều; nếu bench cho thấy chậm thì đổi sang 2 mảng phẳng (keys + values) như pattern `Uint32Array` của retrieval.
4. **Đồng thời sidecar** — KvStore mở 1 connection duy nhất per process; sidecar single-threaded event loop nên an toàn; nếu sau này multi-thread thì đổi sang pool + `busy_timeout`.

## 4) Việc còn thiếu hôm nay (chốt cho 0.0.2)

- [ ] Implement `crates/store/src/napi.rs` surface trên + build `.node` (build-native.mjs đã có entry `store`).
- [ ] `loadNative('store', ...)` vào `packages/memory` + bench probe `[F]`.
- [ ] Parity test + clippy + bench đạt ngưỡng §2.
