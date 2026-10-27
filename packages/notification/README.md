# @ghita/notification

![Version](https://img.shields.io/badge/version-0.0.4-blue)

Notification system for Ghita Agent -- priority levels, channel routing, DND scheduling, history tracking, and templated notification delivery.

## Key Features

- **Priority levels** -- critical, high, normal, and low priority with distinct delivery behavior.
- **Channel routing** -- routes notifications to system tray, push, email, or in-app channels.
- **DND scheduling** -- Do Not Distend windows that batch non-critical notifications for later delivery.
- **Notification history** -- queryable log of all sent, delivered, and dismissed notifications.
- **Templated delivery** -- parameterized templates for task complete, error, and milestone alerts.

## Installation

```bash
pnpm install --filter @ghita/notification
```

## Usage

```typescript
import { NotificationManager, Priority } from '@ghita/notification';

const mgr = new NotificationManager();
await mgr.send({
  title: 'Task Complete',
  body: 'Agent finished refactoring',
  priority: Priority.Normal,
});
```

## API Docs

Generated via TypeDoc: `pnpm build:docs`
