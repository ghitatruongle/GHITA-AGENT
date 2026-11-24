// Track S3 P1 — CostSurface: per-turn cost aggregation on the monitoring
// surface, fed by globalThis.costReportHandler (set by ai-engine's
// TokenUsageTracker run scopes).

import { describe, expect, it, afterEach } from 'vitest';
import { CostSurface, registerCostSurface } from './cost-surface.js';
import { UsageTelemetry } from './telemetry.js';
import type { CostTurnReport } from './cost-surface.js';

function makeReport(partial: Partial<CostTurnReport>): CostTurnReport {
  return {
    runId: partial.runId ?? `run_${Math.random().toString(36).slice(2, 8)}`,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    costUsd: 0.01,
    llmCalls: 2,
    durationMs: 1200,
    ...partial,
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).costReportHandler;
});

describe('CostSurface', () => {
  it('aggregates turns, tokens, and cost', () => {
    const surface = new CostSurface();
    surface.recordTurn(makeReport({ runId: 'r1' }));
    surface.recordTurn(
      makeReport({
        runId: 'r2',
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        costUsd: 0.002,
      }),
    );

    const stats = surface.getStats();
    expect(stats.turns).toBe(2);
    expect(stats.totalTokens).toBe(165);
    expect(stats.totalPromptTokens).toBe(110);
    expect(stats.totalCompletionTokens).toBe(55);
    expect(stats.totalCostUsd).toBeCloseTo(0.012, 6);
    expect(stats.llmCalls).toBe(4);
    expect(stats.lastRunId).toBe('r2');
    expect(stats.lastTurnAt).not.toBeNull();
  });

  it('keeps a per-model breakdown proportional to turn cost share', () => {
    const surface = new CostSurface();
    surface.recordTurn(
      makeReport({
        costUsd: 0.01,
        totalTokens: 150,
        models: {
          'gpt-4o': { promptTokens: 100, completionTokens: 50, totalTokens: 75 },
          claude: { promptTokens: 0, completionTokens: 0, totalTokens: 75 },
        },
      }),
    );

    const stats = surface.getStats();
    expect(stats.byModel['gpt-4o']?.tokens).toBe(75);
    expect(stats.byModel['gpt-4o']?.costUsd).toBeCloseTo(0.005, 6);
    expect(stats.byModel['claude']?.costUsd).toBeCloseTo(0.005, 6);
    expect(stats.byModel['gpt-4o']?.calls).toBe(1);
  });

  it('forwards chat.cost events to the UsageTelemetry sink', () => {
    const telemetry = new UsageTelemetry({ enabled: true });
    const surface = new CostSurface({ telemetry });
    surface.recordTurn(makeReport({ runId: 'telem-1', costUsd: 0.0125 }));

    const events = telemetry.getEvents();
    const costEvent = events.find((e) => e.name === 'chat.cost');
    expect(costEvent).toBeDefined();
    expect(costEvent?.category).toBe('chat');
    expect(costEvent?.meta?.runId).toBe('telem-1');
    expect(costEvent?.meta?.totalTokens).toBe(150);
    expect(costEvent?.meta?.costUsd).toBeCloseTo(0.0125, 6);
  });

  it('bounds the recent-turns ring', () => {
    const surface = new CostSurface({ maxTurns: 3 });
    for (let i = 0; i < 5; i++) surface.recordTurn(makeReport({ runId: `r${i}` }));
    const recent = surface.recentTurns();
    expect(recent).toHaveLength(3);
    expect(recent.map((r) => r.runId)).toEqual(['r2', 'r3', 'r4']);
    expect(surface.recentTurns(1)).toHaveLength(1);
    expect(surface.recentTurns(1)[0]?.runId).toBe('r4');
  });

  it('reset clears everything', () => {
    const surface = new CostSurface();
    surface.recordTurn(makeReport({}));
    surface.reset();
    const stats = surface.getStats();
    expect(stats.turns).toBe(0);
    expect(stats.totalTokens).toBe(0);
    expect(stats.byModel).toEqual({});
    expect(surface.recentTurns()).toEqual([]);
    expect(stats.lastTurnAt).toBeNull();
  });

  it('registerCostSurface wires globalThis.costReportHandler and unregisters cleanly', () => {
    const surface = new CostSurface();
    const unregister = registerCostSurface(surface);

    const host = globalThis as Record<string, unknown>;
    expect(typeof host.costReportHandler).toBe('function');

    // Simulate an ai-engine TokenUsageTracker emission.
    (host.costReportHandler as (r: CostTurnReport) => void)(
      makeReport({ runId: 'wired', totalTokens: 999 }),
    );
    expect(surface.getStats().totalTokens).toBe(999);
    expect(surface.getStats().lastRunId).toBe('wired');

    unregister();
    expect(host.costReportHandler).toBeUndefined();
  });
});
