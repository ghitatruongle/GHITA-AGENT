# Track S4 — Computer-use gap + mục phụ (TS + Rust nhỏ)

> **Mục tiêu:** fix gap thật đã phát hiện + ghép pattern nhỏ từ nut-js/open-agent. Nguồn: `deep-dive/nut-js/02-*.md`, nền `_research-3-desktop-terminal.md`. Độc lập, mức nhỏ.

## Nền đã kiểm chứng (facts)

- **Gap thật (bug tiềm năng):** sidecar Node không bao giờ có `globalThis.__TAURI__` → adapter computer-use trong sidecar luôn rơi fallback rỗng (`server.mjs:1149`) — mouse/keyboard/screenshot từ agent path hiện KHÔNG hoạt động qua sidecar.
- computer-use: mouse/keyboard/screenshot toàn bộ native Rust (enigo + screenshots, `computer_use.rs`); JS chỉ là TauriOperator + ReAct + UI-TARS parser/grounding + 10 test files.
- open-agent có Rust doc_loader (tree-sitter, Markdown/TokenSplitter, Chunk{index,content}) — crates/docloader của Ghita có thể đối chiếu thiết kế (mức tham khảo).

## Thiết kế

1. **Fix sidecar gap** (ưu tiên): computer-use qua sidecar cần đường mới — chọn: (a) sidecar gọi qua Tauri IPC bridge (nếu sidecar chạy như sidecar của app), hoặc (b) tách logic computer-use thành napi addon gọi native trực tiếp. Verify kiến trúc sidecar tại P1 trước khi chọn.
2. **Port nut-js patterns** vào packages/computer-use: validateSearchRegion (âm/NaN/<2px/vượt màn hình), waitFor AbortSignal + lastRejectionReason, window clamp tràn màn hình/maximized, MatchRequest generic {haystack, needle, confidence, providerData}.
3. **Phụ (optional, theo nhu cầu):** hashcash PoW SHA3-256 cho local API bridge (packages/security, mẫu open-agent hashcash.rs:36-52); đối chiếu thiết kế chunk crates/docloader ↔ open-agent doc_loader.

## Files

- Verify + Modify: `apps/desktop/server.mjs` (computer-use bridge), `packages/computer-use` (validate/clamp/abort patterns), optional `packages/security` (PoW), `crates/docloader` (đối chiếu — không bắt buộc sửa).
- Tests mới: validateSearchRegion unit, window clamp unit, sidecar bridge e2e.

## Phases & Gates

- **P1** Verify kiến trúc sidecar + chọn phương án bridge (báo owner trước khi code).
- **P2** Fix sidecar gap + e2e computer-use từ agent path.
- **P3** Port nut-js patterns + unit tests.
- **Gates:** turbo test computer-use; e2e smoke: agent điều khiển chuột qua sidecar thành công.

## Phụ lục — nguồn liên quan

- Nền đã kiểm chứng: `_research-3-desktop-terminal.md` (desktop terminal + computer-use hiện trạng)
- Kiến thức deep-dive: `../deep-dive/nut-js/`, `../deep-dive/open-agent/`
- Tổng hợp kiến trúc: `../2026-11-22-tong-hop-kien-truc-6-du-an.md` (mục A4, A6, A8)
