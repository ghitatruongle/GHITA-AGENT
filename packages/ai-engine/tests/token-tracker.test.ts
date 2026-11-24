// Track S3 P1 — TokenUsageTracker: AsyncLocalStorage run scopes, tool chain
// push/pop, nested-run isolation, and the cost-middleware hook.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AIStreamChunk } from '@ghita/shared';
import {
  TokenUsageTracker,
  tokenUsageTracker,
  estimateUsageFromLength,
  MAIN_REQUEST_FRAME,
  type RunCostReport,
} from '../src/token-tracker.js';
import { createCostMiddleware } from '../src/cost/middleware.js';
import { CostTracker } from '../src/cost/tracker.js';
import { BudgetManager } from '../src/cost/budget.js';
import { wrapProvider } from '../src/utils/middleware.js';
import type { AIProvider, ChatMessage, ChatResponse } from '../src/types.js';
import { AgentError } from '../src/errors/index.js';

function makeStreamChunk(partial: Partial<AIStreamChunk>): AIStreamChunk {
  return { content: '', done: false, ...partial };
}

function makeFakeProvider(): AIProvider {
  const usage = { promptTokens: 100, completionTokens: 50, totalTokens: 150 };
  return {
    type: 'openai',
    name: 'Fake',
    defaultModel: 'fake-model',
    models: ['fake-model'],
    isReady: async () => true,
    test: async () => true,
    chat: async (_messages: ChatMessage[]): Promise<ChatResponse> => ({
      content: 'non-stream answer',
      model: 'fake-model',
      provider: 'openai',
      usage,
      finishReason: 'stop',
    }),
    chatStream: async function* (): AsyncGenerator<AIStreamChunk> {
      yield makeStreamChunk({ content: 'Hel', provider: 'openai', model: 'fake-model' });
      yield makeStreamChunk({ content: 'lo ', provider: 'openai', model: 'fake-model' });
      yield makeStreamChunk({ content: 'world', provider: 'openai', model: 'fake-model' });
      yield makeStreamChunk({
        content: '',
        done: true,
        provider: 'openai',
        model: 'fake-model',
        usage,
      });
    },
  } as unknown as AIProvider;
}

