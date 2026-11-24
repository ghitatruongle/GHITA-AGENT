// Track S2 P3 — retry ladder, AgentError canonical shape, KeyGate FIFO/exclude.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AgentError,
  AIBudgetExceededError,
  AIInvalidConfigError,
  AINoProviderError,
  AIRateLimitError,
  AITimeoutError,
} from '../src/errors/index.js';
import {
  runChatRetryLadder,
  createRetryLadderState,
  SYNTHETIC_FOLLOW_UP_PROMPT,
  MAX_SYNTHETIC_FOLLOW_UPS,
  MAX_KEY_SWITCHES,
  type RetryLadderDeps,
} from '../src/orchestrator/retry-ladder.js';
import { orchestratorChat, orchestratorChatStream } from '../src/orchestrator/chat.js';
import type { OrchestratorContext } from '../src/orchestrator/types.js';
import { ProviderRegistry } from '../src/registry.js';
import { KeyGate } from '../src/credentials/key-gate.js';
import { KeyManager } from '../src/key-manager.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import type { ChatMessage, ChatResponse } from '../src/types.js';

const okResponse = (content = 'answer'): ChatResponse => ({
  content,
  model: 'm',
  provider: 'openai',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  finishReason: 'stop',
});

// --- AgentError canonical shape ---

describe('AgentError.from — canonical classification', () => {
  it('classifies rate limits (429) as retryable', () => {
    const err = AgentError.from(new Error('OpenAI API error (429): quota exceeded'));
    expect(err.code).toBe('rate_limited');
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(429);
  });

  it('classifies auth failures as non-retryable', () => {
    const err = AgentError.from(new Error('Anthropic API error (401): invalid api key'));
    expect(err.code).toBe('auth');
    expect(err.retryable).toBe(false);
  });

  it('classifies content filter blocks as non-retryable', () => {
    const err = AgentError.from(new Error('Request blocked by the safety system (content filter)'));
    expect(err.code).toBe('content_filter');
    expect(err.retryable).toBe(false);
  });

  it('classifies server and network failures as retryable', () => {
    expect(AgentError.from(new Error('Google API error (500): internal server error')).code).toBe(
      'server',
    );
    expect(AgentError.from(new Error('fetch failed')).code).toBe('network');
    expect(AgentError.from(new Error('Request timeout')).code).toBe('timeout');
  });

  it('maps typed hierarchy errors onto canonical codes', () => {
    expect(AgentError.from(new AIRateLimitError('openai')).code).toBe('rate_limited');
    expect(AgentError.from(new AITimeoutError(1000)).code).toBe('timeout');
    expect(AgentError.from(new AIBudgetExceededError(5, 6)).code).toBe('budget');
    expect(AgentError.from(new AINoProviderError()).code).toBe('no_provider');
    expect(AgentError.from(new AIInvalidConfigError('missing key')).code).toBe('invalid_request');
  });

  it('is idempotent and backfills provider', () => {
    const original = AgentError.from(new Error('boom'));
    expect(AgentError.from(original)).toBe(original);
    const backfilled = AgentError.from(original, 'kimi');
    expect(backfilled.provider).toBe('kimi');
    expect(backfilled.code).toBe(original.code);
  });
});

// --- Ladder rule 1: empty → synthetic follow-up (max 1) ---

