# @ghita/gui

![Version](https://img.shields.io/badge/version-0.0.4-blue)

Tauri window management and desktop UI infrastructure for Ghita Agent -- persistence, tray icons, global shortcuts, theme switching, and dialog management.

## Key Features

- **Window management** -- multi-window layout presets, split panes, and resizable panels.
- **State persistence** -- saves and restores window geometry, open files, and UI preferences.
- **System tray integration** -- tray icon with context menu for quick actions and status display.
- **Global shortcuts** -- configurable hotkeys for agent control, even when the window is minimized.
- **Theme switching** -- light/dark/system theme toggle with smooth transitions.

## Installation

```bash
pnpm install --filter @ghita/gui
```

## Usage

```typescript
import { WindowManager, ThemeManager } from '@ghita/gui';

const wm = new WindowManager();
await wm.restore();
ThemeManager.setTheme('dark');
```

## API Docs

Generated via TypeDoc: `pnpm build:docs`
