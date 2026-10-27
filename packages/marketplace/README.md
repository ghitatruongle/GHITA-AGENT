# @ghita/marketplace

![Version](https://img.shields.io/badge/version-0.1.0-blue)

Plugin marketplace for Ghita Agent -- install, uninstall, update, dependency resolution, and lockfile management for community and official plugins.

## Key Features

- **Plugin install/uninstall** -- fetch and manage plugins from the marketplace registry.
- **Dependency resolution** -- semver-based dependency solver with conflict detection.
- **Lockfile management** -- reproducible installs via a deterministic lockfile.
- **Analytics & revenue** -- tracks download counts and monetization metadata per plugin.
- **Pipeline updates** -- atomic update process with rollback on failure.

## Installation

```bash
pnpm install --filter @ghita/marketplace
```

## Usage

```typescript
import { MarketplaceRegistry } from '@ghita/marketplace';

const registry = new MarketplaceRegistry();
await registry.install('ghita-eslint-plugin');
const lockfile = registry.generateLockfile();
```

## API Docs

Generated via TypeDoc: `pnpm build:docs`
