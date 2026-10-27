# Contributing to Ghita Agent

---

<details open>
<summary><b>🇺🇸 English Version</b></summary>

Thank you for your interest in the project! Here are the contribution guidelines.

## Requirements

- Node.js >= 20.0.0
- pnpm >= 10.x
- Rust (for Tauri desktop)
- Android Studio (for mobile)

## Getting Started

```bash
# Clone repo
git clone https://github.com/ghitatruongle/GHITA-AGENT.git
cd GHITA-AGENT

# Install dependencies
pnpm install

# Run desktop dev
pnpm dev:desktop

# Run mobile dev
pnpm dev:android
```

## Contribution Workflow

1. Fork the repo
2. Create a branch: `git checkout -b feat/feature-name`
3. Commit: `git commit -m "feat: describe feature"`
4. Push: `git push origin feat/feature-name`
5. Create a Pull Request

## Commit Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation
- `style:` — Code formatting
- `refactor:` — Code refactoring
- `test:` — Add/update tests
- `chore:` — Other tasks

## Code Style

- TypeScript strict mode
- Prettier formatting (`.prettierrc`)
- ESLint rules (`eslint.config.js`)
- Run `pnpm lint` and `pnpm typecheck` before committing

## Project Structure

```
├── apps/
│   ├── desktop/           # Tauri + React desktop app
│   ├── mobile/            # React Native Android app
│   └── vscode-extension/  # VS Code extension
├── packages/
│   ├── a11y/              # Accessibility utilities
│   ├── agents/            # Agent management
│   ├── ai-engine/         # Multi-provider AI engine
│   ├── browser-control/   # Playwright + CloakBrowser
│   ├── code-graph/        # Code analysis & graph
│   ├── communication/     # Desktop ↔ Mobile (Socket.IO)
│   ├── computer-use/      # nut.js + UI-TARS
│   ├── gui/               # Shared UI components
│   ├── i18n/              # Internationalization
│   ├── integration/       # Cross-package integration
│   ├── marketplace/       # Skill marketplace & plugins
│   ├── memory/            # Agent memory
│   ├── migration/         # Data migration utilities
│   ├── mobile-companion/  # Mobile helper modules
│   ├── monitoring/        # Observability & metrics
│   ├── notification/      # Push notification system
│   ├── quotas/            # Rate limiting & quotas
│   ├── relay-server/      # Relay server for comms
│   ├── security/          # Security & sandboxing
│   ├── shared/            # Types, constants, utils, logger
│   ├── skills/            # Skill registry & execution
│   └── voice/             # Voice input/output
└── tests/                 # Unit, integration, E2E tests
```

## Pull Request Guidelines

### Before Creating a PR

- [ ] Code runs (`pnpm dev:desktop` or `pnpm dev:android`)
- [ ] No TypeScript errors (`pnpm typecheck`)
- [ ] Passes lint (`pnpm lint`)
- [ ] Code is formatted (`pnpm format:check`)
- [ ] Tests pass (`pnpm test`)
- [ ] New features have accompanying tests
- [ ] Breaking changes are documented in the PR description

### PR Rules

- **Concise**: 1 PR = 1 feature or 1 bug fix. Avoid oversized PRs.
- **Clear description**: Explain _why_ the change, not just _what_.
- **Screenshots/Video**: If UI changes, attach images or video.
- **Linked Issues**: Link related issue (if any) using `Fixes #123`.
- **Draft PR**: If work-in-progress, create a Draft PR first.

### PR Template

```markdown
## Description

[Brief explanation of the change]

## Type of Change

- [ ] New feature
- [ ] Bug fix
- [ ] Documentation
- [ ] Refactor

## How to Test

1. [Step 1]
2. [Step 2]

## Screenshots (if applicable)
```

## Bug Reports

