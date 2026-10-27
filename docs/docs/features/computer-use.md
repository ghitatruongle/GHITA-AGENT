---
id: computer-use
title: Computer Use
sidebar_label: Computer Use
sidebar_position: 3
---

# Computer Use

Ghita Agent can control your desktop — mouse, keyboard, screenshots, and terminal — through its native Rust Computer Use module.

## Architecture

The Computer Use system is implemented in **Rust** (not Node.js) for maximum performance:

```
┌──────────────────────────────────────────────────┐
│  TypeScript Layer (packages/computer-use)         │
│  TauriOperator ←→ Tauri IPC ←→ Rust Backend      │
└──────────────────────────────────────────────────┘
                    │
┌──────────────────────────────────────────────────┐
│  Rust Native Layer (apps/desktop/src-tauri)       │
│  ┌─────────────┐  ┌─────────────┐                │
│  │ screenshots  │  │ enigo       │                │
│  │ (GDI/X11)   │  │ (SendInput) │                │
│  └─────────────┘  └─────────────┘                │
│  ┌─────────────┐  ┌─────────────┐                │
│  │ image       │  │ portable_pty│                │
│  │ (Lanczos3)  │  │ (ConPTY)    │                │
│  └─────────────┘  └─────────────┘                │
└──────────────────────────────────────────────────┘
```

## Screenshot Capture

### Performance

| Method                            | Latency   | Notes               |
| --------------------------------- | --------- | ------------------- |
| Rust native (`screenshots` crate) | ~10-30ms  | Production default  |
| PowerShell child_process (legacy) | ~500ms    | Replaced in Phase 1 |
| Node.js sharp bridge (legacy)     | ~50-100ms | Replaced in Phase 1 |

### Features

- **PNG & JPEG output**: Configurable via `mime_type` parameter.
- **Adaptive resize**: `max_edge` parameter downscales large displays using Lanczos3 filter.
- **DPI awareness**: Returns `scale_factor` for HiDPI display compensation.
- **Base64 encoding**: Screenshots are returned as base64-encoded data for efficient IPC transport.

### API

```typescript
// Capture screenshot with optional resize
const result = await invoke('computer_screenshot', {
  maxEdge: 1920, // Optional: clamp longest edge
  mimeType: 'image/jpeg', // 'image/png' (default) or 'image/jpeg'
  quality: 0.85, // JPEG quality 0.0-1.0 (ignored for PNG)
});
// Returns: { mimeType, data (base64), size: { width, height }, scaleFactor }
```

## Input Control

### Mouse Operations

```typescript
// Move cursor to absolute coordinates
await invoke('computer_move_mouse', { x: 500, y: 300 });

// Click at position with optional button
await invoke('computer_click', {
  point: { x: 500, y: 300 },
  button: 'left', // 'left' | 'right' | 'middle'
});
```

### Keyboard Operations

```typescript
// Type a string of text
await invoke('computer_type_text', { text: 'Hello, World!' });

// Press a single key
await invoke('computer_press_key', { key: 'Enter' });
// Supported: Enter, Escape, Tab, Space, Backspace, Delete,
// Arrow keys, F1-F12, Shift, Ctrl, Alt, Meta, CapsLock, etc.
```

### Key Name Resolution

The system accepts multiple aliases for common keys:

| Key          | Accepted Names                           |
| ------------ | ---------------------------------------- |
| Enter        | `Enter`, `Return`, `enter`, `return`     |
| Control      | `Control`, `Ctrl`, `ctrl`, `control`     |
| Meta/Windows | `Meta`, `Command`, `Cmd`, `Win`, `Super` |
| Escape       | `Escape`, `Esc`, `esc`                   |

## Terminal PTY

The native terminal uses the `portable-pty` Rust crate for cross-platform pseudo-terminal support:

- **Windows**: ConPTY (Windows 10 1809+)
- **Linux/macOS**: POSIX PTY

### Features

- **Session management**: Create, write, resize, kill, and list terminal sessions.
- **Ghost thread detection**: Generation counter prevents stale reader threads from emitting events after session recreation.
- **Batched output**: Output is buffered and flushed in 16ms intervals (~60fps) to avoid flooding the Tauri event loop.
- **Idle monitoring**: Sessions idle for >120s are logged for diagnostics (but not killed).
- **Focus event filtering**: xterm.js focus events (`\x1b[I`, `\x1b[O`) are silently filtered.

### API

```typescript
// Create a new terminal session
const session = await invoke('terminal_create', {
  id: 'term_1',
  shellType: 'powershell', // 'powershell' | 'cmd' | 'bash' | 'sh'
  cols: 120,
  rows: 40,
  cwd: 'C:\\Projects',
});

// Write to terminal stdin
await invoke('terminal_write', { id: 'term_1', data: 'dir\r\n' });

// Resize terminal
await invoke('terminal_resize', { id: 'term_1', cols: 200, rows: 50 });

// Kill session
await invoke('terminal_kill', { id: 'term_1' });

// List active sessions
const sessions = await invoke('terminal_list');
```

### Events

The terminal emits Tauri events that the frontend listens to:

- `terminal-data`: New output from the PTY (batched).
- `terminal-exit`: Session has ended with an optional exit code.

## Health Check

```typescript
const health = await invoke('computer_health_check');
// Returns: { ready, kind, checkedAt, screenshot, input }
```

## Security Considerations

- All screenshot data stays local (base64 in-process, no disk writes).
- Input control requires explicit Tauri capability grants.
- Terminal sessions run under the user's own OS permissions.
- Shell argument escaping prevents injection attacks.
