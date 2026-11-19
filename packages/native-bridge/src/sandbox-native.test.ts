import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerNative } from './index.js';
import { tryDetectEnforcementNative } from './sandbox-native.js';

afterEach(() => vi.restoreAllMocks());

describe('tryDetectEnforcementNative', () => {
  it('returns a result with a valid enforcement tier', () => {
    // Addon sandbox có thể có hoặc không trên máy — kết quả phải là null
    // (fallback) hoặc object với tier hợp lệ.
    const r = tryDetectEnforcementNative();
    if (r === null) return; // addon vắng — hợp lệ
    expect(['landlock', 'seatbelt', 'restricted-token', 'supervised']).toContain(r.enforcement);
    expect(typeof r.available).toBe('boolean');
  });

  it('returns the native enforcement tier when registered', () => {
    registerNative('sandbox', {
      detectEnforcement: () => 'landlock',
      spawnSandboxed: () => null,
    });
    const r = tryDetectEnforcementNative();
    expect(r).not.toBe(null);
    expect(r?.enforcement).toBe('landlock');
    expect(r?.available).toBe(true);
  });

  it('maps supervised to available=false', () => {
    registerNative('sandbox', {
      detectEnforcement: () => 'supervised',
      spawnSandboxed: () => null,
    },
    );
    const r = tryDetectEnforcementNative();
    expect(r?.enforcement).toBe('supervised');
    expect(r?.available).toBe(false);
  });

  it('returns null when the addon throws', () => {
    registerNative('sandbox', {
      detectEnforcement: () => {
        throw new Error('boom');
      },
      spawnSandboxed: () => null,
    });
    expect(tryDetectEnforcementNative()).toBe(null);
  });
});
