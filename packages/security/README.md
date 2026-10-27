# @ghita/security

![Version](https://img.shields.io/badge/version-0.1.5-blue)
![Coverage](https://img.shields.io/badge/coverage-94%25_lines-brightgreen)
![Tier](https://img.shields.io/badge/tier-T0_critical-red)

Security toolkit for Ghita Agent: input sanitization, CORS auditing, API key rotation, and audit reporting.

## Install

```bash
pnpm --filter @ghita/security build
pnpm --filter @ghita/security test
```

## Public API

```ts
import {
  InputSanitizer,
  CorsAuditor,
  SecretRotator,
  maskKey,
  AuditRunner,
  SECURITY_VERSION,
} from '@ghita/security';

const sanitizer = new InputSanitizer();
const { issues, cleaned } = sanitizer.scan('<script>x</script>', 'chat.user');
const safe = sanitizer.isSafeUrl('https://1.1.1.1/'); // SSRF blocklist for private IPs

const cors = new CorsAuditor().audit(
  { origins: ['*'], methods: ['GET'], headers: ['*'], credentials: true },
  'api.ts',
);

const rotator = new SecretRotator({
  generateKey: async () => 'new-key-material',
});
rotator.register({
  id: 'k1',
  provider: 'openai',
  maskedKey: maskKey('sk-live-secret'),
  createdAt: Date.now(),
  unmaskedKey: 'sk-live-secret',
});
```

## Security notes

- `isSafeUrl` rejects private/reserved IPs and non-literal hostnames (use `validateUrlAsync` for DNS pinning).
- `SecretRotator.getActiveKey()` returns unmasked material only for **active** keys (audit fix 2.11).
- Coverage floor: **≥70% lines** (`docs/coverage-tiers.json` T0).

## Test

```bash
pnpm --filter @ghita/security exec vitest run --coverage
```