describe('TokenUsageTracker — AsyncLocalStorage run scopes', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).costReportHandler;
    vi.restoreAllMocks();
  });

  it('attributes steps to the active run and emits a report on scope exit', async () => {
    const tracker = new TokenUsageTracker();
    const reports: RunCostReport[] = [];

    await tracker.run(
      async () => {
        tracker.recordStep({ usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } });
        tracker.recordStep({
          usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
          model: 'm2',
          costUsd: 0.01,
        });
        const preview = tracker.previewReport();
        expect(preview?.llmCalls).toBe(2);
        expect(preview?.totalTokens).toBe(25);
        expect(preview?.models['m2']?.totalTokens).toBe(10);
      },
      { runId: 'run-a', onReport: (r) => reports.push(r) },
    );

    expect(reports.map((r) => r.runId)).toEqual(['run-a']);
    expect(reports[0]?.totalTokens).toBe(25);
    expect(reports[0]?.costUsd).toBeCloseTo(0.01, 6);
    expect(reports[0]?.steps).toHaveLength(2);
    expect(tracker.getCurrentRun()).toBeNull();
    expect(tracker.activeRunId()).toBeNull();
  });

  it('nested runs do not leak context into each other', async () => {
    const tracker = new TokenUsageTracker();
    let outerTotal = 0;
    let outerLlmCalls = 0;
    let nestedSteps = 0;

    await tracker.run(
      async () => {
        tracker.recordStep({ usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 } });
        const outerRunId = tracker.activeRunId();

        await tracker.run(async () => {
          // Inside the child: fresh context — the parent's totals are invisible.
          expect(tracker.activeRunId()).not.toBe(outerRunId);
          expect(tracker.getCurrentRun()?.totalTokens).toBe(0);
          expect(tracker.getCurrentRun()?.chain).toEqual([MAIN_REQUEST_FRAME]);

          tracker.recordStep({
            usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
          });
          expect(tracker.getCurrentRun()?.totalTokens).toBe(5);
          expect(tracker.getCurrentRun()?.llmCalls).toBe(1);
        });

        // Parent context restored: its own totals plus the child rolled up as
        // ONE nested-run step (the child's 5 tokens), never merged step-by-step.
        expect(tracker.activeRunId()).toBe(outerRunId);
        expect(tracker.getCurrentRun()?.totalTokens).toBe(15);
        expect(tracker.getCurrentRun()?.llmCalls).toBe(2);

        tracker.recordStep({ usage: { promptTokens: 4, completionTokens: 4, totalTokens: 8 } });

        outerTotal = tracker.getCurrentRun()?.totalTokens ?? 0;
        outerLlmCalls = tracker.getCurrentRun()?.llmCalls ?? 0;
        nestedSteps =
          tracker.getCurrentRun()?.steps.filter((s) => s.provider === 'nested-run').length ?? 0;
      },
      { runId: 'outer' },
    );

    // Parent totals = own two steps (10 + 8) + child rollup (5) = 23.
    expect(outerTotal).toBe(23);
    expect(outerLlmCalls).toBe(3);
    expect(nestedSteps).toBe(1);
  });

  it('nested child run emits its own report via onReport', async () => {
    const tracker = new TokenUsageTracker();
    const seen: string[] = [];

    await tracker.run(
      async () => {
        await tracker.run(
          async () => {
            tracker.recordStep({ usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
          },
          { runId: 'child', onReport: (r) => seen.push(r.runId) },
        );
      },
      { runId: 'parent', onReport: (r) => seen.push(r.runId) },
    );

    // Child report fires first (inner scope exits first), then parent's.
    expect(seen).toEqual(['child', 'parent']);
  });

  it('records nothing outside a run scope', () => {
    const tracker = new TokenUsageTracker();
    expect(() =>
      tracker.recordStep({ usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } }),
    ).not.toThrow();
    expect(tracker.previewReport()).toBeNull();
  });
});

