import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerNative } from '@ghita/native-bridge';
import { isRustEngineEnabled, tryNativeCompletion } from './rig-bridge.js';

afterEach(() => vi.restoreAllMocks());

describe('isRustEngineEnabled', () => {
  it('is false by default (GHITA_ENGINE unset)', () => {
    expect(isRustEngineEnabled({})).toBe(false);
  });

  it('is true only for GHITA_ENGINE=native', () => {
    expect(isRustEngineEnabled({ GHITA_ENGINE: 'native' })).toBe(true);
    expect(isRustEngineEnabled({ GHITA_ENGINE: 'off' })).toBe(false);
  });
});

describe('tryNativeCompletion', () => {
  it('returns null when flag off', async () => {
    const r = await tryNativeCompletion({ provider: 'openai', model: 'm', messages: [] });
    expect(r).toBe(null);
  });

  it('returns null when addon unavailable even with flag on', async () => {
    vi.stubEnv('GHITA_ENGINE', 'native');
    // loadNative('engine') probe thật — nếu máy có addon thì kết quả vẫn là
    // null khi provider không có key (make_client lỗi) → catch → null; nếu
    // addon vắng → null luôn. Cả hai nhánh đều phải null.
    const r = await tryNativeCompletion({ provider: 'openai', model: 'm', messages: [] });
    expect(r).toBe(null);
  });

  it('returns parsed usage when the addon returns a full response', async () => {
    vi.stubEnv('GHITA_ENGINE', 'native');
    registerNative('engine', {
      engineComplete: () =>
        Promise.resolve(
          JSON.stringify({
            text: 'hello',
            provider: 'openai',
            model: 'gpt-test',
            usage_in: 7,
            usage_out: 3,
          }),
        ),
      engineAvailable: () => true,
    });
    const r = await tryNativeCompletion({ provider: 'openai', model: 'gpt-test', messages: [] });
    expect(r).not.toBe(null);
    expect(r?.text).toBe('hello');
    expect(r?.usageIn).toBe(7);
    expect(r?.usageOut).toBe(3);
  });

  it('returns null and never throws on addon failure', async () => {
    vi.stubEnv('GHITA_ENGINE', 'native');
    registerNative('engine', {
      engineComplete: () => Promise.reject(new Error('boom')),
      engineAvailable: () => true,
    });
    const r = await tryNativeCompletion({ provider: 'openai', model: 'm', messages: [] });
    expect(r).toBe(null);
  });
});
