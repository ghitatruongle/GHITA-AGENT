# @ghita/shared

![Version](https://img.shields.io/badge/version-0.1.0-blue)

Shared types, constants, utilities, and common infrastructure for the Ghita Agent monorepo -- the foundational package consumed by all other packages.

## Key Features

- **Type definitions** -- shared TypeScript interfaces for agents, tasks, messages, and plugins.
- **Constants & enums** -- centralized constants for error codes, event names, and config keys.
- **Logger** -- structured logging with levels, context tags, and transport abstraction.
- **Utility functions** -- common helpers for path resolution, deep cloning, retries, and validation.
- **Tree-sitter integration** -- web-tree-sitter bindings shared across code analysis packages.

## Installation

```bash
pnpm install --filter @ghita/shared
```

## Usage

```typescript
import { AgentStatus, TaskPriority, Logger } from '@ghita/shared';

const logger = new Logger('my-module');
logger.info('Agent started', { status: AgentStatus.Running });
```

## API Docs

Generated via TypeDoc: `pnpm build:docs`