describe('runChatRetryLadder — empty response synthetic follow-up', () => {
  const makeDeps = (
    impl: (msgs: ChatMessage[]) => Promise<ChatResponse>,
    switchKey?: (e?: ReadonlySet<string>) => string | null,
  ): RetryLadderDeps => ({
    call: vi.fn(impl),
    switchKey: switchKey ?? null,
  });

  it('retries once with a synthetic follow-up turn on empty content', async () => {
    const deps = makeDeps(async () => ({ ...okResponse('') }));
    const res = await runChatRetryLadder(deps, [{ role: 'user', content: 'hi' }]);

    expect(deps.call).toHaveBeenCalledTimes(2);
    const secondCall = (deps.call as ReturnType<typeof vi.fn>).mock.calls[1][0] as ChatMessage[];
    expect(secondCall.at(-1)?.content).toBe(SYNTHETIC_FOLLOW_UP_PROMPT);
    expect(res.content).toBe('');
  });

  it('does not follow up when the response carries tool calls', async () => {
    const deps = makeDeps(async () => ({
      ...okResponse(''),
      toolCalls: [{ name: 't', arguments: {} }],
    }));
    await runChatRetryLadder(deps, [{ role: 'user', content: 'hi' }]);
    expect(deps.call).toHaveBeenCalledTimes(1);
  });

  it('caps synthetic follow-ups at MAX_SYNTHETIC_FOLLOW_UPS per request', async () => {
    const deps = makeDeps(async () => ({ ...okResponse('') }));
    const state = createRetryLadderState();
    await runChatRetryLadder(deps, [{ role: 'user', content: 'hi' }], state);
    await runChatRetryLadder(deps, [{ role: 'user', content: 'hi' }], state);
    expect(deps.call).toHaveBeenCalledTimes(3); // 1+1 first request, 1 second (capped)
    expect(MAX_SYNTHETIC_FOLLOW_UPS).toBe(1);
  });

  it('never nudges a blocked (finishReason error) empty response', async () => {
    const deps = makeDeps(async () => ({ ...okResponse(''), finishReason: 'error' as const }));
    await expect(runChatRetryLadder(deps, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      AgentError,
    );
    expect(deps.call).toHaveBeenCalledTimes(1);
  });
});

// --- Ladder rule 2: 429 → switch-key đúng 1 lần ---

describe('runChatRetryLadder — 429 switch-key', () => {
  it('switches key once and retries on rate limit', async () => {
    const switchKey = vi.fn(() => 'key-2');
    const deps: RetryLadderDeps = {
      call: vi
        .fn()
        .mockRejectedValueOnce(new Error('OpenAI API error (429): rate limit'))
        .mockResolvedValueOnce(okResponse('after switch')),
      switchKey,
    };
    const res = await runChatRetryLadder(deps, [{ role: 'user', content: 'hi' }]);
    expect(res.content).toBe('after switch');
    expect(switchKey).toHaveBeenCalledTimes(1);
    expect(deps.call).toHaveBeenCalledTimes(2);
  });

  it('falls back to legacy retry when no alternative key exists', async () => {
    const switchKey = vi.fn(() => null);
    const deps: RetryLadderDeps = {
      call: vi.fn().mockRejectedValue(new Error('OpenAI API error (429): rate limit')),
      switchKey,
    };
    await expect(runChatRetryLadder(deps, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /429/,
    );
    expect(deps.call).toHaveBeenCalledTimes(1); // legacy layer handles further retries
    expect(switchKey).toHaveBeenCalledTimes(1);
  });

  it('caps switches at MAX_KEY_SWITCHES per request', async () => {
    const switchKey = vi.fn(() => 'key-2');
    const deps: RetryLadderDeps = {
      call: vi.fn().mockRejectedValue(new Error('OpenAI API error (429): rate limit')),
      switchKey,
    };
    const state = createRetryLadderState();
    await expect(
      runChatRetryLadder(deps, [{ role: 'user', content: 'hi' }], state),
    ).rejects.toThrow();
    await expect(
      runChatRetryLadder(deps, [{ role: 'user', content: 'hi' }], state),
    ).rejects.toThrow();
    expect(switchKey).toHaveBeenCalledTimes(MAX_KEY_SWITCHES);
    expect(MAX_KEY_SWITCHES).toBe(1);
  });
});

// --- Ladder rule 3 + 4 ---

describe('runChatRetryLadder — content filter and generic errors', () => {
  it('surfaces content-filter errors immediately without retry', async () => {
    const deps: RetryLadderDeps = {
      call: vi.fn().mockRejectedValue(new Error('blocked by the safety system (content filter)')),
      switchKey: () => 'k2',
    };
    await expect(runChatRetryLadder(deps, [{ role: 'user', content: 'hi' }])).rejects.toMatchObject(
      {
        code: 'content_filter',
      },
    );
    expect(deps.call).toHaveBeenCalledTimes(1);
  });

  it('rethrows generic errors untouched for legacy retry handling', async () => {
    const original = new Error('OpenAI Down 1');
    const deps: RetryLadderDeps = {
      call: vi.fn().mockRejectedValue(original),
      switchKey: () => 'k2',
    };
    await expect(runChatRetryLadder(deps, [{ role: 'user', content: 'hi' }])).rejects.toBe(
      original,
    );
    expect(deps.call).toHaveBeenCalledTimes(1);
  });

  it('returns non-empty responses without extra calls', async () => {
    const deps: RetryLadderDeps = {
      call: vi.fn().mockResolvedValue(okResponse()),
      switchKey: () => 'k2',
    };
    const res = await runChatRetryLadder(deps, [{ role: 'user', content: 'hi' }]);
    expect(res.content).toBe('answer');
    expect(deps.call).toHaveBeenCalledTimes(1);
  });
});

// --- orchestratorChat integration through the ladder ---

function makeCtx(provider: unknown, fallback: unknown = null): OrchestratorContext {
  const registry = new ProviderRegistry();
  registry.register(provider as never);
  if (fallback) registry.register(fallback as never);
  return {
    config: { providers: [], retryAttempts: 2, retryDelayMs: 1 },
    registry,
    budgetManager: { checkBudget: () => {} },
    defaultProvider: null,
    fallbackOrder: [],
    resolveProvider: () => provider as never,
    findFallbackProvider: () => (fallback as never) ?? null,
    executeWithFallback: async (fn, primary, maxAttempts) => {
      try {
        let lastErr: Error | undefined;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            return await fn(primary);
          } catch (err) {
            lastErr = err instanceof Error ? err : new Error(String(err));
            if (AgentError.from(lastErr).retryable === false) throw lastErr;
          }
        }
        throw lastErr;
      } catch (primaryError) {
        if (fallback) return fn(fallback);
        throw primaryError;
      }
    },
  } as unknown as OrchestratorContext;
}

