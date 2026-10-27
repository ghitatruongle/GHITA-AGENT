# Sentry Production Integration & Telemetry Opt-In

## Overview

Ghita Agent uses Sentry for error tracking and performance monitoring via the `@ghita/monitoring` package. This document describes the production configuration and opt-in telemetry policy.

## Sentry Configuration

### Development (default)

```env
SENTRY_DSN=
SENTRY_ENVIRONMENT=development
SENTRY_SAMPLE_RATE=0.0
```

Telemetry is **disabled by default** in development.

### Production

```env
SENTRY_DSN=https://your-dsn@sentry.io/project-id
SENTRY_ENVIRONMENT=production
SENTRY_SAMPLE_RATE=0.25
SENTRY_TRACES_SAMPLE_RATE=0.1
SENTRY_RELEASE=0.0.4
```

### Opt-In Policy

We follow a strict **opt-in** telemetry model:

1. **No telemetry without explicit consent**: Users must enable telemetry in settings
2. **No PII collection**: All personally identifiable information is redacted before transmission
3. **Transparent disclosure**: The `SECURITY.md` and in-app settings clearly describe what is collected
4. **Easy opt-out**: Single toggle to disable all telemetry at any time

## What We Collect

| Category    | Examples                           | Purpose              |
| ----------- | ---------------------------------- | -------------------- |
| Errors      | Stack traces, error messages       | Debug crashes        |
| Performance | Transaction duration, span timings | Identify bottlenecks |
| Breadcrumbs | Navigation events, UI interactions | Reproduce issues     |
| System info | OS, Node version, Tauri version    | Environment context  |

## What We Never Collect

- API keys or secrets
- Chat content or prompts
- File contents
- Personal identifiers (name, email, IP)
- Keystrokes or screen content

## Implementation

The `SentryClient` class in `packages/monitoring/src/sentry-client.ts` handles initialization:

```ts
import { SentryClient } from '@ghita/monitoring';

const client = new SentryClient({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? 'development',
  tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0'),
  enabled: process.env.SENTRY_DSN !== undefined, // opt-in gate
});

await client.init();
```

## CI Integration

Sentry releases are created during the `release.yml` workflow:

```yaml
- name: Create Sentry Release
  uses: getsentry/action-release@v3
  with:
    auth_token: ${{ secrets.SENTRY_AUTH_TOKEN }}
    version: ${{ github.ref_name }}
    projects: desktop, mobile
```

## Compliance

This configuration aligns with:

- GDPR Article 7 (consent)
- CCPA opt-out requirements
- Tauri security best practices
