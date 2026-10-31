// Deny-default per-module caps: BudgetRegistry (bytes), MemoryMonitor (sampler
// + alerts), and bounded structures for chat history, terminal scrollback and
// mobile screen preview.

import { performance } from 'node:perf_hooks';

export interface BudgetCap {
  /** Module key, e.g. "ai-engine.cache", "code-graph.index". */
  module: string;
  /** Cap in bytes (0 = unlimited but must be explicit). */
  maxBytes: number;
  /** Hard deny when exceeded (default true). */
  hardLimit?: boolean;
}

export interface BudgetState {
  module: string;
  maxBytes: number;
  usedBytes: number;
  ratio: number;
  over: boolean;
}

export class BudgetRegistry {
  private readonly caps = new Map<string, BudgetCap>();
  private readonly usage = new Map<string, number>();
  private readonly violationLog: Array<{
    module: string;
    usedBytes: number;
    maxBytes: number;
    at: number;
  }> = [];

  register(cap: BudgetCap): void {
    if (cap.maxBytes < 0) throw new Error(`invalid cap for ${cap.module}`);
    this.caps.set(cap.module, cap);
    this.usage.set(cap.module, 0);
  }

  /** Account bytes for a module; returns true when still within budget. */
  account(module: string, bytes: number, delta = true): boolean {
    const cap = this.caps.get(module);
    if (!cap) return false; // unregistered module — deny-default
    const next = Math.max(0, (this.usage.get(module) ?? 0) + (delta ? bytes : -bytes));
    this.usage.set(module, next);
    if (next > cap.maxBytes) {
      if (cap.hardLimit ?? true) {
        // Roll back the overage so the module stays at cap.
        this.usage.set(module, cap.maxBytes);
      }
      this.violationLog.push({ module, usedBytes: next, maxBytes: cap.maxBytes, at: now() });
      // Cap the log itself: the budget enforcer must not become an
      // unbounded memory consumer.
      if (this.violationLog.length > 500) this.violationLog.shift();
      return false;
    }
    return true;
  }

  reset(module?: string): void {
    if (module) this.usage.set(module, 0);
    else this.usage.clear();
    this.violationLog.length = 0;
  }

  state(module: string): BudgetState | undefined {
    const cap = this.caps.get(module);
    const used = this.usage.get(module) ?? 0;
    if (!cap) return undefined;
    return {
      module,
      maxBytes: cap.maxBytes,
      usedBytes: used,
      ratio: cap.maxBytes === 0 ? 0 : used / cap.maxBytes,
      over: used > cap.maxBytes,
    };
  }

  listStates(): BudgetState[] {
    return [...this.caps.keys()].flatMap((m) => {
      const state = this.state(m);
      return state ? [state] : [];
    });
  }

  violations(): ReadonlyArray<{ module: string; usedBytes: number; maxBytes: number; at: number }> {
    return this.violationLog;
  }
}

function now(): number {
  return performance.now();
}

// ── Memory monitor (B7): sampler + alert callback ───────────────────────────

export interface MemorySample {
  at: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
}

export interface MemoryMonitorOptions {
  /** Sampling interval ms (default 30_000). */
  intervalMs?: number;

  heapCapBytes?: number;
  /** Rss cap in bytes (default 1.2 GB). */
  rssCapBytes?: number;
  onSample?: (sample: MemorySample) => void;
  onAlert?: (kind: 'heap' | 'rss' | 'budget', sample: MemorySample) => void;
  /** Extra budgets to check every sample (e.g. BudgetRegistry states). */
  checkBudgets?: () => BudgetState[];
}

