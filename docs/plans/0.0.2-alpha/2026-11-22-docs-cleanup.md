# Kế hoạch vệ sinh tài liệu — chuẩn bị chu kỳ v0.0.2-alpha

> **Ngày lập:** 22/11/2026 · **Phạm vi:** thư mục `docs/` (+ vài khoản mục root liên quan tài liệu)
> **Quy tắc chung:** KHÔNG tự ý `git commit` / `git push` — mọi thay đổi nằm ở working tree, owner duyệt xong mới commit. `refer_project/` chỉ đọc.

---

## 1. Mục tiêu

Trước khi mở chu kỳ phát triển mới (v0.0.2-alpha), đưa `docs/` về trạng thái "chỉ còn tài liệu thật": bỏ rác tạm (log chạy thử), sửa tham chiếu hỏng, tổ chức lại các md rời ở gốc docs, và xác nhận nội dung docs khớp với trạng thái code/docs-site hiện tại.

## 2. Trạng thái hiện tại (facts đọc trực tiếp từ repo, 22/11/2026)

- `docs/` có 85 file git-tracked; ngoài ra **74 file `.log`** (~851KB) untracked + gitignored (quy tắc `**/*.log`, .gitignore:202) — rác tạm từ các vòng test/build trước.
- `docs/` là site Docusaurus (`docusaurus.config.ts`, `sidebars.ts`, `src/`, `static/`, nội dung `docs/docs/`). `docs/node_modules` (ignored) là deps Docusaurus — không đụng.
- **CI-consumed files — GIỮ NGUYÊN VỊ TRÍ (không xóa, không di chuyển):** `docs/code-review-findings.md`, `docs/perf-baseline.json`, `docs/perf-native.json`, `docs/perf-ram-baseline.json`, `docs/resource-budget.json`, `docs/coverage-tiers.json`, `docs/coverage-policy.md`.
- Tham chiếu hỏng: `docs/plans/2026-11-14-v0.0.2-preview-deep-integration.md` còn trỏ tới `docs/plans/2026-11-08-v0.0.1.md` — file không tồn tại.
- Nhóm md rời ở gốc `docs/` (khoảng 20 file): design docs (`engine-rust-layer.md`, `rust-store-napi-design.md`, `release-pipeline-design.md`, `sandbox.md`, `flags.md`, `hooks.md`, `installer.md`, `evals.md`, `perf-rust.md`, `terminal-browser-v2.md`, `marketplace-v2.md`, `memory-v2.md`, `memory-hybrid-search.md`, `skills-v2.md`), bản findings theo version (`code-review-findings-0.0.1.md`, `code-review-findings-0.0.2-preview.md`), bản demo/profile one-off (`profiling-1.2.0-demo1.md`, `research-demo2-10-points.md`, `rust-demo1-design.md`), policy (`telemetry-policy.md`).
- Root-level strays ngoài phạm vi docs: `.bench-tmp/`, `mock-project/`, `.v2c/` (đều untracked).

## 3. Nguyên tắc an toàn

1. Không xóa/di chuyển CI-consumed files (danh sách mục 2) nếu không có xác nhận của owner.
2. Chỉ xóa file untracked + gitignored (74 log). Không xóa/di chuyển file tracked khi chưa owner duyệt.
3. Mỗi phase xong → báo owner, chờ lệnh tiếp.
4. Sau dọn: working tree chỉ chứa đúng các thay đổi dự kiến; bất kỳ diff lạ nào → dừng báo owner.

## 4. Phases

### P1 — Xóa rác log (an toàn cao, làm ngay khi owner gật)

- `rm docs/*.log` (74 file, ~851KB; gồm cả `docs/codegraph-025-test.log`). Đều untracked + ignored → working tree không đổi so với git.
- Gate P1: `git status --porcelain docs` cho ra đúng kỳ vọng (85 file tracked giữ nguyên, không diff).

### P2 — Sửa tham chiếu hỏng (tracked, sửa nội dung md)

- Sửa tham chiếu tới `docs/plans/2026-11-08-v0.0.1.md` (file mất) trong plan v0.0.2-preview thành ghi chú "đã lưu trữ/xóa".
- Grep toàn repo các tham chiếu tới log đã xóa (chỉ thấy trong plan v0.0.2-preview) → đổi sang mô tả tổng quát.

### P3 — Tổ chức lại md rời (tracked → cần owner duyệt cây đề xuất trước)

- Đề xuất cây mới:
  - `docs/design/` — design docs: engine-rust-layer, rust-store-napi-design, release-pipeline-design, sandbox, flags, hooks, installer, evals, perf-rust, terminal-browser-v2, marketplace-v2, memory-v2, memory-hybrid-search, skills-v2
  - `docs/research/` — crewai-engine-notes, research-demo2-10-points, profiling-1.2.0-demo1, rust-demo1-design (one-off demo/profile)
  - `docs/findings/` — bản findings theo version (0.0.1, 0.0.2-preview) — KHÔNG đụng `docs/code-review-findings.md` (CI-consumed, giữ gốc)
  - `docs/plans/0.0.2-alpha/` — thư mục mới cho tài liệu chu kỳ đang phát triển (đã tạo, có plan này làm tài liệu đầu tiên)
  - `docs/adr/` giữ nguyên.
- Trước khi di chuyển: grep toàn repo tham chiếu `docs/<tên>.md` để sửa link theo; đặc biệt chú ý `docs/docs/**`, `sidebars.ts`, `docusaurus.config.ts`, CI workflow.
- Gate P3: docusaurus build vẫn xanh; `git status` khớp kỳ vọng (đúng các file bị rename).

### P4 — Audit nội dung

- So nội dung `docs/docs/` (Docusaurus) với trạng thái thật của packages/apps/crates: liệt kê md lỗi thời → đánh dấu "Needs update" hoặc mở issue nội bộ.
- `ROADMAP.md` / `PROJECT.md`: cập nhật trạng thái version (v0.0.2-preview → v0.0.2-alpha mở).

### P5 — Verify cuối

- Build Docusaurus xanh (theo scripts trong `docs/package.json`).
- `git status` khớp kỳ vọng; không còn `.log` trong docs; không còn tham chiếu hỏng.
- Báo cáo tổng: tổng số file xóa/move/fix, trước/sau.

## 5. Không làm trong plan này

- Không đụng `refer_project/`, `.bench-tmp/`, `mock-project/`, `.v2c/` — ngoài phạm vi tài liệu; nếu muốn dọn, owner ra lệnh riêng.
- `CHANGELOG.md` (103KB) tự sinh từ git-cliff (`cliff.toml`) — không sửa tay.
- Không đổi `.gitignore`, CI workflow.
