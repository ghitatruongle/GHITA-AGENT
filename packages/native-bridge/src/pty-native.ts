// Native-first PTY bridge (0.0.2-alpha Track R1 P3): tryLoadPtyNative()
// resolves the ghita-pty napi addon (`crates/pty`, feature `addon`) so the
// Node sidecar can run agent commands through a real PTY (stream mode).
// When the addon is missing the caller keeps its buffered-spawn JS fallback —
// same pattern as sandbox-native.ts.

import { loadNative } from './index.js';

export interface PtySessionInfoNative {
  id: string;
  shell: string;
  cwd: string;
  pid: number | null;
}

export interface PtyNativeModule {
  /** Spawn a PTY session; output streams via the two callbacks (8KB/16ms batches). */
  ptySpawn(
    id: string,
    command: string,
    args: string[],
    cwd: string | null,
    cols: number,
    rows: number,
    onData: (id: string, data: string) => void,
    onExit: (id: string, exitCode: number | null, signal: number | null) => void,
  ): { id: string; pid: number | null };
  ptyWrite(id: string, data: string): void;
  ptyResize(id: string, cols: number, rows: number): void;
  /** Kill the session — console-aware process tree on Windows (PID-reuse guarded). */
  ptyKill(id: string): void;
  ptyKillAll(): void;
  ptyList(): PtySessionInfoNative[];
}

const UNAVAILABLE_FALLBACK: PtyNativeModule = {
  ptySpawn: () => {
    throw new Error('ghita-pty native addon is not available');
  },
  ptyWrite: () => {
    throw new Error('ghita-pty native addon is not available');
  },
  ptyResize: () => {
    throw new Error('ghita-pty native addon is not available');
  },
  ptyKill: () => {
    throw new Error('ghita-pty native addon is not available');
  },
  ptyKillAll: () => {
    throw new Error('ghita-pty native addon is not available');
  },
  ptyList: () => [],
};

export interface PtyNativeLoadResult {
  native: boolean;
  /** The addon API when `native` is true; `null` otherwise. */
  impl: PtyNativeModule | null;
  /** Reason when falling back. */
  reason?: string;
}

/**
 * Load the ghita-pty addon, mirroring loadNative('pty', fallback).
 * Consumers must treat `native: false` as "keep the JS buffered fallback".
 */
export function tryLoadPtyNative(): PtyNativeLoadResult {
  const loaded = loadNative<PtyNativeModule>('pty', UNAVAILABLE_FALLBACK);
  if (!loaded.native) {
    return { native: false, impl: null, reason: loaded.fallbackReason };
  }
  return { native: true, impl: loaded.impl };
}
