---
id: packages-security
title: '@ghita/security'
sidebar_position: 5
---

# `@ghita/security`

Package `@ghita/security` cung cấp các công cụ bảo mật thiết yếu cho GHITA: input sanitization, XSS prevention, CORS policy và API key rotation. Xem tiến độ trong [ROADMAP](https://github.com/ghitatruongle/GHITA-AGENT/blob/main/ROADMAP.md).

## Cài đặt

Đã có sẵn trong workspace. Import:

```ts
import {
  InputSanitizer,
  XSSPrevention,
  CORSPolicyManager,
  KeyRotationManager,
} from '@ghita/security';
```

## Input Sanitizer

Phát hiện và loại bỏ XSS, SQL injection, command injection, path traversal.

```ts
const sanitizer = new InputSanitizer();

const result = sanitizer.sanitize(userInput, 'user.name');
if (result.modified) {
  console.warn('Threats removed:', result.threats);
}
```

Patterns mặc định:

- `<script>`, `javascript:`, `on*=` → XSS
- `SELECT/INSERT/UPDATE/DELETE ...` → SQL injection
- `;rm`, `$(...)`, backticks → Command injection
- `../`, `/etc/`, `/proc/` → Path traversal

## XSS Prevention

Whitelist HTML tags và attributes an toàn.

```ts
const xss = new XSSPrevention({
  allowedTags: ['b', 'i', 'code', 'pre', 'a'],
  allowedAttributes: { a: ['href'] },
  allowedProtocols: ['http', 'https'],
});

const safe = xss.escape('<script>alert(1)</script><b>OK</b>');
// → '&lt;script&gt;alert(1)&lt;/script&gt;<b>OK</b>'
```

## CORS Policy

Quản lý CORS cho HTTP server.

```ts
const cors = new CORSPolicyManager({
  allowedOrigins: ['https://app.ghita.dev'],
  allowedMethods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400,
});

const result = cors.check('https://app.ghita.dev', 'POST');
if (result.allowed) {
  res.setHeaders(result.headers);
}
```

## API Key Rotation

Tự động rotate API key theo policy (mặc định 90 ngày, cảnh báo trước 14 ngày).

```ts
const keys = new KeyRotationManager({
  maxAgeDays: 90,
  warnBeforeDays: 14,
  autoRotate: false,
  gracePeriodKeys: 2,
});

const { key, meta } = keys.generateKey('openai-prod', ['chat', 'embed']);
// Lưu `key` an toàn ở keychain, lưu `meta` ở DB

const validation = keys.validateKey(key);
if (!validation) throw new Error('Invalid or expired key');

// Check policy định kỳ
const { expired, expiringSoon } = keys.checkPolicy();
```

## Audit Reporting

```ts
const report = keys.audit();
// → { total, critical, high, medium, low, score }
```

Score 0-100. Mục tiêu: ≥ 90.
