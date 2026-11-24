import { describe, it, expect, afterEach } from 'vitest';
import { registerNative, unregisterNative, isAddonBuilt } from './index.js';
import { tryLoadPtyNative, type PtyNativeModule } from './pty-native.js';

const FAKE_PTY: PtyNativeModule = {
  ptySpawn: () => ({ id: 't1', pid: 42 }),
  ptyWrite: () => {},
  ptyResize: () => {},
  ptyKill: () => {},
  ptyKillAll: () => {},
  ptyList: () => [{ id: 't1', shell: 'cmd.exe', cwd: '.', pid: 42 }],
};

afterEach(() => unregisterNative('pty'));

describe('tryLoadPtyNative', () => {
  it('returns native=true with the registered addon', () => {
    registerNative('pty', FAKE_PTY);
    const r = tryLoadPtyNative();
    expect(r.native).toBe(true);
    expect(r.impl).not.toBe(null);
    expect(
      r.impl?.ptySpawn(
        't1',
        'cmd.exe',
        [],
        null,
        80,
        24,
        () => {},
        () => {},
      ),
    ).toEqual({
      id: 't1',
      pid: 42,
    });
    expect(r.impl?.ptyList()).toHaveLength(1);
  });

  it('returns native=false with impl=null when the addon is missing (JS fallback signal)', () => {
    // Only reliable when no compiled pty addon exists on disk.
    if (isAddonBuilt('pty')) return; // addon built — fallback branch not reachable
    const r = tryLoadPtyNative();
    expect(r.native).toBe(false);
    expect(r.impl).toBe(null);
    expect(r.reason).toContain('pty');
  });

  it('aggregates exit shape {exitCode, signal} parity contract on the spawn callback', () => {
    const exitArgs: Array<[string, number | null, number | null]> = [];
    registerNative('pty', {
      ...FAKE_PTY,
      ptySpawn: (_id, _cmd, _args, _cwd, _cols, _rows, _onData, onExit) => {
        onExit('t1', 0, null);
        return { id: 't1', pid: 42 };
      },
    });
    const r = tryLoadPtyNative();
    expect(r.native).toBe(true);
    r.impl?.ptySpawn(
      't1',
      'sh',
      ['-c', 'true'],
      null,
      80,
      24,
      () => {},
      (id, code, signal) => exitArgs.push([id, code, signal]),
    );
    expect(exitArgs).toEqual([['t1', 0, null]]);
  });
});
