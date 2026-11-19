// Native-first sandbox detection (v0.0.2-preview T3): tryDetectEnforcementNative
// hỏi enforcement tier thật từ ghita-sandbox addon. Returns null when the addon
// is unavailable → caller keeps supervised semantics (JS fallback = luồng cũ).

import { loadNative } from './index.js';

export type EnforcementTier = 'landlock' | 'seatbelt' | 'restricted-token' | 'supervised';

export interface SandboxDetectResult {
  enforcement: EnforcementTier;
  available: boolean;
}

interface NativeSandboxModule {
  detectEnforcement(): string;
  spawnSandboxed(
    command: string,
    args: string[],
    options: Record<string, unknown> | null,
  ): { enforcement: string } | null;
}

const FALLBACK: NativeSandboxModule = {
  detectEnforcement: () => 'supervised',
  spawnSandboxed: () => null,
};

export function tryDetectEnforcementNative(): SandboxDetectResult | null {
  const loaded = loadNative<NativeSandboxModule>('sandbox', FALLBACK);
  if (!loaded.native) return null;
  try {
    const enforcement = loaded.impl.detectEnforcement() as EnforcementTier;
    return { enforcement, available: enforcement !== 'supervised' };
  } catch {
    return null;
  }
}

export function tryRunSandboxedNative(
  profile: string,
  program: string,
  args: string[],
  cwd: string,
): unknown | null {
  const loaded = loadNative<NativeSandboxModule>('sandbox', FALLBACK);
  if (!loaded.native) return null;
  try {
    return loaded.impl.spawnSandboxed(program, args, {
      profile,
      workspace: cwd,
    });
  } catch {
    return null;
  }
}