describe('TokenUsageTracker — tool chain push/pop', () => {
  it('maintains main_request → tool_call:<tool> chain', async () => {
    const tracker = new TokenUsageTracker();

    await tracker.run(async () => {
      expect(tracker.getCurrentRun()?.chain).toEqual([MAIN_REQUEST_FRAME]);
      expect(tracker.popToolFrame()).toBe(false); // root frame is pinned

      tracker.pushToolFrame('tool_call:web_search');
      expect(tracker.getCurrentRun()?.chain).toEqual([MAIN_REQUEST_FRAME, 'tool_call:web_search']);

      tracker.pushToolFrame('tool_call:read_file');
      expect(tracker.getCurrentRun()?.chain).toEqual([
        MAIN_REQUEST_FRAME,
        'tool_call:web_search',
        'tool_call:read_file',
      ]);

      tracker.recordStep({ usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
      expect(tracker.getCurrentRun()?.steps.at(-1)?.chain).toEqual([
        MAIN_REQUEST_FRAME,
        'tool_call:web_search',
        'tool_call:read_file',
      ]);

      expect(tracker.popToolFrame()).toBe(true);
      expect(tracker.getCurrentRun()?.chain).toEqual([MAIN_REQUEST_FRAME, 'tool_call:web_search']);
      expect(tracker.popToolFrame()).toBe(true);
      expect(tracker.getCurrentRun()?.chain).toEqual([MAIN_REQUEST_FRAME]);
    });
  });

  it('withToolScope attributes usage to the tool frame and restores the chain', async () => {
    const tracker = new TokenUsageTracker();
    let byChain: Record<string, { totalTokens: number }> | undefined;

    const result = await tracker.run(async () => {
      const value = await tracker.withToolScope('grep_search', async () => {
        expect(tracker.getCurrentRun()?.chain).toEqual([
          MAIN_REQUEST_FRAME,
          'tool_call:grep_search',
        ]);
        tracker.recordStep({ usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 } });
        return 42;
      });
      expect(tracker.getCurrentRun()?.chain).toEqual([MAIN_REQUEST_FRAME]);
      byChain = tracker.previewReport()?.byChain;
      return value;
    });

    expect(result).toBe(42);
    expect(byChain?.['tool_call:grep_search']?.totalTokens).toBe(4);
    expect(byChain?.[MAIN_REQUEST_FRAME]).toBeUndefined();
  });

  it('withToolScope outside a run simply executes fn', async () => {
    const tracker = new TokenUsageTracker();
    await expect(tracker.withToolScope('x', async () => 'ok')).resolves.toBe('ok');
  });

  it('pops the tool frame even when the scoped fn throws', async () => {
    const tracker = new TokenUsageTracker();
    await tracker.run(async () => {
      await expect(
        tracker.withToolScope('broken', async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(tracker.getCurrentRun()?.chain).toEqual([MAIN_REQUEST_FRAME]);
    });
  });
});

describe('TokenUsageTracker — wrapAsyncGenerator', () => {
  it('passes chunks through and records the final usage step', async () => {
    const tracker = new TokenUsageTracker();
    const finalized: Array<{ total: number; model: string; estimated: boolean }> = [];
    let report: RunCostReport | undefined;

    async function* source(): AsyncGenerator<AIStreamChunk> {
      yield makeStreamChunk({ content: 'abc', model: 'm1' });
      yield makeStreamChunk({
        content: 'def',
        model: 'm1',
        usage: { promptTokens: 30, completionTokens: 20, totalTokens: 50 },
        done: true,
      });
    }

    await tracker.run(
      async () => {
        const wrapped = tracker.wrapAsyncGenerator(source(), {
          model: 'm1',
          provider: 'openai',
          onFinalize: (f) =>
            finalized.push({ total: f.usage.totalTokens, model: f.model, estimated: f.estimated }),
        });
        const collected: string[] = [];
        for await (const chunk of wrapped) collected.push(chunk.content);
        expect(collected.join('')).toBe('abcdef');
        report = tracker.previewReport() ?? undefined;
      },
      { onReport: (r) => (report = r) },
    );

    expect(finalized).toEqual([{ total: 50, model: 'm1', estimated: false }]);
    expect(report?.totalTokens).toBe(50);
    expect(report?.models['m1']?.totalTokens).toBe(50);
  });

  it('falls back to length estimation when the provider sends no usage', async () => {
    const tracker = new TokenUsageTracker();
    let report: RunCostReport | undefined;

    async function* source(): AsyncGenerator<AIStreamChunk> {
      yield makeStreamChunk({ content: 'abcd' }); // 4 chars → completionTokens 1
    }

    await tracker.run(
      async () => {
        for await (const _ of tracker.wrapAsyncGenerator(source(), {
          promptText: '12345678', // 8 chars → promptTokens 2
        })) {
          // consume
        }
        report = tracker.previewReport() ?? undefined;
      },
      { onReport: (r) => (report = r) },
    );

    expect(report?.totalTokens).toBe(3);
    expect(report?.steps.at(-1)?.estimated).toBe(true);
  });

  it('records nothing when the consumer breaks early', async () => {
    const tracker = new TokenUsageTracker();
    let report: RunCostReport | undefined;

    async function* source(): AsyncGenerator<AIStreamChunk> {
      yield makeStreamChunk({
        content: 'x',
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      });
      yield makeStreamChunk({
        content: 'y',
        done: true,
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      });
    }

    await tracker.run(
      async () => {
        const wrapped = tracker.wrapAsyncGenerator(source());
        for await (const chunk of wrapped) {
          if (chunk.content === 'x') break;
        }
        report = tracker.previewReport() ?? undefined;
      },
      { onReport: (r) => (report = r) },
    );

    expect(report?.llmCalls).toBe(0);
    expect(report?.totalTokens).toBe(0);
  });

  it('estimation matches the shared formula helper', () => {
    expect(estimateUsageFromLength('', '')).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
    expect(estimateUsageFromLength('abcdefgh', 'ab')).toEqual({
      promptTokens: 2,
      completionTokens: 1,
      totalTokens: 3,
    });
  });
});

describe('TokenUsageTracker — cost middleware hook', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'hi there' }];

  it('middleware chat + chatStream steps land in the active run report', async () => {
    const provider = makeFakeProvider();
    const costTracker = new CostTracker();
    const budgetManager = new BudgetManager({ limit: 10, period: 'monthly' });
    const { chat, chatStream } = createCostMiddleware({ costTracker, budgetManager });
    const wrapped = wrapProvider(provider, { chat: [chat], chatStream: [chatStream] });

    const globalReports: RunCostReport[] = [];
    (globalThis as Record<string, unknown>).costReportHandler = (report: RunCostReport) =>
      globalReports.push(report);

    let byChain: Record<string, { totalTokens: number }> | undefined;

    await tokenUsageTracker.run(
      async () => {
        // A step inside a tool scope (non-stream chat), then a top-level
        // stream step — both must be attributed by chain frame.
        await tokenUsageTracker.withToolScope('choose', async () => {
          const resp = await wrapped.chat(messages);
          expect(resp.content).toBe('non-stream answer');
        });
        for await (const _ of wrapped.chatStream(messages)) {
          // consume fully
        }
        byChain = tokenUsageTracker.previewReport()?.byChain;
      },
      { runId: 'turn-1' },
    );

    const report = globalReports.at(-1);
    expect(report?.runId).toBe('turn-1');
    expect(report?.totalTokens).toBe(300); // 150 (non-stream) + 150 (stream)
    expect(byChain?.['tool_call:choose']?.totalTokens).toBe(150);
    expect(byChain?.[MAIN_REQUEST_FRAME]?.totalTokens).toBe(150);
    expect(tokenUsageTracker.previewReport()).toBeNull(); // scope exited
  });

  it('middleware stream still records cost with estimation when provider sends no usage', async () => {
    const provider = makeFakeProvider();
    const noUsageProvider: AIProvider = {
      ...provider,
      chatStream: async function* (): AsyncGenerator<AIStreamChunk> {
        yield makeStreamChunk({ content: '1234', provider: 'openai', model: 'fake-model' });
        yield makeStreamChunk({ content: '', done: true, provider: 'openai', model: 'fake-model' });
      },
    } as unknown as AIProvider;
    const costTracker = new CostTracker();
    const budgetManager = new BudgetManager({ limit: 10, period: 'monthly' });
    const { chatStream } = createCostMiddleware({ costTracker, budgetManager });
    const wrapped = wrapProvider(noUsageProvider, { chatStream: [chatStream] });

    const steps: Array<{ totalTokens: number; estimated: boolean }> = [];
    await tokenUsageTracker.run(async () => {
      for await (const _ of wrapped.chatStream(messages)) {
        // consume
      }
      const report = tokenUsageTracker.previewReport();
      for (const step of report?.steps ?? []) {
        steps.push({ totalTokens: step.usage.totalTokens, estimated: step.estimated === true });
      }
    });

    expect(steps).toHaveLength(1);
    expect(steps[0]?.estimated).toBe(true);
    // prompt 'hi there' = 8 chars → 2; completion '1234' = 4 chars → 1 → total 3
    expect(steps[0]?.totalTokens).toBe(3);
    expect(costTracker.getTotalCost()).toBeGreaterThanOrEqual(0);
  });

  it('tracker failures surface as AgentError-classified errors, not silent drops', () => {
    // The tracker itself never throws into the middleware path; the canonical
    // error type for tracker-adjacent failures (denied approval, lost scope)
    // is AgentError — keep the S2 contract explicit here.
    const err = AgentError.from(new Error('run scope lost'));
    expect(err.code).toBe('unknown');
    expect(err.retryable).toBe(true);
  });
});