export class MemoryMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private samples: MemorySample[] = [];
  private readonly intervalMs: number;
  private readonly heapCap: number;
  private readonly rssCap: number;
  private alerts = 0;

  constructor(
    private readonly options: MemoryMonitorOptions = {},
    private readonly memory: () => NodeJS.MemoryUsage = () => process.memoryUsage(),
  ) {
    this.intervalMs = options.intervalMs ?? 30_000;
    this.heapCap = options.heapCapBytes ?? 400 * 1024 * 1024;
    this.rssCap = options.rssCapBytes ?? 1.2 * 1024 * 1024 * 1024;
  }

  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sample(): MemorySample {
    const m = this.memory();
    const sample: MemorySample = {
      at: Date.now(),
      heapUsed: m.heapUsed,
      heapTotal: m.heapTotal,
      rss: m.rss,
      external: m.external,
    };
    this.samples.push(sample);
    if (this.samples.length > 500) this.samples.shift();
    this.options.onSample?.(sample);

    let alerted = false;
    if (sample.heapUsed > this.heapCap) {
      this.alerts += 1;
      alerted = true;
      this.options.onAlert?.('heap', sample);
    }
    if (sample.rss > this.rssCap) {
      this.alerts += 1;
      alerted = true;
      this.options.onAlert?.('rss', sample);
    }
    if (!alerted) {
      for (const state of this.options.checkBudgets?.() ?? []) {
        if (state.over) {
          this.alerts += 1;
          this.options.onAlert?.('budget', { ...sample, heapUsed: state.usedBytes });
          break;
        }
      }
    }
    return sample;
  }

  stats(): { alerts: number; samples: number } {
    return { alerts: this.alerts, samples: this.samples.length };
  }
}

// ── Chat history cap (B5) ────────────────────────────────────────────────────

export interface ChatHistoryCapOptions {
  maxMessages: number;
  maxCharsPerMessage: number;
  maxTotalChars: number;
}

export class ChatHistoryBudget {
  constructor(private readonly options: ChatHistoryCapOptions) {}

  /** Try appending a message; returns true when accepted (deny-default). */
  push(messages: Array<{ role: string; content: string }>, role: string, content: string): boolean {
    if (messages.length >= this.options.maxMessages) return false;
    if (content.length > this.options.maxCharsPerMessage) return false;
    const total = messages.reduce((s, m) => s + m.content.length, 0) + content.length;
    if (total > this.options.maxTotalChars) return false;
    messages.push({ role, content });
    return true;
  }
}

// ── Terminal scrollback budget (B5) ──────────────────────────────────────────

export interface ScrollbackBudgetOptions {
  maxLines: number;
  maxBytes: number;
}

export class ScrollbackBudget {
  private bytes = 0;
  private readonly lines: string[] = [];

  constructor(private readonly options: ScrollbackBudgetOptions) {}

  push(line: string): boolean {
    const next = this.bytes + line.length;
    if (this.lines.length >= this.options.maxLines || next > this.options.maxBytes) {
      return false;
    }
    this.lines.push(line);
    this.bytes = next;
    return true;
  }

  evict(keep: number): number {
    while (this.lines.length > keep) {
      this.bytes -= this.lines.shift()?.length ?? 0;
    }
    return this.lines.length;
  }

  size(): { lines: number; bytes: number } {
    return { lines: this.lines.length, bytes: this.bytes };
  }
}

// ── Mobile screen preview budget (B9) ────────────────────────────────────────

export interface ScreenPreviewBudgetOptions {
  maxFps: number;
  maxBytesPerFrame: number;
  maxBufferedFrames: number;
}

export class ScreenPreviewBudget {
  constructor(private readonly options: ScreenPreviewBudgetOptions) {}

  /** Accept a frame if within fps + size budget. */
  acceptFrame(frameBytes: number, lastFrameAt: number): { ok: boolean; intervalMs: number } {
    const intervalMs = 1000 / this.options.maxFps;
    const elapsed = Date.now() - lastFrameAt;
    if (elapsed < intervalMs) return { ok: false, intervalMs };
    if (frameBytes > this.options.maxBytesPerFrame) return { ok: false, intervalMs };
    return { ok: true, intervalMs };
  }

  maxBufferedFrames(): number {
    return this.options.maxBufferedFrames;
  }
}

export const RESOURCE_BUDGET_VERSION = '0.0.0';
