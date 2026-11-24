// Track S3 P1 — TokenUsageTracker: per-run token/cost attribution built on
// AsyncLocalStorage (node:async_hooks).
//
// Design:
//  - `run()` opens a run scope. Every LLM step executed inside the scope
//    (stream or non-stream, via the cost middleware hook) is attributed to the
//    innermost run context — no context leaks in or out, including nested
//    runs (child scopes are isolated, the parent context resumes after the
//    child completes).
//  - A tool chain (`main_request` → `tool_call:<tool>`) is maintained per run;
//    each recorded step is attributed to the deepest chain frame.
//  - `wrapAsyncGenerator` wraps an async generator of AIStreamChunk-like
//    objects: chunks pass through untouched, usage is captured per chunk, and
//    a final step is recorded on clean completion (early consumer break or
//    upstream error records nothing — same semantics as the cost middleware's
//    `success` flag).
//  - When a run scope exits, a RunCostReport is emitted through the
//    `onReport` callback and the optional `globalThis.costReportHandler`
//    (monitoring surface hooks in here — same pattern as
//    `globalThis.broadcastCostTelemetryHandler` in cost/middleware.ts).

import { AsyncLocalStorage } from 'node:async_hooks';
import type { TokenUsage } from './types.js';

/** Root frame of every run's tool chain. */
export const MAIN_REQUEST_FRAME = 'main_request';

/** A single frame of the attribution chain. */
export type ToolChainFrame = typeof MAIN_REQUEST_FRAME | `tool_call:${string}`;

/** One recorded LLM step (one `chat`/`chatStream` call reaching the middleware). */
export interface TokenStep {
  at: number;
  model?: string;
  provider?: string;
  usage: TokenUsage;
  /** Cost in USD computed by the cost middleware for this step (when known). */
  costUsd?: number;
  /** True when usage was estimated from content length (provider sent none). */
  estimated?: boolean;
  /** Snapshot of the tool chain at the moment the step was recorded. */
  chain: ToolChainFrame[];
}

