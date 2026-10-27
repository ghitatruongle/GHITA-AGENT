# @ghita/monitoring

![Version](https://img.shields.io/badge/version-0.0.3--beta2-blue)

Observability suite for Ghita Agent -- Sentry error monitoring, performance tracing, alert rules, and error grouping for production-grade reliability.

## Key Features

- **Sentry integration** -- captures and reports unhandled exceptions with full stack traces.
- **Performance tracing** -- measures latency across AI calls, agent steps, and file operations.
- **Alert rules** -- configurable thresholds for error rate, latency, and memory usage.
- **Error grouping** -- aggregates similar errors into groups for actionable dashboards.
- **Health dashboard** -- real-time system health metrics for the desktop application.

## Installation

```bash
pnpm install --filter @ghita/monitoring
```

## Usage

```typescript
import { ErrorMonitor, PerformanceTracer } from '@ghita/monitoring';

const monitor = new ErrorMonitor({ dsn: process.env.SENTRY_DSN });
const tracer = new PerformanceTracer();

tracer.start('agent:run');
// ... agent work ...
tracer.end('agent:run');
```

## API Docs

Generated via TypeDoc: `pnpm build:docs`