Use [GitHub Issues](https://github.com/ghitatruongle/GHITA-AGENT/issues) to report bugs.

</details>

<details>
<summary><b>🇻🇳 Phiên bản Tiếng Việt</b></summary>

Cảm ơn sự quan tâm của bạn dành cho dự án! Dưới đây là các hướng dẫn khi tham gia đóng góp mã nguồn.

## Yêu cầu Hệ thống

- Node.js >= 20.0.0
- pnpm >= 10.x
- Rust (dành cho ứng dụng máy tính Tauri)
- Android Studio (dành cho thiết bị di động)

## Bắt đầu nhanh

```bash
# Nhân bản dự án (Clone)
git clone https://github.com/ghitatruongle/GHITA-AGENT.git
cd GHITA-AGENT

# Cài đặt gói phụ thuộc
pnpm install

# Khởi chạy ứng dụng máy tính ở chế độ dev
pnpm dev:desktop

# Khởi chạy ứng dụng di động ở chế độ dev
pnpm dev:android
```

## Quy trình Đóng góp

1. Fork kho lưu trữ (repo) này
2. Tạo nhánh mới: `git checkout -b feat/ten-tinh-nang`
3. Commit thay đổi: `git commit -m "feat: mo ta tinh nang"`
4. Đẩy lên nhánh trên repo fork: `git push origin feat/ten-tinh-nang`
5. Tạo một Pull Request (yêu cầu kéo mã - PR)

## Quy chuẩn Commit

Sử dụng chuẩn [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — Tính năng mới
- `fix:` — Sửa lỗi
- `docs:` — Cập nhật tài liệu
- `style:` — Định dạng mã nguồn (không thay đổi logic)
- `refactor:` — Tái cấu trúc mã nguồn
- `test:` — Thêm hoặc cập nhật các bài kiểm thử (test)
- `chore:` — Các thay đổi nhỏ khác (không ảnh hưởng trực tiếp đến tính năng)

## Phong cách Lập trình

- Sử dụng chế độ nghiêm ngặt (strict mode) của TypeScript
- Tuân thủ định dạng mã nguồn Prettier (`.prettierrc`)
- Tuân thủ quy tắc ESLint (`eslint.config.js`)
- Hãy chạy lệnh `pnpm lint` và `pnpm typecheck` trước khi thực hiện commit

## Cấu trúc Dự án

```
├── apps/
│   ├── desktop/           # Ứng dụng máy tính sử dụng Tauri + React
│   ├── mobile/            # Ứng dụng Android viết bằng React Native
│   └── vscode-extension/  # Tiện ích mở rộng VS Code
├── packages/
│   ├── a11y/              # Tiện ích trợ năng
│   ├── agents/            # Quản lý đại lý AI
│   ├── ai-engine/         # Bộ điều phối đa nhà cung cấp AI
│   ├── browser-control/   # Điều khiển trình duyệt (Playwright)
│   ├── code-graph/        # Phân tích & đồ thị mã nguồn
│   ├── communication/     # Giao tiếp Desktop ↔ Mobile (Socket.IO)
│   ├── computer-use/      # Điều khiển máy tính (nut.js + UI-TARS)
│   ├── gui/               # Thành phần UI dùng chung
│   ├── i18n/              # Quốc tế hóa
│   ├── integration/       # Tích hợp liên gói
│   ├── marketplace/       # Chợ kỹ năng & plugin
│   ├── memory/            # Bộ nhớ của đại lý
│   ├── migration/         # Tiện ích di chuyển dữ liệu
│   ├── mobile-companion/  # Module hỗ trợ di động
│   ├── monitoring/        # Quan sát & đo lường
│   ├── notification/      # Hệ thống thông báo đẩy
│   ├── quotas/            # Giới hạn tốc độ & quota
│   ├── relay-server/      # Máy chủ trung gian giao tiếp
│   ├── security/          # Bảo mật & sandbox
│   ├── shared/            # Các kiểu dữ liệu, hằng số, bộ logger
│   ├── skills/            # Đăng ký & thực thi kỹ năng
│   └── voice/             # Đầu vào/ra giọng nói
└── tests/                 # Bài kiểm thử unit, integration, E2E
```

## Hướng dẫn gửi Pull Request (PR)

### Trước khi tạo PR

- [ ] Dự án khởi chạy ổn định (`pnpm dev:desktop` hoặc `pnpm dev:android`)
- [ ] Không có lỗi kiểm tra kiểu TypeScript (`pnpm typecheck`)
- [ ] Vượt qua tất cả kiểm tra cú pháp (`pnpm lint`)
- [ ] Mã nguồn đã được định dạng chuẩn xác (`pnpm format:check`)
- [ ] Tất cả bài kiểm thử đều pass (`pnpm test`)
- [ ] Tính năng mới có bài kiểm thử đi kèm
- [ ] Thay đổi breaking được mô tả trong PR

### Quy tắc PR

- **Ngắn gọn, tập trung**: Mỗi PR chỉ nên thực hiện 1 tính năng hoặc 1 sửa lỗi. Tránh các PR quá lớn và chứa quá nhiều thay đổi không liên quan.
- **Mô tả rõ ràng**: Giải thích _tại sao (why)_ thay đổi này cần thiết, chứ không chỉ nêu _cái gì (what)_ đã thay đổi.
- **Ảnh chụp / Video**: Nếu thay đổi liên quan đến giao diện người dùng (UI), hãy đính kèm hình ảnh hoặc video minh họa.
- **Liên kết Issues**: Liên kết đến issue liên quan (nếu có) bằng cú pháp `Fixes #123`.
- **PR Nháp (Draft PR)**: Nếu công việc chưa hoàn tất nhưng muốn thảo luận trước, hãy tạo Draft PR.

### Biểu mẫu PR

```markdown
## Description

[Mô tả ngắn gọn về những thay đổi trong PR này]

## Type of Change

- [ ] New feature (Tính năng mới)
- [ ] Bug fix (Sửa lỗi)
- [ ] Documentation (Cập nhật tài liệu)
- [ ] Refactor (Tái cấu trúc)

## How to Test

1. [Bước kiểm thử 1]
2. [Bước kiểm thử 2]

## Screenshots (if applicable)
```

## Báo cáo lỗi

Sử dụng mục [GitHub Issues](https://github.com/ghitatruongle/GHITA-AGENT/issues) để báo cáo lỗi hoặc đề xuất tính năng mới.

</details>
