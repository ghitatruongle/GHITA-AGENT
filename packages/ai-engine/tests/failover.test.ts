import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { FallbackManager } from '../src/gateway/fallbackManager.js';
import type { ChatMessage, ChatResponse } from '../src/types.js';

describe('FallbackManager & Cost Tracker', () => {
  const tempDir = path.resolve(process.cwd(), 'packages/ai-engine/tests/temp-budget-dir');
  const budgetConfigPath = path.join(tempDir, 'budget.yaml');
  const dbPath = ':memory:'; // Running tests with in-memory DB is super clean
  let manager: FallbackManager;

  beforeEach(() => {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const budgetYaml = `budget:
  max_cost_per_session: 0.1
  max_cost_per_day: 0.5
  alert_threshold_percent: 50.0
`;
    fs.writeFileSync(budgetConfigPath, budgetYaml, 'utf-8');

    manager = new FallbackManager({
      dbPath,
      budgetConfigPath,
      fallbackChain: ['model-primary', 'model-secondary', 'model-tertiary'],
    });
  });

  afterEach(() => {
    if (manager) {
      manager.close();
    }
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[Cleanup] Failed to remove tempDir in afterEach:`, err);
      }
    }
    vi.restoreAllMocks();
  });

  it('should count tokens accurately using custom tokenizer', () => {
    const text = 'Hello world from Ghita Agent';
    const tokenCount = manager.countTokens(text);
    // 'Hello world from Ghita Agent' -> 6 words. Estimated tokens should be around 6-10.
    expect(tokenCount).toBeGreaterThan(0);
    expect(tokenCount).toBeLessThan(20);

    const vietnameseText = 'Xin chào kỹ sư Ghita';
    const viTokenCount = manager.countTokens(vietnameseText);
    expect(viTokenCount).toBeGreaterThan(0);
  });

  it('should count token for ChatMessages list', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello!' },
    ];
    const totalCount = manager.countMessagesTokens(messages);
    expect(totalCount).toBeGreaterThan(10);
  });

  it('should calculate cost accurately based on MODEL_PRICING', () => {
    // Pricing for gpt-4o: input: 0.0025, output: 0.01 per 1000 tokens
    const cost = manager.calculateCost('gpt-4o', 1000, 2000);
    // Cost = (1000 / 1000) * 0.0025 + (2000 / 1000) * 0.01 = 0.0025 + 0.02 = 0.0225 USD
    expect(cost).toBeCloseTo(0.0225);

    // Pricing for unknown model should fall back to free (ollama)
    const unknownCost = manager.calculateCost('unknown-model', 1000, 1000);
    expect(unknownCost).toBe(0.0);
  });

  it('should log cost records to SQLite and track session/day totals', () => {
    manager.logCost({
      sessionId: (manager as any).sessionId,
      provider: 'openai',
      model: 'gpt-4o',
      promptTokens: 1000,
      completionTokens: 1000,
      totalTokens: 2000,
      cost: 0.0125,
      success: 1,
    });

    const sessionCost = manager.getSessionTotalCost();
    const dayCost = manager.getDayTotalCost();
    expect(sessionCost).toBe(0.0125);
    expect(dayCost).toBe(0.0125);
  });

  it('should trigger custom warning alerts when budget threshold is exceeded', () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // log cost that exceeds 50% ($0.05) of session limit ($0.1)
    manager.logCost({
      sessionId: (manager as any).sessionId,
      provider: 'openai',
      model: 'gpt-4o',
      promptTokens: 5000,
      completionTokens: 5000,
      totalTokens: 10000,
      cost: 0.06, // $0.06 USD
      success: 1,
    });

    expect(consoleWarnSpy).toHaveBeenCalled();
    expect(consoleWarnSpy.mock.calls[0][0]).toContain('exceeded');
  });

  it('should throw error when cost budget limit is reached', async () => {
    manager.logCost({
      sessionId: (manager as any).sessionId,
      provider: 'openai',
      model: 'gpt-4o',
      promptTokens: 10000,
      completionTokens: 10000,
      totalTokens: 20000,
      cost: 0.15, // $0.15 USD
      success: 1,
    });

    const callFn = vi.fn().mockResolvedValue({
      content: 'OK',
      model: 'gpt-4o',
      provider: 'openai',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      finishReason: 'stop',
    });

    await expect(manager.executeWithFailover(callFn, [])).rejects.toThrow('Session cost limit');
  });

  it('should failover to next model when primary model returns rate limit error', async () => {
    const errorMsg = 'HTTP 429: Too many requests';

    const callFn = vi
      .fn()
      .mockRejectedValueOnce(new Error(errorMsg))
      .mockResolvedValueOnce({
        content: 'Response from fallback!',
        model: 'model-secondary',
        provider: 'anthropic',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        finishReason: 'stop',
      } as ChatResponse);

    const messages: ChatMessage[] = [{ role: 'user', content: 'test' }];
    const response = await manager.executeWithFailover(callFn, messages);

    expect(response.content).toBe('Response from fallback!');
    expect(response.model).toBe('model-secondary');
    expect(callFn).toHaveBeenCalledTimes(2);

    const logs = (manager as any).db
      .prepare('SELECT * FROM cost_logs ORDER BY timestamp ASC')
      .all();
    expect(logs.length).toBe(2);
    expect(logs[0].model).toBe('model-primary');
    expect(logs[0].success).toBe(0);
    expect(logs[0].error_message).toBe(errorMsg);

    expect(logs[1].model).toBe('model-secondary');
    expect(logs[1].success).toBe(1);
  });

  it('should fall back to local Ollama when all remote providers fail', async () => {
    // 3 remote providers in chain fail
    const callFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('Auth error'))
      .mockRejectedValueOnce(new Error('Timeout'))
      .mockRejectedValueOnce(new Error('HTTP 429'))
      // Local Ollama fallback succeeds
      .mockResolvedValueOnce({
        content: 'Local backup output',
        model: 'ollama/qwen2.5-coder:1.5b',
        provider: 'ollama',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        finishReason: 'stop',
      } as ChatResponse);

    const response = await manager.executeWithFailover(callFn, []);
    expect(response.content).toBe('Local backup output');
    expect(response.model).toBe('ollama/qwen2.5-coder:1.5b');
    expect(callFn).toHaveBeenCalledTimes(4); // 3 primary + 1 local Ollama
  });
});
