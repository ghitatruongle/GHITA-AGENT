# Hybrid search (v0.0.2-preview T4)

**Kiến trúc:** `CrossSessionSearch` (packages/memory) kết hợp keyword BM25-like
(weights 0.6/0.4) + semantic vector. Nguồn vector theo thứ tự ưu tiên:

1. **Durable vec0 index (native, mới):** ghita-store addon nạp sqlite-vec 0.1.9
   (rusqlite bundled, registration `sqlite3_auto_extension` trước khi mở
   connection). `indexSession` upsert vector session vào `memories_vec` +
   `memories_doc`; search ưu tiên `vecSearch` (KNN, score = 1/(1+distance)).
   DB path = `GHITA_MEMORY_VEC_DB` (mặc định `:memory:` = per-process).
2. **JS cosine fallback:** addon vắng → cosine trên `SessionRecord.vector`
   (luồng cũ, giữ nguyên).

**Embedding source (P4.4b):** `GHITA_MEMORY_EMBEDDINGS=off` mặc định → không
gọi API ngoài; `openai` (+ OPENAI_API_KEY) → text-embedding-3-small (1536 dims,
khớp schema vec0 mặc định) qua `packages/memory/src/embeddings.ts`.

**Tests:** 6 Rust tests vec0 (roundtrip/KNN ranking/upsert/delete) + 271 memory
TS tests xanh. e2e-local với API key owner: chờ chạy manual (mục E2E results
trong plan).
