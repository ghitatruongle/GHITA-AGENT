# Terminal & Browser v1.1.0 — Track 7 (mục tiêu 47–50 / P74–P83)

## 1. Terminal session primitives (`packages/terminal-session`) — P74/P75/P76

### Buffer serialize/restore (`src/index.ts`) — P74

- `TerminalSnapshot {id, buffer (VT sequences), cols, rows, cwd, createdAt}` —
  restore-toàn-bộ sau reconnect (addon-serialize pattern).
- `MemoryTerminalSessionStore` (test/short) + `FileTerminalSessionStore` (JSON bền,
  bounded 20 snapshots, restore sau restart app).

### Flow control — P75

- `FlowControl.feed(chunk)` — phát hiện XOFF (`\x13`) → `pause`, XON (`\x11`) → `resume`;
  `shouldBackpressure()` cho output lớn (node-pty handleFlowControl).

### Resize + pixel size — P75

- `TerminalResizeManager.resize({cols, rows, pixelWidth, pixelHeight})` — clamp theo
  policy; `fitFromPixels(width, height, charW, charH)`.

> P76 (xterm addons: search/fit/unicode11/webgl) là lựa chọn UI-side ở apps/desktop —
> các primitive dưới đây cung cấp dữ liệu (size, snapshot) để addon consume.

## 2. Browser action registry (`browser-control/src/track7/action-registry.ts`) — P77

- `ActionRegistry` — 8 built-in (click/fill/navigate/scroll/extract/screenshot/wait/
  submit) với metadata `terminatesSequence`, `domains`, `output`, `paramsSchema`;
  `register()` action tùy chỉnh; `forDomain()`, `validate()`.

## 3. ActCache (`track7/act-cache.ts`) — P78

- `actCacheKey(intent, url, domSignature)` — key SHA-256; `domSignature(html)`.
- `ActCache` — SQLite (hoặc memory bounded) + TTL giây + hit counter; `get()` replay
  **không gọi LLM**; `invalidate()`; `stats()`.

## 4. Outcome verifier + taxonomy (`track7/verifier.ts`) — P79

- `DEFAULT_ACT_VERIFIER` — evidence-based (url change cho navigate, DOM mutation cho
  click/fill/submit, element-found cho extract).
- `classifyActError` — timeout/not-found/stale/blocked/navigation/unknown.
- `runActionWithRetry` — retry chỉ category retryable, exponential backoff (cap 5s).

## 5. Network interception + HAR (`track7/network.ts`) — P80

- `NetworkInterceptor` — `start/finish/markBlocked` request log; `addBlockRule(hostRegex,
reason)` + `decide(url)` abort allowlist; `exportHAR()` chuẩn HAR 1.2 (kèm `_ghita`
  blocked/resourceType).

## 6. Trace-light (`track7/trace.ts`) — P81

- `ActionTrace {action, args, url, domBefore/After, ok, evidence, durationMs}`;
  `MemoryTraceStore`; `toTimelineView()` cho Dashboard timeline; `summarizeTraces()`
  (success rate, byAction, avg duration).

## 7. Security cross-check — P82 (đã cover từ các Track trước)

| Ràng buộc                                      | Nơi triển khai                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| MCP server deny-default (tool scrub)           | Track 1 — `@ghita/mcp` preToolCall hooks                                           |
| Skill `allowed-tools` + sandbox deny           | Track 2 — `skills/v2/enforce` + `SkillSandboxRunner`                               |
| Supply-chain scan skill/plugin + quarantine    | Track 3 — `marketplace/plugins/supply-chain` + trust                               |
| Browser navigation host allowlist              | Track 1 — `browser-control/mcp-server` allowedHosts + Track 7 `NetworkInterceptor` |
| Terminal flow backpressure (chống tràn output) | Track 7 — `FlowControl`                                                            |

## 8. Release gates — P83

- Các package Track 7: typecheck 0 lỗi, test xanh, build OK, version 1.1.0;
  gates chuẩn repo (mapping-gate, coverage tiers, integrity) áp dụng như cũ khi
  release — nằm ngoài phạm vi code.

## Exports

```ts
// @ghita/terminal-session
import {
  MemoryTerminalSessionStore,
  FileTerminalSessionStore,
  FlowControl,
  TerminalResizeManager,
} from '@ghita/terminal-session';
// @ghita/browser-control
import {
  ActionRegistry,
  ActCache,
  runActionWithRetry,
  classifyActError,
  NetworkInterceptor,
  MemoryTraceStore,
  summarizeTraces,
} from '@ghita/browser-control';
```

## Verify

```bash
pnpm --filter @ghita/terminal-session typecheck && pnpm --filter @ghita/terminal-session test   # 6 tests
pnpm --filter @ghita/browser-control typecheck && pnpm --filter @ghita/browser-control test     # 129 tests
pnpm --filter @ghita/terminal-session --filter @ghita/browser-control build
```
