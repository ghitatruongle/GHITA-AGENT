// Track S3 P1/P3 — cost surface for @ghita/monitoring.
//
// The ai-engine TokenUsageTracker emits a RunCostReport at the end of every
// run scope through `globalThis.costReportHandler` (mirroring the existing
// `broadcastCostTelemetryHandler` convention). This module receives those
// reports, aggregates them, and forwards them to the local UsageTelemetry —
// WITHOUT importing ai-engine (structural typing only, no new dependency).

import type { UsageTelemetry } from './telemetry.js';

/** Structural shape of an ai-engine RunCostReport — only the fields the
 * cost surface consumes. Anything extra is ignored. */
export interface CostTurnReport {
  runId?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  llmCalls?: number;
  models?: Record<string, { promptTokens: number; completionTokens: number; totalTokens: number }>;
  byChain?: Record<string, { promptTokens: number; completionTokens: number; totalTokens: number }>;
}

export interface CostSurfaceStats {
  turns: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  llmCalls: number;
  byModel: Record<string, { tokens: number; costUsd: number; calls: number }>;
  lastTurnAt: number | null;
  lastRunId: string | null;
}

export interface CostSurfaceOptions {
  /** Local telemetry sink (all data stays on the machine). */
  telemetry?: UsageTelemetry;
  /** Ring size for recentTurns() (default 50). */
  maxTurns?: number;
}

export class CostSurface {
  private turns = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private totalTokens = 0;
  private totalCostUsd = 0;
  private llmCalls = 0;
  private readonly byModel = new Map<string, { tokens: number; costUsd: number; calls: number }>();
  private readonly recent: CostTurnReport[] = [];
  private readonly maxTurns: number;
  private lastTurnAt: number | null = null;
  private lastRunId: string | null = null;
  private readonly telemetry?: UsageTelemetry;

  constructor(options: CostSurfaceOptions = {}) {
    this.telemetry = options.telemetry;
    this.maxTurns = Math.max(1, options.maxTurns ?? 50);
  }

  /** Record one finished run's cost report. */
  recordTurn(report: CostTurnReport): void {
    const prompt = Number(report.promptTokens ?? 0);
    const completion = Number(report.completionTokens ?? 0);
    const total = Number(report.totalTokens ?? prompt + completion);
    const cost = Number(report.costUsd ?? 0);
    const calls = Number(report.llmCalls ?? 0);

    this.turns += 1;
    this.totalPromptTokens += prompt;
    this.totalCompletionTokens += completion;
    this.totalTokens += total;
    this.totalCostUsd += cost;
    this.llmCalls += calls;
    this.lastTurnAt = Date.now();
    this.lastRunId = report.runId ?? this.lastRunId;

    for (const [model, usage] of Object.entries(report.models ?? {})) {
      const current = this.byModel.get(model) ?? { tokens: 0, costUsd: 0, calls: 0 };
      current.tokens += Number(usage.totalTokens ?? 0);
      current.calls += 1;
      // Per-model cost is proportional to the turn's total cost share.
      if (total > 0) current.costUsd += cost * (usage.totalTokens / total);
      this.byModel.set(model, current);
    }

    this.recent.push(report);
    if (this.recent.length > this.maxTurns) {
      this.recent.splice(0, this.recent.length - this.maxTurns);
    }

    this.telemetry?.track({
      name: 'chat.cost',
      category: 'chat',
      durationMs: report.durationMs,
      success: true,
      meta: {
        runId: report.runId ?? 'unknown',
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: total,
        costUsd: Number(cost.toFixed(6)),
        llmCalls: calls,
      },
    });
  }

  getStats(): CostSurfaceStats {
    const byModel: CostSurfaceStats['byModel'] = {};
    for (const [model, entry] of this.byModel) {
      byModel[model] = {
        tokens: entry.tokens,
        costUsd: Number(entry.costUsd.toFixed(6)),
        calls: entry.calls,
      };
    }
    return {
      turns: this.turns,
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      totalTokens: this.totalTokens,
      totalCostUsd: Number(this.totalCostUsd.toFixed(6)),
      llmCalls: this.llmCalls,
      byModel,
      lastTurnAt: this.lastTurnAt,
      lastRunId: this.lastRunId,
    };
  }

  /** Most recent recorded reports (bounded ring, newest last). */
  recentTurns(limit?: number): CostTurnReport[] {
    const slice = limit && limit > 0 ? this.recent.slice(-limit) : [...this.recent];
    return slice;
  }

  reset(): void {
    this.turns = 0;
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.totalTokens = 0;
    this.totalCostUsd = 0;
    this.llmCalls = 0;
    this.byModel.clear();
    this.recent.length = 0;
    this.lastTurnAt = null;
    this.lastRunId = null;
  }
}

interface CostHostGlobals {
  costReportHandler?: (report: CostTurnReport) => void;
}

/**
 * Register a CostSurface as the global cost report sink. The ai-engine
 * TokenUsageTracker calls `globalThis.costReportHandler` at the end of every
 * run scope — this is the only wiring needed to expose per-turn cost on the
 * monitoring surface. Returns a function that unregisters it.
 */
export function registerCostSurface(surface: CostSurface): () => void {
  const host = globalThis as unknown as CostHostGlobals;
  const handler = (report: CostTurnReport) => surface.recordTurn(report);
  host.costReportHandler = handler;
  return () => {
    if (host.costReportHandler === handler) {
      delete host.costReportHandler;
    }
  };
}
