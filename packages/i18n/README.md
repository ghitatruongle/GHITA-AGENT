# @ghita/i18n

![Version](https://img.shields.io/badge/version-0.1.0-blue)

Internationalization layer for the Ghita Agent, providing locale detection, translation management, and dynamic language switching across all surfaces.

## Key Features

- **Locale detection & routing** -- auto-detects user locale and falls back gracefully.
- **Translation bundles** -- lazy-loaded translation files with key-based interpolation.
- **Dynamic language switching** -- change UI language at runtime without restart.
- **Pluralization & formatting** -- locale-aware number, date, and plural form handling.
- **Developer tooling** -- extraction script to find untranslated strings and generate keys.

## Installation

```bash
pnpm install --filter @ghita/i18n
```

## Usage

```typescript
import { i18n } from '@ghita/i18n';

await i18n.load('vi');
const greeting = i18n.t('common.greeting', { name: 'GHITA' });
```

## API Docs

Generated via TypeDoc: `pnpm build:docs`
