import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerNative } from './index.js';
import { tryApplyPatchNative } from './patch.js';

afterEach(() => vi.restoreAllMocks());

describe('tryApplyPatchNative', () => {
  it('returns null when the patch addon is not built (JS fallback path)', () => {
    // Phải chạy trước khi có test nào registerNative('patch')
    expect(tryApplyPatchNative('*** Begin Patch...', '.')).toBe(null);
  });

  it('returns the native summary when the addon is registered', () => {
    registerNative('patch', {
      applyPatch: () => ({ applied: ['a.txt'], skipped: [], partial: false }),
      patchAvailable: () => true,
    });
    const r = tryApplyPatchNative('*** Begin Patch...', '.');
    expect(r).not.toBe(null);
    expect(r?.applied).toEqual(['a.txt']);
  });

  it('returns null when the native addon throws', () => {
    registerNative('patch', {
      applyPatch: () => {
        throw new Error('boom');
      },
      patchAvailable: () => true,
    });
    expect(tryApplyPatchNative('*** Begin Patch...', '.')).toBe(null);
  });
});
