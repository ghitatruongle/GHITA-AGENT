---
id: user-guide
title: User Guide
sidebar_label: User Guide
sidebar_position: 2
---

# User Guide

This guide walks you through everything you need to start using Ghita Agent — from first launch to advanced AI automation.

## Prerequisites

- **Node.js** ≥ 20.0.0
- **pnpm** 10.x or later
- **Rust** (for building the Tauri desktop shell)
- **Git** (for cloning the repository)

## Installation & First Launch

```bash
# 1. Clone the repository
git clone https://github.com/ghitatruongle/GHITA-AGENT
cd GHITA-AGENT

# 2. Install dependencies
pnpm install

# 3. Launch the desktop app in dev mode
pnpm dev:desktop
```

On first launch you will see a splash screen while the sidecar Node.js server starts. Once the React UI loads, the main window appears automatically.

## Configuring AI Providers

GHITA supports 10+ LLM providers out of the box. To get started:

1. Navigate to **Settings → API Keys** (or click the **API** tab in the sidebar).
2. Select your preferred provider (e.g., OpenAI, Anthropic, Google, Ollama).
3. Enter your API key and click **Save Configuration**.
4. For local models like **Ollama**, no API key is needed — just ensure Ollama is running locally.

### Multi-Key Rotation

You can add multiple API keys per provider for load balancing:

1. Click **Add Key** to add additional keys.
2. Choose a rotation strategy:
   - **Round Robin** — cycles through keys sequentially.
   - **Failover** — uses the first healthy key, falls back on error.
   - **Random** — randomly selects a key per request.

## Using the Chat Interface

The chat interface is your primary way to interact with the AI agent.

### Quick Commands

Type `/` in the chat input to see available slash commands:

| Command    | Description                                |
| ---------- | ------------------------------------------ |
| `/review`  | Run a code review on the active workspace  |
| `/feature` | Start developing a new feature             |
| `/deploy`  | Pre-deployment checks                      |
| `/compact` | Summarize and compact conversation context |
| `/clear`   | Clear conversation history                 |

### Tool Approval

When the AI agent wants to execute a system command or modify files, you'll see an **approval dialog**:

- **Authorize** — allow the tool to execute.
- **Deny Action** — block the action.

In **Auto mode**, non-destructive operations execute automatically, while dangerous operations (install, download, delete) still require confirmation.

## File Explorer & Code Editor

1. Click **Open Workspace Folder** in the File Explorer sidebar.
2. Browse, create, rename, and delete files/folders.
3. Open files in the built-in **Monaco Editor** with syntax highlighting.
4. Keyboard shortcuts:
   - `Ctrl+S` — Save current file
   - `Ctrl+Shift+S` — Save all files
   - `Ctrl+W` — Close current file

## Skill Management

Navigate to the **Skills** tab to see all available capabilities:

- **20+ built-in skills**: File operations, Git, Docker, HTTP, Database, Code formatting, Testing, Search, Deploy.
- Toggle skills on/off as needed.
- Run **Diagnostic Tests** to verify skill adapters are working.

## Agent Groups

Create specialized agent teams under the **Agents** tab:

1. Click **Create Group** and name your team.
2. Add agents with specific roles (coder, reviewer, planner, tester).
3. Delegate tasks to the group — agents collaborate using shared memory.

## Computer Use

The AI agent can control your desktop:

- **Mouse**: Click, move, drag at specific coordinates.
- **Keyboard**: Type text, press keys, use keyboard shortcuts.
- **Screenshots**: Capture the screen for visual understanding.

All interactions use native Rust implementations for low-latency performance (~10-30ms screenshot capture).

## Mobile Remote Control

Control GHITA from your Android phone:

1. Open the **Devices** tab on the desktop app.
2. Note the **IP Address** and **Port** displayed.
3. On your phone, open the GHITA mobile app and enter the connection details.
4. Enter the **6-character pairing code** when prompted.
5. Once paired, send commands and approve actions from your phone.

### Bluetooth Connection

Alternatively, connect via Bluetooth:

1. Switch to the Bluetooth tab on your phone.
2. Enter the **Computer Name** (hostname) displayed in the desktop app.
3. No IP or pairing code needed for Bluetooth connections.

## Dashboard & Monitoring

The **Dashboard** tab provides real-time metrics:

- **Token Usage**: Track total tokens consumed across providers.
- **Total Cost**: Monitor LLM spending with per-request cost breakdowns.
- **Active Agents**: See which agents are currently processing tasks.
- **MCP Connections**: View connected Model Context Protocol servers.
- **Context Memory**: Monitor context window usage with auto-compaction warnings.

## Workflow Builder

Design custom automation pipelines visually:

1. Navigate to the **Workflow** tab.
2. Drag action nodes onto the canvas (Start, Command, MCP Tool, Conditional, Loop, End).
3. Connect nodes by linking output ports to input ports.
4. Configure each node's parameters in the side panel.
5. Click **Start Pipeline** to execute.

## Troubleshooting

### Server Won't Start

```bash
# Kill any stuck processes
taskkill /f /im node.exe  # Windows
kill -9 $(lsof -ti:39001) # Linux/macOS

# Restart
pnpm dev:desktop
```

### API Key Issues

- Verify your key is valid by testing it directly with the provider's API.
- Check the **Dashboard** for error indicators next to your provider.
- Try rotating to a different key if rate-limited.

### Performance Tips

- Use **Ollama** for local inference to avoid API latency.
- Enable **context compaction** (`/compact`) for long conversations.
- Close unused terminal sessions to free resources.
