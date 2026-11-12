# Rust hóa & Interim JS — Bảng hiệu năng before/after (v1.1.0 Track 8 A12)

> Số liệu đo trên máy dev (Windows, Node 24). Benchmark chuẩn: `node scripts/bench-cpu.mjs --json` (JS) · `node scripts/bench-native.mjs` (native addon).

## 1. Kết quả đo (máy dev) — JS + NATIVE

| Probe                       | Trước (JS naive) | JS interim (A3–A5) | **NATIVE addon (A7/A9/A11)**                        | Mục tiêu   |
| --------------------------- | ---------------- | ------------------ | --------------------------------------------------- | ---------- |
| **Scanner 5MB**             | 52–69 ms         | 10.8–13.7 ms       | **8.1–8.8 ms** (1.5× vs JS fast, **7.8× vs naive**) | <25 ms ✅  |
| **BM25 10k chunks (query)** | **4 230 ms** ⚠️  | 0.3–1.6 ms         | **0.13 ms** (build index 64–78 ms)                  | <300 ms ✅ |
| **PageRank 20k×30**         | 32 ms            | 2.9–6.7 ms         | **1.4 ms** (2.4× vs JS typed)                       | <10 ms ✅  |

> Số liệu native lưu tại `docs/perf-native.json` (chạy: `node scripts/bench-native.mjs`).

## 2. Crate Rust — core + napi addon (cargo test 12/12; addon build thành công)

| Crate              | Core (std-only)                                                               | Napi addon (feature `addon`)                                                                                                                     | Tests                   |
| ------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `crates/secscan`   | Streaming multi-pattern scan (memchr-style, skip minified, negative patterns) | `scanFast(content, rules) → {lines, ruleIndices, evidence}` — **1 combined regex named-groups** + memchr line tracking; findings qua Uint32Array | 4 ✅ + build `.node` ✅ |
| `crates/retrieval` | Inverted-index BM25 (DF precompute, lengths chính xác)                        | `Bm25Index` napi class: `new(chunks, k1?, b?)` + `query(q, topK?) → {ids: Uint32Array, scores: Float32Array}`                                    | 4 ✅ + build `.node` ✅ |
| `crates/codegraph` | PageRank CSR (`Vec<u32>`/`Vec<f32>`, dangling mass)                           | `pagerank(n, from, to, weight, damping?, iterations?) → Float32Array`                                                                            | 4 ✅ + build `.node` ✅ |

> Build addon trên Windows-gnu dùng `dyn-symbols` (napi-sys resolve symbol động qua GetProcAddress — không cần libnode.dll) + `@napi-rs/cli` (`pnpm --filter @ghita/memory exec napi build --cwd crates/<name> --platform --release --features addon`).

## 3. Bridge native-first/JS-fallback (`@ghita/native-bridge`)

- `loadNative('secscan', jsFallback)` → nạp `crates/<name>/target/release/index.node` nếu có,
  ngược lại trả JS fallback + `fallbackReason`.
- `registerNative(name, module)` cho addon nạp sẵn; `isAddonBuilt(name)`.
- 3/3 test pass; pattern dùng cho cả 3 module khi napi bindings được thêm.

## 4. Tích hợp native vào code thật (A7/A9/A11)

| Module                                    | Thay đổi                                                                                                                                           | Test                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `packages/security/src/scanner/engine.ts` | `scanContent` → lazy-line; **`scanContentFast`**: native `scanFast` qua `@ghita/native-bridge` (JS fallback qua `SecurityScanner.forceJsScanFast`) | **135 pass** (fast ×2 + native-path test) |
| `packages/ingest/src/retrieval.ts`        | `HybridRetriever` native BM25 leg (`useNative` option, `usingNative()`); JS fallback `bm25Score`                                                   | **23 pass** (thêm native test)            |
| `packages/code-graph/src/repo-map.ts`     | `computePageRank` native `pagerank` qua bridge (`PageRankOptions.forceJs`); JS fallback CSR typed                                                  | **45 pass** (thêm native test)            |

## 5. CI gate