/** Mutable per-run accumulator living in the AsyncLocalStorage context. */
export interface RunContext {
  runId: string;
  startedAt: number;
  /** Attribution chain; always starts with `main_request`. */
  chain: ToolChainFrame[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  llmCalls: number;
  models: Map<string, TokenUsage>;
  byChain: Map<string, TokenUsage>;
  steps: TokenStep[];
}

/** Immutable report emitted when a run scope exits. */
export interface RunCostReport {
  runId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  llmCalls: number;
  /** Per-model usage breakdown. */
  models: Record<string, TokenUsage>;
  /** Per-chain-frame usage breakdown (keys: `main_request`, `tool_call:<tool>`). */
  byChain: Record<string, TokenUsage>;
  /** Ordered attribution steps. */
  steps: TokenStep[];
  /** Chain still active when the report was built. */
  toolChain: ToolChainFrame[];
}

export interface WithRunOptions {
  /** Explicit run id (default: auto-generated `run_<...>`). */
  runId?: string;
  /** Called with the report when the scope exits (in addition to the global handler). */
  onReport?: (report: RunCostReport) => void;
}

export interface RecordStepInput {
  usage: TokenUsage;
  model?: string;
  provider?: string;
  costUsd?: number;
  estimated?: boolean;
}

export interface WrapAsyncGeneratorOptions {
  /** Model hint until a chunk carries its own model. */
  model?: string;
  /** Provider name recorded on the step. */
  provider?: string;
  /** Joined prompt text — enables the len/4 estimation fallback. */
  promptText?: string;
  /** Extra callback invoked with the finalized usage on clean completion
   * (the cost middleware plugs its cost/budget/telemetry logic in here). */
  onFinalize?: (final: { usage: TokenUsage; model: string; estimated: boolean }) => void;
}

interface ChunkLike {
  content?: string | null;
  model?: string;
  usage?: TokenUsage;
}

interface HostGlobals {
  costReportHandler?: (report: RunCostReport) => void;
}

/** Rough estimation used when the provider does not return usage — identical
 * formula to the one the cost middleware historically used (ceil(len / 4)). */
export function estimateUsageFromLength(promptText: string, completionText: string): TokenUsage {
  const promptTokens = Math.ceil(promptText.length / 4);
  const completionTokens = Math.ceil(completionText.length / 4);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

function newRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Standalone tracking wrapper — a free function so the class method can pass
 * `this` explicitly (no this-aliasing). */
async function* wrapWithTracking<T extends ChunkLike>(
  tracker: TokenUsageTracker,
  gen: AsyncGenerator<T>,
  options: WrapAsyncGeneratorOptions = {},
): AsyncGenerator<T> {
  let accumulatedContent = '';
  let model = options.model ?? 'default';
  let finalUsage: TokenUsage | null = null;
  let completed = false;

  try {
    for await (const chunk of gen) {
      if (typeof chunk.content === 'string') accumulatedContent += chunk.content;
      if (chunk.model) model = chunk.model;
      if (chunk.usage) {
        finalUsage = {
          promptTokens: chunk.usage.promptTokens,
          completionTokens: chunk.usage.completionTokens,
          totalTokens: chunk.usage.totalTokens,
        };
      }
      yield chunk;
    }
    completed = true;
  } finally {
    // Early consumer break (gen.return) or upstream error: no step.
    if (completed) {
      let estimated = false;
      let usage = finalUsage ?? emptyUsage();
      if (usage.totalTokens === 0 && options.promptText !== undefined) {
        usage = estimateUsageFromLength(options.promptText, accumulatedContent);
        estimated = true;
      }
      tracker.recordStep({
        usage,
        model,
        provider: options.provider,
        estimated,
      });
      try {
        options.onFinalize?.({ usage, model, estimated });
      } catch (err) {
        console.warn('[TokenUsageTracker] onFinalize callback failed:', err);
      }
    }
  }
}

function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  left.promptTokens += right.promptTokens;
  left.completionTokens += right.completionTokens;
  left.totalTokens += right.totalTokens;
  return left;
}

function bumpMap(map: Map<string, TokenUsage>, key: string, usage: TokenUsage): void {
  const current = map.get(key);
  if (current) addUsage(current, usage);
  else map.set(key, { ...usage });
}

export class TokenUsageTracker {
  private readonly als = new AsyncLocalStorage<RunContext>();

  /**
   * Open a run scope. Nested runs are fully isolated: the child gets a fresh
   * context, and the parent's context (including its accumulated totals and
   * chain) is restored once the child completes. The report is emitted on
   * scope exit even when `fn` throws.
   */
  async run<T>(fn: () => Promise<T> | T, options: WithRunOptions = {}): Promise<T> {
    const parent = this.als.getStore();
    const context: RunContext = {
      runId: options.runId ?? newRunId(),
      startedAt: Date.now(),
      chain: [MAIN_REQUEST_FRAME],
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      llmCalls: 0,
      models: new Map(),
      byChain: new Map(),
      steps: [],
    };

    try {
      return await this.als.run(context, fn);
    } finally {
      // A nested run must never mutate the parent's context — `als.run` only
      // shadows the store for the child's async execution, and this finally
      // runs while the child store is still active.
      const report = this.buildReport(context);
      try {
        options.onReport?.(report);
      } catch (err) {
        console.warn('[TokenUsageTracker] onReport callback failed:', err);
      }
      const host = globalThis as unknown as HostGlobals;
      if (typeof host.costReportHandler === 'function') {
        try {
          host.costReportHandler(report);
        } catch (err) {
          console.warn('[TokenUsageTracker] costReportHandler failed:', err);
        }
      }
      if (parent) {
        // Attribute the child run's totals to the parent as one step so the
        // outer report still sums the whole turn.
        this.recordStep({
          usage: {
            promptTokens: report.promptTokens,
            completionTokens: report.completionTokens,
            totalTokens: report.totalTokens,
          },
          costUsd: report.costUsd,
          provider: 'nested-run',
          model: undefined,
        });
      }
    }
  }

