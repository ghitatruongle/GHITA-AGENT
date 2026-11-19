# VENDOR.md — ghita-patch

Nguồn: **openai/codex @ tag rust-v0.169.0** (Apache-2.0), vendored ngày 14/11/2026.

## Phạm vi vendored

| Vendored | Từ | Ghi chú |
|---|---|---|
| `src/upstream/apply_patch/` (6 file) | `codex-rs/apply-patch/src/` | lib/parser/file_update/text_file/seek_sequence/streaming_parser — đã cắt: invocation.rs (heredoc + tree-sitter), main.rs, standalone_executable.rs, tests mod |
| `src/upstream/file_system.rs` | `codex-rs/file-system/src/lib.rs` | Bản rút gọn: trait 4 method (read_file/write_file/create_directory/get_metadata) + `StdFs` impl tự viết |
| `src/upstream/path_uri/` (6 file) | `codex-rs/utils/path-uri/src/` | bỏ file test, strip ts_rs derives |
| `src/upstream/absolute_path/` (3 file) | `codex-rs/utils/absolute-path/src/` | bỏ file test |

## Đã cắt khỏi cone upstream

`codex-exec-server` → `codex-protocol` → AWS SDK types + mxc-sandbox (repo ngoài microsoft/mxc) + rama alpha mismatch + tokio-tungstenite fork patch. Trait `ExecutorFileSystem` rút gọn đúng 4 method mà apply_patch gọi (`read_file_text` giữ default impl).

## Lý do vendor thay vì git dep

Git dep `codex-apply-patch` kéo cả workspace codex: internal breakage (tokio-tungstenite "proxy" feature không tồn tại trên crates.io 0.28.0 — upstream dùng fork patch), cone 100+ crate gồm repo ngoài (microsoft/mxc) + rama alpha mismatch. Vendoring giữ đúng engine diff V4A + parser, cone đóng trong ghita-patch.

## Cập nhật upstream sau này

Copy lại từ tag codex mới, chạy lại các bước cắt (xem git history của chính file này) — các bước cắt đã ghi ở bảng trên.
