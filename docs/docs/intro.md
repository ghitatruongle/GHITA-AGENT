---
id: intro
title: Welcome to Ghita Agent
sidebar_label: Introduction
sidebar_position: 0
slug: /
---

# Ghita Agent

**Trợ lý lập trình AI đa nhà cung cấp với skills, computer use và bộ nhớ dài hạn**,
dành cho lập trình viên cần toàn quyền kiểm soát môi trường làm việc.

## Tính năng chính

- **30+ nhà cung cấp LLM** — OpenAI, Anthropic, Google, Groq, Ollama và nhiều dịch vụ khác.
- **Skills marketplace** — cài đặt và quản lý kỹ năng tự động hóa.
- **Computer use** — điều khiển desktop, trình duyệt và terminal qua ngôn ngữ tự nhiên.
- **Memory layer** — ngữ cảnh dài hạn, tìm kiếm ngữ nghĩa và knowledge graph.
- **Đa nền tảng** — Desktop Tauri, Android và VS Code Extension.
- **Local-first** — dữ liệu được giữ cục bộ trừ khi tính năng yêu cầu gọi dịch vụ bên ngoài.

## Cài đặt nhanh

```bash
git clone https://github.com/ghitatruongle/GHITA-AGENT
cd GHITA-AGENT
pnpm install --frozen-lockfile
pnpm dev:desktop
```

## Kiến trúc tổng quan

```text
apps/        — desktop, mobile, vscode-extension
packages/    — thư viện và dịch vụ dùng chung
docs/        — tài liệu công khai, được kiểm tra theo phiên bản
```

Xem [Getting Started](./getting-started) để bắt đầu hoặc
[Architecture](./architecture) để tìm hiểu hệ thống.

## Phiên bản hiện tại

**0.3.6-dev** — production hardening. Bản phát hành chỉ được gắn tag sau khi
toàn bộ cổng kiểm định trong `docs/release-plan-v0.3.6.md` vượt qua.
