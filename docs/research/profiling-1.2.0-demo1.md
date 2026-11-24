# v1.2.0-demo1 — Profiling (P2.1)

Ngày đo: 2026-08-31. Máy: Windows x64 (owner dev machine, toolchain windows-gnu).
Lệnh: `node scripts/bench-cpu.mjs`, `node scripts/bench-native.mjs`, `node scripts/bench-startup.mjs`, `pnpm tsx examples/bench-demo1.mts`.

## Baseline (bench-cpu, JS probes)

| Probe               | Đo hôm nay | docs/perf-baseline.json | Ghi chú                                                 |
| ------------------- | ---------- | ----------------------- | ------------------------------------------------------- |
| scanner.naive.ms    | 111.7      | 66.7                    | variance máy                                            |
| scanner.stream.ms   | 112.0      | 98.5                    | production dùng fast path                               |
| scanner.fast.ms     | 21.3       | 15.0                    | trong dải CI 15–23 (continue-on-error)                  |
| bm25.index+query.ms | 0.3        | 0.385                   | OK                                                      |
| pagerank.typed.ms   | 4.7        | 3.2                     | OK (native 3.1)                                         |
| ast-parse.js.ms     | 845.7      | 817.4                   | chỉ là fallback khi thiếu addon — native 114.7ms (7.1x) |
| diffstat.js.ms      | **1810.8** | 1452.9                  | 🔴 ĐIỂM NÓNG #1                                         |

## Micro-bench (examples/bench-demo1.mts, min-of-3)

| Vùng                                | Đo            | Kết luận                                                                  |
| ----------------------------------- | ------------- | ------------------------------------------------------------------------- |
| memory.scoreAll.1k                  | **522.7 ms**  | 🔴 ĐIỂM NÓNG #2 — O(n²) pairwise set-intersection; scale 5k entries ≈ 13s |
| memory.dedup.1k                     | 7.0 ms        | OK                                                                        |
| ingest.splitCode.8k-lines           | 0.6 ms        | OK (Track 3 port vì consistency BUG-002, không phải perf)                 |
| ingest.splitRecursive.2k-paras      | 0.9 ms        | OK (như trên)                                                             |
| diffstat.realistic.5k (1% dòng đổi) | **1120.6 ms** | 🔴 #1 — DP đầy đủ dù chỉ 1% thay đổi                                      |
| diffstat.worst.5k (đảo ngược)       | **1698.9 ms** | 🔴 #1                                                                     |

## Native benches (đã có)

- ast-parse native: 114.7ms/1000 files = **7.1x** JS.
- pagerank native: 3.1ms ≈ JS typed (1.1x).
- bm25 native query: 0.26ms.
- scanner native: 24.1ms (dải variance; JS same-machine 21.3).

## Xếp hạng điểm nóng → target tối ưu (P2.2)

| Hạng | Vùng      | Hàm                                                                | Trước                              | Target                                      | Cách                                                                 |
| ---- | --------- | ------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| 1    | diff-stat | `lcsLength` apps/desktop/src/utils/editProposal.ts                 | 1120–1700ms                        | ≥80%                                        | common prefix/suffix trim + Hunt–Szymanski LIS                       |
| 2    | memory    | `MemoryCompactor.scoreAll` packages/memory/src/semantic/compact.ts | 522ms                              | ≥20%                                        | adaptive: bitset (vocab nhỏ) / inverted-index accumulate (vocab lớn) |
| 3    | ingest    | `splitFixed/splitMarkdown` native path trên phi-ASCII              | native panic→JS fallback (BUG-001) | đã fix ở Track 1 — native giờ chạy được CJK | verify bằng bench CJK JS vs native                                   |

Không tối ưu: ast-parse JS (fallback-only, native đã 7.1x), scanner (variance CI), splitter JS (dưới 1ms).
