# @ghita/a11y

![Version](https://img.shields.io/badge/version-0.1.0-blue)

Accessibility toolkit for the Ghita Agent, providing WCAG compliance checks, screen-reader support, and keyboard navigation helpers across desktop and web surfaces.

## Key Features

- **WCAG compliance auditing** -- automated checks for contrast, alt text, and ARIA attributes.
- **Screen-reader integration** -- semantic labeling and live-region announcements for the Tauri desktop UI.
- **Keyboard navigation helpers** -- focus traps, skip links, and tab-order utilities.
- **Theme-aware contrast validation** -- ensures light/dark themes meet minimum contrast ratios.
- **Accessibility test harness** -- reusable assertions for component-level accessibility testing.

## Installation

```bash
pnpm install --filter @ghita/a11y
```

## Usage

```typescript
import { audit, contrastCheck } from '@ghita/a11y';

const report = await audit(window.document);
const passes = contrastCheck('#1a1a2e', '#e2e2e2'); // WCAG AA
```

## API Docs

Generated via TypeDoc: `pnpm build:docs`
