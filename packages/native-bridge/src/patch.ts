// Native-first patch application (v0.0.2-preview T2): `tryApplyPatchNative`
// resolves the ghita-patch napi addon and applies a codex V4A unified diff.
// Returns null when the addon is unavailable or fails — callers keep their
// existing edit flow (JS fallback = existing edit flow, not a JS patch engine).

import { loadNative } from './index.js';

export interface PatchSummary {
  /** Relative paths of files successfully patched. */
  applied: string[];
  /** Files rejected (context mismatch etc.). */
  skipped: string[];
  /** true khi vừa có file áp được vừa có file bị từ chối. */
  partial: boolean;
}

interface NativePatchModule {
  applyPatch(patchText: string, cwd: string): PatchSummary;
  patchAvailable(): boolean;
}

const FALLBACK: NativePatchModule = {
  applyPatch: () => ({ applied: [], skipped: [], partial: false }),
  patchAvailable: () => false,
};

export function tryApplyPatchNative(patchText: string, cwd: string): PatchSummary | null {
  const loaded = loadNative<NativePatchModule>('patch', FALLBACK);
  if (!loaded.native) return null;
  try {
    return loaded.impl.applyPatch(patchText, cwd);
  } catch {
    return null;
  }
}
