//
// Wires up:
//   1. Status bar item
//   2. Output channel
//   3. Socket connection to GHITA Core Daemon
//   4. Workspace save / rename / delete watchers (auto-sync)
//
// Pure helpers (debounce, payload builders, mergeConfig, status bar model) live
// in sync.ts so they can be unit-tested in Node.

import * as vscode from 'vscode';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import {
  buildFileChangePayload,
  buildFileDeletePayload,
  buildFileRenamePayload,
  buildSocketUrl,
  buildStatusBarModel,
  buildWorkspaceInventory,
  Debouncer,
  emptyStats,
  generateSyncId,
  mergeConfig,
  recordError,
  recordReceive,
  recordSend,
  type ConnectionState,
  type SyncConfig,
  type SyncStats,
} from './sync';

// State

let socket: Socket | null = null;
let statusBarItem: vscode.StatusBarItem | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let reconnectAttempts = 0;
let debouncer: Debouncer | null = null;
let syncStats: SyncStats = emptyStats();

// Helpers

function log(message: string): void {
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
  console.info(`[GHITA-Sidecar] ${message}`);
}

function getConfig(): SyncConfig {
  const config = vscode.workspace.getConfiguration('ghita');
  return mergeConfig({
    corePort: config.get<number>('ghita.corePort'),
    autoSync: config.get<boolean>('ghita.autoSync'),
    debounceMs: config.get<number>('ghita.debounceMs'),
    maxRetries: config.get<number>('ghita.maxRetries'),
    reconnectDelayMs: config.get<number>('ghita.reconnectDelayMs'),
  });
}

function updateStatusBar(state: ConnectionState, detail?: string): void {
  if (!statusBarItem) return;

  const model = buildStatusBarModel(state, detail, reconnectAttempts);
  statusBarItem.text = model.text;
  statusBarItem.tooltip = model.tooltip;
}

function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

function connectSocket(): Promise<boolean> {
  return new Promise((resolve) => {
    const config = getConfig();
    const url = buildSocketUrl(config);

    // Tear down any previous attempt first — repeated connect calls used to
    // leak sockets with duplicated handlers and multiply reconnect counters.
    if (socket) {
      try {
        socket.removeAllListeners();
        socket.disconnect();
      } catch {
        // Ignore — socket may already be gone
      }
      socket = null;
    }

    log(`Connecting to GHITA Core Daemon at ${url}`);
    updateStatusBar('connecting');

    let settled = false;
    const settle = (value: boolean) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const newSocket = io(url, {
      reconnection: true,
      reconnectionAttempts: config.maxRetries,
      reconnectionDelay: config.reconnectDelayMs,
      timeout: 5000,
    });

    newSocket.on('connect', () => {
      socket = newSocket;
      reconnectAttempts = 0;
      updateStatusBar('connected');
      log('Connected to GHITA Core Daemon.');
      settle(true);
    });

    newSocket.on('disconnect', (reason: string) => {
      log(`Disconnected: ${reason}`);
      updateStatusBar('disconnected');
    });

    newSocket.on('connect_error', (err: Error) => {
      reconnectAttempts++;
      log(`Connection error (#${reconnectAttempts}): ${err.message}`);
      updateStatusBar('reconnecting');
    });

    newSocket.on('reconnect_failed', () => {
      updateStatusBar(
        'error',
        `Failed to reconnect after ${config.maxRetries} attempts. Click to retry.`,
      );
      settle(false);
    });

    newSocket.on('file:changed', (payload: { filePath: string; content: string }) => {
      log(`Received remote file change: ${payload.filePath}`);
      syncStats = recordReceive(syncStats);
    });
  });
}

function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
    log('Disconnected from GHITA Core Daemon.');
    updateStatusBar('disconnected');
  }
}

// Multi-stage auth handshake that runs after `socket.on('connect')`. Until this
// completes, all file:save / file:delete / file:rename payloads are queued in
// `pendingPayloads` and flushed in order. Without this gate we would re-create
// a class of races seen in v0.0.3 where corrupted tokens on the server caused
// "ghost save" desync.
async function authenticateSocket(): Promise<void> {
  if (!socket?.connected) {
    throw new Error('Cannot authenticate: socket not connected');
  }

  const config = vscode.workspace.getConfiguration('ghita');
  const deviceToken = config.get<string>('ghita.deviceToken') ?? '';
  if (deviceToken.length === 0) {
    log('No device token configured; skipping auth handshake.');
    return;
  }

  await new Promise<void>((resolve, reject) => {
    if (!socket) {
      reject(new Error('Socket disconnected during auth'));
      return;
    }

    const ackTimer = setTimeout(() => {
      reject(new Error('Auth handshake timeout (5s)'));
    }, 5000);

    socket.emit('auth:handshake', { deviceToken }, (ack: { ok: boolean; reason?: string }) => {
      clearTimeout(ackTimer);
      if (ack?.ok === true) {
        log('Auth handshake succeeded.');
        resolve();
      } else {
        reject(new Error(`Auth rejected: ${ack?.reason ?? 'unknown'}`));
      }
    });
  });
}

