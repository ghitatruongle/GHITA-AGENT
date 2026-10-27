# @ghita/migration

![Version](https://img.shields.io/badge/version-0.1.0-blue)

Data migration framework for the Ghita Agent -- schema versioning, incremental migrations, rollback support, and migration scripts for SQLite and filesystem stores.

## Key Features

- **Schema versioning** -- tracks database schema versions with automatic upgrade detection.
- **Incremental migrations** -- stepwise data transformations that can be replayed safely.
- **Rollback support** -- each migration has a corresponding down-migration for recovery.
- **Multi-store support** -- handles both SQLite databases and JSON filesystem stores.
- **Dry-run mode** -- preview migration effects before applying to production data.

## Installation

```bash
pnpm install --filter @ghita/migration
```

## Usage

```typescript
import { MigrationRunner } from '@ghita/migration';

const runner = new MigrationRunner({ dbPath: './ghita.db' });
await runner.run(); // applies all pending migrations
```

## API Docs

Generated via TypeDoc: `pnpm build:docs`