describe('orchestratorChat — ladder wiring', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('performs the synthetic follow-up through the orchestrator path', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(okResponse(''))
      .mockResolvedValueOnce(okResponse('recovered'));
    const provider = { type: 'openai', name: 'Mock', chat, switchKey: () => 'k2' };
    const res = await orchestratorChat(makeCtx(provider), [{ role: 'user', content: 'hi' }]);
    expect(res.content).toBe('recovered');
    expect(chat).toHaveBeenCalledTimes(2);
    expect((chat.mock.calls[1][0] as ChatMessage[]).at(-1)?.content).toBe(
      SYNTHETIC_FOLLOW_UP_PROMPT,
    );
  });

  it('switches key once on 429 through the registry-backed provider', async () => {
    const chat = vi
      .fn()
      .mockRejectedValueOnce(new Error('OpenAI API error (429): rate limit'))
      .mockResolvedValueOnce(okResponse('post-switch'));
    const switchKey = vi.fn(() => 'k2');
    const provider = { type: 'openai', name: 'Mock', chat, switchKey };
    const res = await orchestratorChat(makeCtx(provider), [{ role: 'user', content: 'hi' }]);
    expect(res.content).toBe('post-switch');
    expect(switchKey).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('keeps legacy retry + fallback semantics for generic errors', async () => {
    const chat = vi
      .fn()
      .mockRejectedValueOnce(new Error('OpenAI Down 1'))
      .mockRejectedValueOnce(new Error('OpenAI Down 2'));
    const fallbackChat = vi.fn().mockResolvedValue(okResponse('from fallback'));
    const provider = { type: 'openai', name: 'Mock', chat };
    const fallback = { type: 'anthropic', name: 'Mock2', chat: fallbackChat };
    const ctx = makeCtx(provider, fallback);
    ctx.fallbackOrder = ['anthropic'];
    const res = await orchestratorChat(ctx, [{ role: 'user', content: 'hi' }]);
    expect(res.content).toBe('from fallback');
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('never retries content-filter errors', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('content filter violation'));
    const provider = { type: 'openai', name: 'Mock', chat, switchKey: () => 'k2' };
    await expect(
      orchestratorChat(makeCtx(provider), [{ role: 'user', content: 'hi' }]),
    ).rejects.toMatchObject({ code: 'content_filter' });
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

// --- orchestratorChatStream — empty stream + content filter ---

describe('orchestratorChatStream — ladder tweaks', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function collect(stream: AsyncGenerator<{ content: string; done: boolean }>) {
    const chunks: Array<{ content: string; done: boolean }> = [];
    for await (const chunk of stream) chunks.push(chunk as { content: string; done: boolean });
    return chunks;
  }

  it('holds the empty terminal chunk and runs ONE synthetic follow-up stream', async () => {
    let streamIndex = 0;
    const chatStream = vi.fn(async function* () {
      streamIndex++;
      if (streamIndex === 1) {
        yield { content: '', done: true, provider: 'openai', model: 'm' };
        return;
      }
      yield { content: 'follow', done: false, provider: 'openai', model: 'm' };
      yield { content: '', done: true, provider: 'openai', model: 'm' };
    });
    const provider = { type: 'openai', name: 'Mock', chat: vi.fn(), chatStream };
    const chunks = await collect(
      orchestratorChatStream(makeCtx(provider), [{ role: 'user', content: 'hi' }]),
    );

    expect(chatStream).toHaveBeenCalledTimes(2);
    expect((chatStream.mock.calls[1][0] as ChatMessage[]).at(-1)?.content).toBe(
      SYNTHETIC_FOLLOW_UP_PROMPT,
    );
    // No empty done chunk from the first attempt may leak through.
    expect(chunks.filter((c) => c.done).length).toBe(1);
    expect(chunks.some((c) => c.content === 'follow')).toBe(true);
  });

  it('surfaces the empty terminal when the follow-up is also empty', async () => {
    const chatStream = vi.fn(async function* () {
      yield { content: '', done: true, provider: 'openai', model: 'm' };
    });
    const provider = { type: 'openai', name: 'Mock', chat: vi.fn(), chatStream };
    const chunks = await collect(
      orchestratorChatStream(makeCtx(provider), [{ role: 'user', content: 'hi' }]),
    );
    expect(chatStream).toHaveBeenCalledTimes(2);
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.done).toBe(true);
  });

  it('does not stack follow-ups when messages already end with the nudge, and still delivers the terminal', async () => {
    const chatStream = vi.fn(async function* () {
      yield { content: '', done: true, provider: 'openai', model: 'm' };
    });
    const provider = { type: 'openai', name: 'Mock', chat: vi.fn(), chatStream };
    const chunks = await collect(
      orchestratorChatStream(makeCtx(provider), [
        { role: 'user', content: SYNTHETIC_FOLLOW_UP_PROMPT },
      ]),
    );
    expect(chatStream).toHaveBeenCalledTimes(1);
    // Regression: skipping the follow-up must not swallow the held terminal —
    // the consumer needs exactly ONE done chunk or the stream hangs.
    expect(chunks.filter((c) => c.done).length).toBe(1);
  });

  it('does not retry content-filter stream errors', async () => {
    const chatStream = vi.fn(async function* () {
      yield { content: 'a', done: false, provider: 'openai', model: 'm' };
      throw new Error('blocked by content filter');
    });
    const provider = { type: 'openai', name: 'Mock', chat: vi.fn(), chatStream };
    await expect(
      collect(orchestratorChatStream(makeCtx(provider), [{ role: 'user', content: 'hi' }])),
    ).rejects.toThrow(/content filter/);
    expect(chatStream).toHaveBeenCalledTimes(1);
  });
});

// --- KeyGate: FIFO waiter + exclude-set ---

describe('KeyGate — FIFO waiter + exclude-set', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('acquires immediately when a key is available', async () => {
    const source = {
      getNextKey: vi.fn(() => 'k1'),
      reportSuccess: vi.fn(),
      reportFailure: vi.fn(),
    };
    const gate = new KeyGate(source, { pollIntervalMs: 5 });
    await expect(gate.acquire()).resolves.toBe('k1');
    expect(gate.waiting).toBe(0);
  });

  it('waits (bounded) when no key is available outside the exclude-set', async () => {
    const source = {
      getNextKey: vi.fn(() => null),
      reportSuccess: vi.fn(),
      reportFailure: vi.fn(),
    };
    const gate = new KeyGate(source, { pollIntervalMs: 5, timeoutMs: 100 });
    await expect(gate.acquire(new Set(['k1']))).rejects.toThrow(AITimeoutError);
  });

  it('serves waiters strictly in FIFO order', async () => {
    let available: string | null = null;
    const source = {
      getNextKey: vi.fn(() => available),
      reportSuccess: vi.fn(),
      reportFailure: vi.fn(),
    };
    const gate = new KeyGate(source, { pollIntervalMs: 5, timeoutMs: 2000 });

    const order: string[] = [];
    const first = gate.acquire().then((k) => {
      order.push(k);
      available = null;
    });
    const second = gate.acquire(new Set(['k1'])).then((k) => {
      order.push(k);
    });
    await vi.waitFor(() => expect(gate.waiting).toBe(2), { timeout: 1000 });

    available = 'k1';
    gate.release();
    await vi.waitFor(() => expect(order.length).toBe(1), { timeout: 1000 });
    expect(order[0]).toBe('k1');

    available = 'k2';
    gate.release();
    await vi.waitFor(() => expect(order.length).toBe(2), { timeout: 1000 });
    expect(order[1]).toBe('k2');

    await Promise.all([first, second]);
  });

  it('skips an excluded key when serving the head waiter', async () => {
    const keys = ['k1', 'k2'];
    const source = {
      getNextKey: vi.fn(
        (exclude?: ReadonlySet<string>) => keys.find((k) => !exclude || !exclude.has(k)) ?? null,
      ),
      reportSuccess: vi.fn(),
      reportFailure: vi.fn(),
    };
    const gate = new KeyGate(source, { pollIntervalMs: 5, timeoutMs: 2000 });

    // The waiter excludes k1: only k2 may satisfy it. Because k2 is
    // immediately available the gate serves it without queueing.
    const pending = gate.acquire(new Set(['k1']));
    await expect(pending).resolves.toBe('k2');
    expect(gate.waiting).toBe(0);
  });

  it('rejects with AITimeoutError after the bounded wait', async () => {
    vi.useFakeTimers();
    try {
      const source = {
        getNextKey: vi.fn(() => null),
        reportSuccess: vi.fn(),
        reportFailure: vi.fn(),
      };
      const gate = new KeyGate(source, { pollIntervalMs: 5, timeoutMs: 100 });
      const pending = gate.acquire();
      const assertion = expect(pending).rejects.toThrow(AITimeoutError);
      await vi.advanceTimersByTimeAsync(150);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('abortAll rejects every waiter', async () => {
    const source = {
      getNextKey: vi.fn(() => null),
      reportSuccess: vi.fn(),
      reportFailure: vi.fn(),
    };
    const gate = new KeyGate(source, { pollIntervalMs: 5, timeoutMs: 5000 });
    const pending = gate.acquire();
    expect(gate.waiting).toBe(1);
    gate.abortAll('teardown');
    await expect(pending).rejects.toThrow('teardown');
  });
});

// --- KeyManager exclude + provider switchKey ---

describe('KeyManager.getNextKey(exclude) — Track S2 additive param', () => {
  it('skips excluded keys and stays healthy-aware', () => {
    const km = new KeyManager(['k1', 'k2'], 'failover');
    expect(km.getNextKey(new Set(['k1']))).toBe('k2');
    expect(km.getNextKey(new Set(['k1', 'k2']))).toBeNull();
    expect(km.getNextKey()).toBe('k1'); // unchanged legacy behavior
  });

  it('returns cooling-down keys outside the exclude-set (earliest first)', () => {
    const km = new KeyManager(['k1', 'k2'], 'failover');
    km.reportFailure('k1', 429);
    const next = km.getNextKey(new Set(['k2']));
    expect(next).toBe('k1'); // cooling but the only non-excluded option
  });

  it('BaseProvider.switchKey picks a different key excluding tried ones', () => {
    const provider = new OpenAIProvider({ type: 'openai', apiKeys: ['k1', 'k2'] });
    expect(provider.switchKey(new Set(['k1']))).toBe('k2');
    expect(provider.switchKey(new Set(['k1', 'k2']))).toBeNull();
  });
});
