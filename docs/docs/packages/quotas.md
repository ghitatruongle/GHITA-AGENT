---
id: packages-quotas
title: '@ghita/quotas'
sidebar_position: 7
---

# `@ghita/quotas`

Package `@ghita/quotas` cung cấp rate limiting, per-user quota management và usage dashboard. Xem tiến độ trong [ROADMAP](https://github.com/ghitatruongle/GHITA-AGENT/blob/main/ROADMAP.md).

## Cài đặt

```ts
import { QuotaManager, RateLimiter, UsageDashboard } from '@ghita/quotas';
```

## Quota Manager

```ts
const quotas = new QuotaManager({
  defaultPeriodMs: 24 * 60 * 60 * 1000, // 1 day
  globalRateLimit: { maxRequests: 10_000, windowMs: 60_000 },
});

// Auto-register khi user dùng lần đầu với tier 'free'
// Hoặc register thủ công:
quotas.registerSubject('user_123', 'pro'); // tier preset
quotas.registerSubject('team_acme', {
  // custom config
  subjectId: 'team_acme',
  tier: 'custom',
  maxInputTokensPerPeriod: 50_000_000,
  maxOutputTokensPerPeriod: 25_000_000,
  maxRequestsPerPeriod: 100_000,
  periodMs: 24 * 60 * 60 * 1000,
  onExceed: 'overage',
  overageCostPer1kTokens: 0.4,
});

// Consume trước khi call LLM
const result = quotas.consume('user_123', {
  inputTokens: 1234,
  outputTokens: 567,
});
if (!result.allowed) {
  throw new Error(`quota_exceeded: ${result.deniedReason}`);
}
```

### Tier presets

| Tier         | Input/day  | Output/day | Requests/day | Overage     |
| ------------ | ---------- | ---------- | ------------ | ----------- |
| `free`       | 100K       | 50K        | 200          | ❌ block    |
| `pro`        | 2M         | 1M         | 5K           | ✅ $0.50/1K |
| `team`       | 20M        | 10M        | 50K          | ✅ $0.40/1K |
| `enterprise` | 200M       | 100M       | 500K         | ✅ $0.30/1K |
| `custom`     | tuỳ config | tuỳ config | tuỳ config   | tuỳ config  |

## Rate Limiter (độc lập)

3 strategies: `token-bucket`, `sliding-window`, `fixed-window`.

```ts
const limiter = new RateLimiter({
  maxRequests: 60,
  windowMs: 60_000,
  strategy: 'token-bucket', // mặc định
  burstCapacity: 10, // cho phép burst
});

const r = limiter.check('user_123');
if (!r.allowed) {
  res.status(429).set('Retry-After', String(r.retryAfterSec));
  return;
}
```

### Strategies

- **token-bucket** — mượt, cho phép burst, refill liên tục (mặc định)
- **sliding-window** — chính xác, đếm từng request trong cửa sổ trượt
- **fixed-window** — rẻ, đếm theo cửa sổ cố định (có thể spike ở ranh giới)

## Usage Dashboard

```ts
const dashboard = new UsageDashboard(quotas);

const snap = dashboard.snapshot('user_123');
// → { usage, limits, utilization, estimatedOverageCents, periodStart, periodEnd }

const stats = dashboard.stats();
// → { totalSubjects, totalRequests, totalTokens, byTier, topConsumers }

const hot = dashboard.findHot(0.9); // users >90% quota
```

### CLI Debug

```ts
console.log(dashboard.renderTable());
// subject                 tier        input/output/reqs  util(%)  overage¢
// -----------------------------------------------------------------
// user_123                pro         1234/567/12          3
// team_acme               custom      0/0/0                0       0.00
```

## Per-subject rate limit

Khi register subject, manager tự tạo một `RateLimiter` riêng dựa trên `maxRequestsPerPeriod` và `periodMs` — burst = `maxRequestsPerPeriod / 100`.

Bạn có thể tắt bằng cách set `maxRequestsPerPeriod: 0`.
