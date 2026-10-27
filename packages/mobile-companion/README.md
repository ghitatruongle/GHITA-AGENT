# @ghita/mobile-companion

![Version](https://img.shields.io/badge/version-0.1.0-blue)

Mobile companion package for Ghita Agent -- remote monitoring, task approval, notifications, and lightweight code review from iOS and Android devices.

## Key Features

- **Remote task monitoring** -- view agent progress and live logs from your phone.
- **Task approval workflow** -- approve or reject proposed changes without opening desktop.
- **Push notification routing** -- delivers critical alerts through the mobile notification channel.
- **Lightweight code review** -- diff viewer and comment support for quick mobile code reviews.
- **Secure pairing** -- token-based device linking with the desktop communication server.

## Installation

```bash
pnpm install --filter @ghita/mobile-companion
```

## Usage

```typescript
import { MobileCompanion } from '@ghita/mobile-companion';

const companion = new MobileCompanion();
await companion.connect('ws://desktop:3001');
companion.on('task:approval', (task) => task.approve());
```

## API Docs

Generated via TypeDoc: `pnpm build:docs`
