---
id: packages-monitoring
title: '@ghita/monitoring'
sidebar_position: 6
---

# `@ghita/monitoring`

Package `@ghita/monitoring` cung cấp Sentry-compatible error capture, performance tracing, error grouping và alert engine. Xem tiến độ trong [ROADMAP](https://github.com/ghitatruongle/GHITA-AGENT/blob/main/ROADMAP.md).

## Cài đặt

```ts
import { MonitoringHub } from '@ghita/monitoring';
```

## Khởi tạo

```ts
const monitor = new MonitoringHub({
  enabled: true,
  sentry: {
    dsn: process.env.SENTRY_DSN!,
    environment: process.env.NODE_ENV ?? 'development',
    release: 'ghita@0.0.3',
    sampleRate: 1.0,
    tracesSampleRate: 0.1,
  },
  logger: (msg, level) => console[level](msg),
});
```

## Capture Error

```ts
try {
  await riskyOperation();
} catch (err) {
  monitor.captureError(err, {
    userId: 'user_123',
    sessionId: 'sess_abc',
    provider: 'openai',
    model: 'gpt-4o',
    tags: { feature: 'chat' },
    extra: { promptLength: 1234 },
  });
}
```

## Capture Message

```ts
monitor.captureMessage('User upgraded to Pro', 'info', { userId: 'user_123' });
```

## Performance Tracing

```ts
const tx = monitor.startTransaction('POST /api/chat', { userId: 'user_123' });
if (tx) {
  // Nested spans cho từng operation
  await monitor.performance.measure(tx.spanId, 'provider.openai.chat', async () => {
    return await openai.chat(messages);
  });
  await monitor.performance.measure(tx.spanId, 'memory.retrieve', async () => {
    return await memory.search(query);
  });

  await monitor.finishTransaction(tx.spanId);
}
```

## Alert Rules

```ts
monitor.addAlertRule({
  id: 'openai-rate-limit',
  name: 'OpenAI 429 floods',
  pattern: '429|rate.?limit',
  minSeverity: 'warning',
  threshold: 5,
  windowMs: 60_000,
  cooldownMs: 5 * 60_000,
  enabled: true,
  onTrigger: async (event) => {
    await notifySlack(`🚨 ${event.ruleName}: ${event.count} hits`);
  },
});
```

## Flush & Shutdown

```ts
// Trước khi process thoát
await monitor.shutdown();

// Hoặc force flush bất cứ lúc nào
const { sent, failed } = await monitor.flush();
```

## Inspect Stats

```ts
const stats = monitor.stats();
// → { totalErrors, totalTransactions, errorGroupCount, activeAlertRules, alertsTriggered, ... }
```

## Top Error Groups

```ts
const top = monitor.errorGrouper.top(5, 'count');
for (const g of top) {
  console.log(`${g.fingerprint}: ${g.type} ×${g.count} (${g.affectedUsers.size} users)`);
}
```

## Low-level API

Ngoài `MonitoringHub`, bạn có thể dùng trực tiếp các sub-modules:

```ts
import {
  RateLimiter,
  ErrorGrouper,
  AlertEngine,
  SentryClient,
  PerformanceMonitor,
} from '@ghita/monitoring';
```