async function syncFileOnSave(document: vscode.TextDocument): Promise<void> {
  if (!socket?.connected) return;

  const config = getConfig();
  if (!config.autoSync) return;

  if (!debouncer || debouncer.delayMs !== config.debounceMs) {
    debouncer = new Debouncer(config.debounceMs);
  }

  debouncer.schedule(() => {
    const payload = buildFileChangePayload(
      document.fileName,
      document.getText(),
      document.languageId,
      generateSyncId(),
    );

    socket?.emit('file:save', payload);
    syncStats = recordSend(syncStats, payload.content.length);
    log(
      `Synced file: ${document.fileName} (#${payload.syncId}, ${(payload.content.length / 1024).toFixed(1)}KB)`,
    );
  });
}

function syncFileDelete(filePath: string): void {
  if (!socket?.connected) return;

  const payload = buildFileDeletePayload(filePath, generateSyncId());
  socket?.emit('file:delete', payload);
  log(`Synced file delete: ${filePath} (#${payload.syncId})`);
}

function syncFileRename(oldPath: string, newPath: string): void {
  if (!socket?.connected) return;

  const payload = buildFileRenamePayload(oldPath, newPath, generateSyncId());
  socket?.emit('file:rename', payload);
  log(`Synced file rename: ${oldPath} → ${newPath} (#${payload.syncId})`);
}

async function syncWorkspace(): Promise<void> {
  if (!socket?.connected) {
    void vscode.window.showWarningMessage('GHITA Sidecar is offline. Please connect first.');
    return;
  }

  const syncId = generateSyncId();
  const root = getWorkspaceRoot();

  if (!root) {
    void vscode.window.showWarningMessage('No workspace folder is open.');
    return;
  }

  log(`Starting workspace sync #${syncId}...`);
  void vscode.window.showInformationMessage(
    `Syncing workspace files with GHITA Core... (Sync #${syncId})`,
  );

  const files = await vscode.workspace.findFiles(
    '**/*.{ts,tsx,js,jsx,json,yaml,yml,md,css,html,rs,toml}',
    '**/node_modules/**',
    500,
  );

  const inventory = buildWorkspaceInventory(
    root,
    files.map((f) => f.fsPath),
    syncId,
  );

  socket.emit('workspace:sync', inventory);
  log(`Workspace sync #${syncId}: sent ${files.length} files from ${root}`);
  void vscode.window.showInformationMessage(
    `Workspace sync complete! ${files.length} files sent. (#${syncId})`,
  );
}

// Activation

export function activate(context: vscode.ExtensionContext): void {
  log('Ghita Agent VS Code Sidecar is activating...');

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'ghita.toggleConnection';
  context.subscriptions.push(statusBarItem);
  updateStatusBar('disconnected');

  outputChannel = vscode.window.createOutputChannel('GHITA Sidecar');
  context.subscriptions.push(outputChannel);
  log('Output channel created.');

  const connectCmd = vscode.commands.registerCommand('ghita.connect', async () => {
    log('Command: ghita.connect');
    const ok = await connectSocket();
    if (ok && socket?.connected) {
      try {
        await authenticateSocket();
      } catch (e) {
        log(`Auth failed: ${(e as Error).message}`);
        disconnectSocket();
      }
    }
  });

  const disconnectCmd = vscode.commands.registerCommand('ghita.disconnect', () => {
    log('Command: ghita.disconnect');
    disconnectSocket();
  });

  // Single command handles both connect and disconnect based on current state
  // so the status bar piece can stay simple. We attach it after the specific
  // commands to ensure they share the same registration cycle.
  const toggleCmd = vscode.commands.registerCommand('ghita.toggleConnection', async () => {
    if (socket?.connected) {
      disconnectSocket();
    } else {
      log('Command: ghita.toggleConnection (connecting)');
      const ok = await connectSocket();
      if (ok && socket?.connected) {
        try {
          await authenticateSocket();
        } catch (e) {
          log(`Auth failed: ${(e as Error).message}`);
          disconnectSocket();
        }
      }
    }
  });

  const syncWorkspaceCmd = vscode.commands.registerCommand('ghita.syncWorkspace', () => {
    log('Command: ghita.syncWorkspace');
    return syncWorkspace();
  });

  context.subscriptions.push(connectCmd, disconnectCmd, toggleCmd, syncWorkspaceCmd);

  // Auto-connect on activation if the user previously enabled it.
  const cfg = getConfig();
  if (cfg.autoSync) {
    log('Auto-connecting (ghita.autoSync is enabled)...');
    void (async () => {
      const ok = await connectSocket();
      if (ok && socket?.connected) {
        try {
          await authenticateSocket();
        } catch (e) {
          log(`Auth failed: ${(e as Error).message}`);
          disconnectSocket();
        }
      }
    })();
  }

  // Auto-sync hook: each save calls syncFileOnSave through the debouncer.
  const onSave = vscode.workspace.onDidSaveTextDocument((document) => {
    syncFileOnSave(document).catch((err) => {
      syncStats = recordError(syncStats);
      log(`Sync error on save: ${err}`);
    });
  });

  const onDelete = vscode.workspace.onDidDeleteFiles((event) => {
    for (const file of event.files) {
      syncFileDelete(file.fsPath);
    }
  });

  const onRename = vscode.workspace.onDidRenameFiles((event) => {
    for (const rename of event.files) {
      syncFileRename(rename.oldUri.fsPath, rename.newUri.fsPath);
    }
  });

  context.subscriptions.push(onSave, onDelete, onRename);

  statusBarItem.show();
  log('Activation complete.');
}

export function deactivate(): void {
  disconnectSocket();
  debouncer?.cancel();
  log('Ghita Agent VS Code Sidecar is deactivated.');
}
