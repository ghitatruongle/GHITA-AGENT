---
id: getting-started
title: Getting Started
sidebar_label: Getting Started
sidebar_position: 1
---

# Getting Started

Hướng dẫn cài đặt Ghita Agent trong 5 phút.

## Yêu cầu

- **Node.js** ≥ 20.0.0
- **pnpm** ≥ 10.14.0
- **Rust** ≥ 1.70 (cho Tauri desktop)
- **Git**

## Cài đặt

```bash
# Clone repo
git clone https://github.com/ghitatruongle/GHITA-AGENT
cd GHITA-AGENT

# Cài dependencies
pnpm install

# Chạy desktop app (Tauri)
pnpm dev:desktop
```

App sẽ mở ở `http://localhost:1420` (frontend Vite) + native Tauri window.

## Cấu hình provider đầu tiên

1. Mở Settings → Providers
2. Chọn 1 provider (vd: OpenAI)
3. Dán API key
4. Click "Test connection"

```json
// ~/.ghita/config.json
{
  "providers": {
    "openai": {
      "apiKey": "sk-...",
      "defaultModel": "gpt-4o"
    }
  }
}
```

## Chạy agent đầu tiên

Trong chat box:

> Tạo 1 REST API bằng Express.js với 3 endpoint: GET /users, POST /users, DELETE /users/:id

Agent sẽ tự động:

1. Phân tích yêu cầu
2. Lên plan
3. Viết code vào `src/server.ts`
4. Cài `express` qua npm
5. Chạy `tsc` để verify

## Tiếp theo

- [Architecture](./architecture) — hiểu hệ thống
- [Features](./features/multi-provider) — khám phá tính năng
- [Tutorials](./tutorials/first-agent) — hands-on examples
