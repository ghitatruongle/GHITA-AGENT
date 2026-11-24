// Track S2 P2 — registry wiring: Kimi / MiniMax / DeepSeek dedicated vendor
// classes are reachable through ProviderRegistry (previously kimi/minimax hit
// the default throw at registry.ts:118 and deepseek fell back to the
// CustomProvider shim).

import { describe, it, expect } from 'vitest';
import { ProviderRegistry } from '../src/registry.js';
import { KimiProvider } from '../src/providers/kimi.js';
import { MiniMaxProvider } from '../src/providers/minimax.js';
import { DeepSeekProvider } from '../src/providers/deepseek.js';
import { CustomProvider } from '../src/providers/custom.js';

describe('ProviderRegistry — Track S2 vendor wiring', () => {
  it('creates Kimi as its dedicated vendor provider', () => {
    const reg = new ProviderRegistry();
    const p = reg.registerFromConfig({ type: 'kimi', apiKey: 'k' });
    expect(p).toBeInstanceOf(KimiProvider);
    expect(p.type).toBe('kimi');
    expect(p.name).toContain('Kimi');
    expect(p.defaultModel).toBe('moonshot-v1-8k');
  });

  it('creates MiniMax as its dedicated vendor provider', () => {
    const reg = new ProviderRegistry();
    const p = reg.registerFromConfig({ type: 'minimax', apiKey: 'k' });
    expect(p).toBeInstanceOf(MiniMaxProvider);
    expect(p.type).toBe('minimax');
    expect(p.defaultModel).toBe('minimax-v1');
  });

  it('creates DeepSeek as its dedicated vendor provider (not the CustomProvider shim)', () => {
    const reg = new ProviderRegistry();
    const p = reg.registerFromConfig({ type: 'deepseek', apiKey: 'k' });
    expect(p).toBeInstanceOf(DeepSeekProvider);
    expect(p).not.toBeInstanceOf(CustomProvider);
    expect(p.type).toBe('deepseek');
    expect(p.defaultModel).toBe('deepseek-chat');
  });

  it('still throws for genuinely unknown provider types', () => {
    const reg = new ProviderRegistry();
    expect(() =>
      reg.registerFromConfig({ type: 'no-such-provider' as never, apiKey: 'k' }),
    ).toThrow(/Unknown provider type/);
  });

  it('DeepSeek vendor speaks the openai-compat wire with its own chat URL', async () => {
    const { vi } = await import('vitest');
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            model: 'deepseek-chat',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const reg = new ProviderRegistry();
      const p = reg.registerFromConfig({ type: 'deepseek', apiKey: 'k' });
      await p.chat([{ role: 'user', content: 'hi' }]);
      const [url] = fetchMock.mock.calls[0] as unknown as [string];
      expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    } finally {
      vi.restoreAllMocks();
    }
  });
});
