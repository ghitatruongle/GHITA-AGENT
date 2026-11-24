// Track R1 P3: run_command stream-mode tests — opt-in via GHITA_AGENT_PTY_STREAM,
// real PTY path through a registered fake addon, buffered fallback when the
// addon is missing, approval flow intact on both paths.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerNative,
  unregisterNative,
  isAddonBuilt,
  type PtyNativeModule,
} from '@ghita/native-bridge';
import { runCommand } from './workspace-tools.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-pty-stream-'));
  (globalThis as Record<string, unknown>).ghitaWorkspaceRoot = root;
});

function fakePty(overrides: Partial<PtyNativeModule> = {}): PtyNativeModule {
  return {
    ptySpawn: (id, _command, _args, _cwd, _cols, _rows, onData, onExit) => {
      onData(id, 'PTY_STREAM_OK\r\n');
      onExit(id, 0, null);
      return { id, pid: 1234 };
    },
    ptyWrite: () => {},
    ptyResize: () => {},
    ptyKill: () => {},
    ptyKillAll: () => {},
    ptyList: () => [],
    ...overrides,
  };
}

const tests: Record<string, unknown> = globalThis as unknown as Record<string, unknown>;

afterEach(() => {
  unregisterNative('pty');
  delete process.env['GHITA_AGENT_PTY_STREAM'];
  delete (tests as { commandStreamHandler?: unknown }).commandStreamHandler;
  delete (tests as { ghitaWorkspaceRoot?: unknown }).ghitaWorkspaceRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('run_command stream mode (opt-in, Track R1 P3)', () => {
  it('runs through the PTY addon when the opt-in flag is set and the addon is present', async () => {
    process.env['GHITA_AGENT_PTY_STREAM'] = '1';
    const chunks: string[] = [];
    tests.commandStreamHandler = (id: string, chunk: string) => chunks.push(`${id}:${chunk}`);
    registerNative('pty', fakePty());

    const out = await runCommand({ command: 'echo PTY_STREAM_OK' });
    expect(out).toContain('PTY_STREAM_OK');
    expect(out).not.toContain('STDOUT:'); // PTY path merges streams — no buffered layout
    expect(chunks.length).toBeGreaterThan(0); // incremental hook received chunks
  });

  it('falls back to the buffered spawn when the addon fails to spawn', async () => {
    process.env['GHITA_AGENT_PTY_STREAM'] = '1';
    // Broken addon: ptySpawn throws synchronously → runViaPty resolves null
    // and runCommand must keep the buffered shell path.
    registerNative(
      'pty',
      fakePty({
        ptySpawn: () => {
          throw new Error('broken addon');
        },
      }),
    );

    const out = await runCommand({ command: 'echo BUFFERED_FALLBACK_OK' });
    expect(out).toContain('BUFFERED_FALLBACK_OK');
  });

  it('runs the real ghita-pty addon when built and opt-in flag is set (no fake registered)', async () => {
    // Skip when the addon has not been built on this machine — the loader
    // contract for that case is covered in native-bridge pty-native.test.ts.
    if (!isAddonBuilt('pty')) return;
    process.env['GHITA_AGENT_PTY_STREAM'] = '1';

    const out = await runCommand({ command: 'echo REAL_PTY_OK' });
    expect(out).toContain('REAL_PTY_OK');
  }, 20_000);

  it('keeps the buffered spawn as default when the flag is unset (even with addon present)', async () => {
    registerNative('pty', fakePty());
    // No GHITA_AGENT_PTY_STREAM → buffered path regardless of addon.

    const out = await runCommand({ command: 'echo BUFFERED_DEFAULT_OK' });
    expect(out).toContain('BUFFERED_DEFAULT_OK');
  });

  it('keeps the approval flow in front of the stream path', async () => {
    process.env['GHITA_AGENT_PTY_STREAM'] = '1';
    registerNative('pty', fakePty());
    tests.agentPermissionMode = 'custom';
    tests.approveCommandHandler = async () => false;
    try {
      await expect(runCommand({ command: 'echo PTY_STREAM_OK' })).rejects.toThrow(
        /Permission Denied|rejected/,
      );
    } finally {
      tests.agentPermissionMode = 'auto';
      tests.approveCommandHandler = null;
    }
  });
});
