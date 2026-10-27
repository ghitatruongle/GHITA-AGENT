# @ghita/computer-use

![Version](https://img.shields.io/badge/version-0.1.0-blue)

Desktop automation engine for Ghita Agent, providing screen capture, UI interaction, sandboxed execution, and vision-guided action parsing via Tauri-native Rust backend.

## Key Features

- **Screen capture & vision** -- real-time screenshot capture with UI-TARS vision model integration.
- **Action parsing** -- translates natural-language instructions into mouse, keyboard, and clipboard actions.
- **Sandboxed execution** -- Docker-based sandbox for safely running untrusted commands and scripts.
- **Guardrails** -- input validation and policy enforcement before any OS-level action is performed.
- **Operator plugins** -- extensible operator system for different desktop interaction backends.

## Installation

```bash
pnpm install --filter @ghita/computer-use
```

## Usage

```typescript
import { ComputerUseOperator } from '@ghita/computer-use';

const op = new ComputerUseOperator();
const screenshot = await op.captureScreen();
await op.click({ x: 100, y: 200 });
```

## API Docs

Generated via TypeDoc: `pnpm build:docs`
