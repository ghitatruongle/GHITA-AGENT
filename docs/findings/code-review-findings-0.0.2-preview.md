# Code review findings — v0.0.2-preview (T1–T6)

> Review + debug toàn bộ code chu kỳ v0.0.2-preview, 15/11/2026 (owner goal:
> "Review all code with debug all code"). Scope = mọi file mới/đã sửa trên
> working tree của chu kỳ. Mọi fix ĐÃ chạy lại tests xanh. KHÔNG commit —
> working tree chờ owner.

## Kết luận tổng

- **6 bug thật tìm thấy, 6/6 đã sửa** (F1–F6 logic, F8–F9
  accounting/timeout; số F7 = stale index). 1 artifact comment sót đã dọn.
- Sau fix: cargo patch tests **27/27**, memory **274/274**, ai-engine
  **948/948**, native-bridge 10/10, typecheck 0 · lint 0 · fmt OK ·
  clippy patch addon 0.
- Không phát hiện lỗi bảo mật mới; audit-security giữ TOTAL=43 ≤ baseline 44.

## Bugs tìm thấy & đã sửa

**F1 (medium) — patch wrapper: so khớp path lệch chuẩn.** `delta.changes()`
trả path tuyệt đối theo chuẩn PathUri, `intended` từ patch text là relative —
strip_prefix hỏng (casing Windows) → file bị đếm VỪA applied VỪA skipped →
partial sai. Fix: `norm_path()` (forward slashes + lowercase) cho cả hai phía.
Vị trí: `crates/patch/src/lib.rs` (`norm_path`, `collect`).

**F4 (medium) — patch wrapper: rename `*** Move to:` bị đếm skipped oan.**
Delta upstream báo OLD path cho rename; intended chỉ có old path → applied
được ghi theo new path (đúng thực tế) nhưng old path rơi vào skipped →
partial=true sai. Fix: trong `collect()`, change `Update { move_path: Some }`
→ push NEW path vào applied + old path vào satisfied-set. Test mới khóa hành
vi: `rename_via_move_to_counts_as_applied` (27 tests giờ).

**F6 (medium) — vec0 index: dim hardcode 1536 vs vector lệch chiều.**
`vecstore.ts` hardcode `vecEnsureSchema(1536)`; `SessionRecord.vector` có thể
dài bất kỳ → INSERT sai dim lỗi vec0 bị nuốt im lặng → durable index "chết
ngầm". Fix: dim theo env `GHITA_MEMORY_VEC_DIM` (default 1536, khớp
text-embedding-3-small) + `indexSession` chỉ index vector đúng dim.
Vị trí: `vecstore.ts` (`getVecDim`), `search.ts` (guard dim).

**F7 (medium) — durable index để lại phantom hits.** Session bị evict
(`removeSession`) không xóa entry vec0 → search native trả hit của session
không còn tồn tại. Fix: `removeSession` gọi `vecDelete` best-effort.

**F8 (high) — gateway native fast-path bỏ qua ghi sổ.** Path `GHITA_ENGINE=
native` trước đây trả thẳng response mà không ghi cost/audit/tokens — khác
chuẩn với TS path (quota leak). Fix: `tryNativeCompletion` trả về đủ
`{text, provider, model, usageIn, usageOut}` (parse JSON response của addon);
gateway tính `estimateCost` + cộng `accumulatedCost`/metrics + `logAudit` như
TS path. Test mới khóa: usage parsing (ai-engine 948 tests).

**F9 (medium) — native Promise có thể treo vĩnh viễn.** `engineComplete`
không có timeout → provider chết = HTTP request gateway treo. Fix:
`Promise.race` timeout **120s** trong `tryNativeCompletion` (null → fallback
TS provider như thường).

## Dọn dẹp kèm review

- Artifact comment sót trong `packages/memory/src/hybrid-native.ts` ("ghita...").
- 1 unused import sau fix F6 (`getVecDim` value-import).

## Đã review, không cần sửa (ghi nhận)

- `crates/patch/src/upstream/**` — vendored upstream (26+1 tests tự phủ);
  các cut exec-server/invocation đã được test suite thật phủ qua wrapper.
- `crates/sandbox/src/windows.rs` — v1 `available()=false` có chủ đích
  (3 blocker upstream ghi trong doc comment; backlog R2).
- `scripts/build-native.mjs` disk-guard — logic get-PSDrive/df đã test tay.
- Sidecar `apply_patch` tool — flag + fallback lịch sự, realpathSync có
  try/catch.

## Known limitations (không phải bug, đã ghi docs)

- napi CLI 3.10.9 máy này tạo `.d.ts` rỗng → typings viết tay (patch/store).
- napi addon build profile **debug** (release gãy syn3 "metadata stub" —
  môi trường, không phải code).
- e2e-local với API key owner chưa chạy (unit/integration đã phủ fallback).