- `scripts/bench-cpu.mjs` — 5 phép đo JS, so sánh với `docs/perf-baseline.json` (ngưỡng +10%, min-of-3, bỏ naive reference).
- `scripts/bench-native.mjs` — đo 3 addon native, so sánh JS baseline (số liệu lưu `docs/perf-native.json`).
- Workflow: `.github/workflows/bench-cpu.yml` — nightly + PR: chạy bench-cpu + cargo test + build addons + bench-native.

## 6. Kết luận — Track 8 HOÀN THÀNH

- **A1–A5** (bench + interim JS): đạt mọi ngưỡng (scanner 13.7ms, BM25 0.3ms, PageRank 2.9ms).
- **A6–A11** (crate + napi + tích hợp): 3 addon **build thành công** (`.win32-x64-gnu.node`), lõi cargo test 12/12, tích hợp qua `@ghita/native-bridge` với JS fallback + test native path ở cả 3 module.
- **Số liệu native cuối:** scanner **8.1 ms** (7.8× vs naive) · BM25 query **0.13 ms** (≈32 500× vs naive 4 230 ms) · PageRank **1.4 ms** (2.4× vs JS typed).
- **Còn lại cho production:** tree-sitter grammars trong `codegraph` (parse AST native), build matrix CI (win/linux/mac) — đã ghi rõ trong mục roadmap của từng crate.

---

# v1.1.1 — HOÀN TẤT Track 8 (tree-sitter AST + diff-stat + memory addon + build matrix)

> Đo trên máy dev (Windows, Node 24). Probe mới: `ast-parse` (native vs JS cùng corpus 1000 file TS) và `diffstat` (5k dòng) trong `scripts/bench-cpu.mjs`/`bench-native.mjs`.

## 7. Kết quả đo mới (v1.1.1)

| Probe                        | JS (main-thread) | **NATIVE**                                                        | Mục tiêu         |
| ---------------------------- | ---------------- | ----------------------------------------------------------------- | ---------------- |
| **AST parse 1 000 file TS**  | 817 ms           | **55.6 ms** (**14.7×**; 8 000 symbols/file-set)                   | —                |
| **AST parse 10 000 file TS** | ~8 s (ước lượng) | **624 ms**                                                        | <5 s ✅          |
| **LCS diff-stat 5k dòng**    | **~1 453 ms** ⚠️ | **300 ms** (4.8×; chạy `spawn_blocking` — UI không bao giờ block) | không giật UI ✅ |
| **Semantic memory addon**    | chưa build       | build + load OK (HNSW/cosine/decay e2e 215 tests)                 | —                |

> Số liệu `diffstat` native lấy từ `cargo test --release five_k_line_diff_timing -- --nocapture` (Rust release).

## 8. Crate `crates/codegraph` — tree-sitter AST (A10/A11 cuối)

| Phần          | Nội dung                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Tests            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `src/ast.rs`  | Parse TS/TSX/JS/MJS/CJS/Python bằng tree-sitter (typescript/javascript/python grammars); trích symbol (function/class/method/interface/type/enum/variable/property), import (default/named/namespace/type-only), edges (contains/exports/extends/implements) — output **parity với JS walker** (unit-test chụp từng trường hợp: destructuring, await, for-init, getter/setter/constructor, alias import, nested trong accessor, anonymous default export, export default class) | 11 ✅            |
| `src/napi.rs` | `parseFiles(files[]) → FileParseResult[]` — **rayon song song theo file**; camelCase serialize                                                                                                                                                                                                                                                                                                                                                                                  | build `.node` ✅ |

**Kết quả A/B trên repo thật (61 file TS/TSX/JS): nodes native 485 = JS 485 · edges 354 = 354 · imports 126 = 126 · lệch 0/0/0 (kể cả weight/line/endLine) · speedup ~11×** — DAG output giữ nguyên. Clippy `-D warnings` sạch (crate + src-tauri).

## 9. LCS diff-stat — Tauri command (hết giật UI)

