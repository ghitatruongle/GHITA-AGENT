# @ghita/quotas

![Version](https://img.shields.io/badge/version-0.0.3--beta1-blue)

Rate limiting and quota management for Ghita Agent -- per-user token budgets, API call rate limits, overage billing, and usage dashboards.

## Key Features

- **Token quotas** -- enforces per-agent and per-session token consumption limits.
- **Rate limiting** -- sliding-window and fixed-window rate limiters for API endpoints.
- **Overage billing** -- tracks and reports usage beyond free-tier quotas for billing.
- **Usage dashboard** -- real-time visualization of quota consumption across providers.
- **Configurable tiers** -- supports free, pro, and enterprise quota tiers with different limits.

## Installation

```bash
pnpm install --filter @ghita/quotas
```

## Usage

```typescript
import { QuotaManager } from '@ghita/quotas';

const quotas = new QuotaManager({ tier: 'pro' });
const allowed = await quotas.check('api:openai', { tokens: 4000 });
if (allowed) await quotas.consume('api:openai', { tokens: 4000 });
```

## API Docs

Generated via TypeDoc: `pnpm build:docs`
