# v1.2.0-demo1 — Rust hóa: thiết kế & đổi ứng viên (P3.1)

## Quyết định đổi ứng viên (quyền P3.1 trong master plan — có lý do + số đo)

Master plan demo1 dự kiến port **PageRank ranker** + **textops-diff**. Khảo sát + profiling (docs/research/profiling-1.2.0-demo1.md) phủ cả hai:

| Ứng viên cũ                                    | Phế truất vì                                                                                                                                                                                                                                      | Bằng chứng                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `packages/shared/src/parser/pageRankRanker.ts` | **Dead code production** — chỉ được export qua barrel `node.ts` + test; production code-graph dùng `crates/codegraph` native pagerank (repo-map.ts:83)                                                                                            | grep toàn repo: 0 caller ngoài test |
| `crates/textops` splitCode/splitRecursive      | JS đã **<1ms** (0.3–0.4ms/8k dòng) — port không mang lại gì                                                                                                                                                                                       | bench-demo1.mts                     |
| splitFixed/splitMarkdown native                | JS string-slice là view O(1); native phải copy+transcode qua FFI → **chậm hơn JS** (3.2ms vs 0.3ms trên 228k ký tự). Giữ wiring native đã có vì parity ĐÃ được chứng minh + absolute cost không đáng kể ở cỡ tài liệu thực tế; không mở rộng thêm | bench-demo1-split.mts               |

## Ứng viên mới (đo được, production, Rust thắng thật)

### Module 1 — splitter core (ĐÃ HOÀN THÀNH trong Track 1 như bug fix)

`crates/retrieval/src/splitters.rs`: split_fixed + split_markdown viết lại đúng semantics JS (UTF-16 units, clamp overlap, char-boundary an toàn, ASCII fast path, streaming không Vec<char> toàn input). 24/24 Rust test + parity JS↔Rust 20/20.

### Module 2 — `shared_counts` (scoreAll core) → `crates/retrieval`

**Vấn đề:** `MemoryCompactor.scoreAll` đếm pairwise token-shared giữa mọi cặp entry (điều kiện `shared/size > 0.3`). JS đã tối ưu 522→22ms (bitset/inverted adaptive, P2.2) — Rust làm tiếp phần compute thuần này ~3-5ms.

**Interface napi:**

```rust
#[napi]
pub fn shared_counts(tokens: Vec<Vec<u32>>, group: Vec<u32>) -> Vec<u32>
```

- `tokens[i]` = token-set của entry i đã map sang vocab id (u32), đã sort.
- `group[i]` = index của entry đầu tiên có cùng `id` (JS dựng) — Rust skip cặp có `group[j] == group[i]` (parity với `other.id === entry.id` của code gốc).
- Trả `sharedCounts[i]` = #{j: group khác && shared(i,j)/size(i) > 0.3}.
- **Float parity:** so sánh bằng `shared as f64 / size as f64 > 0.3` (IEEE đúng như JS) — KHÔNG dùng nhân chéo số nguyên (khác nhau ở boundary do làm tròn).
- Chiến lược adaptive trong Rust giống JS: `bitCost = N²·words` vs `invCost = Σ_t postings²`, chọn cái nhỏ hơn.

**Wire:** `packages/memory/src/semantic/compact.ts` scoreAll — tokenize + vocab map + group ở JS; phần đếm shared gọi `getNativeSharedCounts()?.(tokens, group) ?? jsSharedCounts(...)`. JS fallback giữ nguyên code P2.2.

**Parity test:** `compact-scoreall-golden.test.ts` (đã có, oracle pairwise) chạy cả 2 nhánh native/JS; thêm case vào `packages/memory/src/semantic/compact-shared-counts.test.ts` so trực tiếp native vs JS trên fixture dense+sparse.

**Bench:** `examples/bench-demo1.mts` scoreAll trước/sau native.

## Tiêu chí xong

1. `cargo test -p ghita-retrieval` xanh (thêm unit Rust cho shared_counts: dense, sparse, duplicate-group, empty tokens, threshold boundary).
2. `cargo clippy -p ghita-retrieval --features addon -D warnings` = 0; `cargo fmt --check` sạch.
3. Parity test JS↔Rust xanh trên máy có addon; golden scoreAll vẫn pass cả 2 nhánh.
4. Bench: scoreAll.1k native < JS (báo cáo số).
5. Gates chung xanh.