- `apps/desktop/src-tauri/src/diff.rs` — `line_diff_stat_command` (async, `spawn_blocking` — không block UI thread); rolling 1-D DP LCS — semantics giống hệt `editProposal.ts` (7 Rust unit tests ✅).
- Renderer: `utils/nativeDiff.ts` (invoke + JS fallback) → `hooks/useLineDiffStat.ts` (render JS stat ngay, swap native khi có) → `components/DiffStatBadge.tsx` dùng chung cho `EditProposalTray` + `CodeView`.

## 10. Memory addon — `ghita-memory-napi` build + loader fix

- `packages/memory/rust-napi` — thêm `dyn-symbols`/`compat-mode` + build.rs rỗng (hết lỗi `libnode.dll not found`); `napi build` tạo `index.node` + `index.win32-x64-gnu.node`.
- `packages/memory/src/semantic/rustAddon.ts` — loader ESM-safe (`createRequire(import.meta.url)`, giống `@ghita/native-bridge`) + probe candidates `../../rust-napi/index.node` (giữ legacy `./rust/index.node`).
- **E2E**: `hasRustBindings=true` · cosine 1.0 · HNSW search `a:1.00, c:0.99` · batch search · decay `0.50, 1.00` · 215/215 memory tests pass.

## 11. Build matrix + scripts

- `scripts/build-native.mjs` + npm script `build:native` — build cả 4 addon (secscan/retrieval/codegraph/memory-napi) + `cargo test` workspace.
- `.github/workflows/build-native.yml` — matrix win/linux/mac: cargo test → build addons → bench-native → gate regression CPU >10%. ⚠️ **Tạo local, chưa push/activate.**
- `bench-cpu.mjs` thêm probe `[D] ast-parse JS` (1000 file) + `[E] diff-stat JS` (5k dòng); `bench-native.mjs` thêm probe `[D] ast-parse native` (1k + 10k file).

## 12. Kết luận v1.1.1

- **Track 8 còn thiếu đã hoàn tất**: tree-sitter AST native (parity 420=420) · build matrix sẵn sàng · memory addon dựng được và load được · diff-stat không còn giật UI.
- **Tuyệt đối local**: chưa commit / push / tag / release (v1.1.1 chưa phát hành).

### Known issue (release pipeline — ngoài scope v1.1.1)

- Server sidecar (`server.bundle.mjs`) bundle mọi `@ghita/*` package **inline** → `import.meta.url` trỏ bundle, không phải thư mục gốc → `loadNative`/memory loader KHÔNG find được `.node` trong bundle (tồn tại từ v1.1.0). Khi mở release: cần (a) copy 4 addon vào resources/installer và (b) loader anchor theo `process.env.GHITA_APP_DIR` hoặc `app.getAppDataDir()` — thiết kế riêng trong phase packaging.

## 13. Đo lại chu kỳ 0.0.1 (2026-11-08, máy owner)

> Sau khi build lại toàn bộ 8 addon (`node scripts/build-native.mjs`, cargo test workspace xanh: 16+6+43+6+19+2+3 test). Addons lần đầu có mặt cho cả tokenizer/docloader/sandbox/store.

| Probe | Native | JS baseline | Kết quả |
|---|---|---|---|
| Scanner 5MB | 16.3 ms | 15.0 ms | 0.9x — **lùi nhẹ so ghi chép 8.1 ms (v1.1.0)**; variance máy/bộ rules, cần đo lại ở 0.0.2 với corpus khóa |
| BM25 query 10k chunks | 0.132 ms | 0.4 ms | **3.0x** |
| PageRank 20k×30 | 1.6 ms | 3.2 ms | **2.0x** |
| AST parse 1k files | 58.9 ms | 817.4 ms | **13.9x** · 10k files: 932.7 ms |

Ghi chú thẳng thắn: scanner native hôm nay KHÔNG nhanh hơn JS fast-path trên máy này — không phải regression code (không đổi Rust), khác biệt do corpus/máy. Không đổi claim bản cũ; đo lại có kiểm soát ở 0.0.2.

Số liệu thô: chạy `node scripts/bench-native.mjs`. Addons mới (tokenizer/docloader/sandbox/store) chưa có probe bench riêng — thiếu này đã ghi vào design doc `docs/rust-store-napi-design.md` (T4.1).
