# GHITA_* feature flags (v0.0.2-preview)

| Flag | Mặc định | Giá trị | Ý nghĩa | Rollback |
|---|---|---|---|---|
| `GHITA_PATCH` | `native` | `native` \| `legacy` | Bật tool MCP `apply_patch` (engine V4A vendored từ codex). `legacy` tắt tool, agent dùng luồng write toàn phần | Đặt `legacy` |
| `GHITA_SANDBOX` | (supervised) | `restricted-token` opt-in | v1: sandbox Windows giữ supervised (Job Object containment); restricted-token cần provisioning codex — backlog R2 | Không đặt |
| `GHITA_ENGINE` | (tắt) | `native` | Opt-in lớp model Rust (rig-core) qua gateway fast-path; null/throw → TS providers hiện có | Không đặt |
| `GHITA_MEMORY_EMBEDDINGS` | `off` | `off` \| `openai` | Embedding source cho durable vec0 index; off = keyword + JS cosine, không gọi API ngoài | `off` |
| `GHITA_MEMORY_VEC_DB` | `:memory:` | đường dẫn file SQLite | Đường dẫn durable vector index (sqlite-vec); không đặt = in-memory per-process | Không đặt |
| `GHITA_ENGINE_E2E` | (tắt) | `1` | Bật e2e test thật của rig adapter (cần API key, KHÔNG chạy CI) | Không đặt |

Mọi tính năng native đều có JS fallback: addon vắng/throw → luồng hiện có, không chết tính năng.