  /** Current run context, or null when outside any run scope. */
  getCurrentRun(): RunContext | null {
    return this.als.getStore() ?? null;
  }

  /** Active run id, or null. */
  activeRunId(): string | null {
    return this.als.getStore()?.runId ?? null;
  }

  /** Push a frame onto the active run's tool chain. */
  pushToolFrame(frame: ToolChainFrame): void {
    const run = this.als.getStore();
    if (!run) return;
    run.chain.push(frame);
  }

  /**
   * Pop the deepest chain frame. The root `main_request` frame is pinned —
   * popping it is a no-op so the chain never empties.
   */
  popToolFrame(): boolean {
    const run = this.als.getStore();
    if (!run || run.chain.length <= 1) return false;
    run.chain.pop();
    return true;
  }

  /**
   * Run `fn` attributed to `tool_call:<tool>` on the active run's chain.
   * Outside a run scope this simply executes `fn`.
   */
  async withToolScope<T>(tool: string, fn: () => Promise<T> | T): Promise<T> {
    if (!this.als.getStore()) return fn();
    this.pushToolFrame(`tool_call:${tool}`);
    try {
      return await fn();
    } finally {
      this.popToolFrame();
    }
  }

  /**
   * Record one LLM step into the active run. Silent no-op outside a run
   * scope (the middleware fires for every provider call, run-scoped or not).
   */
  recordStep(input: RecordStepInput): void {
    const run = this.als.getStore();
    if (!run) return;

    const step: TokenStep = {
      at: Date.now(),
      model: input.model,
      provider: input.provider,
      usage: { ...input.usage },
      costUsd: input.costUsd,
      estimated: input.estimated,
      chain: [...run.chain],
    };

    run.promptTokens += step.usage.promptTokens;
    run.completionTokens += step.usage.completionTokens;
    run.totalTokens += step.usage.totalTokens;
    run.costUsd += input.costUsd ?? 0;
    run.llmCalls += 1;
    run.steps.push(step);
    if (input.model) bumpMap(run.models, input.model, step.usage);
    bumpMap(run.byChain, step.chain.at(-1) ?? MAIN_REQUEST_FRAME, step.usage);
  }

  /**
   * Build the report for the active run WITHOUT ending the scope (a preview;
   * the authoritative report is emitted on scope exit).
   */
  previewReport(): RunCostReport | null {
    const run = this.als.getStore();
    return run ? this.buildReport(run) : null;
  }

  /**
   * Wrap an async generator of AIStreamChunk-like objects. Chunks are passed
   * through untouched; per-chunk usage is captured and the deepest chain
   * frame is attributed. `onFinalize` (and the recorded step) fire only when
   * the generator is consumed to completion — the same `success` semantics as
   * the cost middleware.
   */
  wrapAsyncGenerator<T extends ChunkLike>(
    gen: AsyncGenerator<T>,
    options: WrapAsyncGeneratorOptions = {},
  ): AsyncGenerator<T> {
    return wrapWithTracking(this, gen, options);
  }

  private buildReport(run: RunContext): RunCostReport {
    const endedAt = Date.now();
    const models: Record<string, TokenUsage> = {};
    for (const [model, usage] of run.models) models[model] = { ...usage };
    const byChain: Record<string, TokenUsage> = {};
    for (const [frame, usage] of run.byChain) byChain[frame] = { ...usage };
    return {
      runId: run.runId,
      startedAt: run.startedAt,
      endedAt,
      durationMs: endedAt - run.startedAt,
      promptTokens: run.promptTokens,
      completionTokens: run.completionTokens,
      totalTokens: run.totalTokens,
      costUsd: run.costUsd,
      llmCalls: run.llmCalls,
      models,
      byChain,
      steps: run.steps.map((s) => ({ ...s })),
      toolChain: [...run.chain],
    };
  }
}

/** Default instance the cost middleware records into. Hosts may create their
 * own instance, but the middleware always uses this one. */
export const tokenUsageTracker = new TokenUsageTracker();
