// Track S2 credential-pool upgrade: FIFO waiter + exclude-set acquire.
//
// Clean-room design modeled on a pool-acquire pattern: concurrent callers that
// need a key are served strictly in arrival order (FIFO), each caller may
// carry an exclude-set of keys it already tried, and nobody hangs forever —
// bounded waits reject with AITimeoutError. KeyManager stays the source of
// truth for cooldowns and rotation; the gate works purely through its public
// API (getNextKey / reportSuccess / reportFailure) so the core is untouched.

import { AITimeoutError } from '../errors/index.js';

export interface KeyGateSource {
  /** Key selection honoring cooldown/rotation; may be exclude-set aware. */
  getNextKey(exclude?: ReadonlySet<string>): string | null;
  reportSuccess(key: string): void;
  reportFailure(key: string, statusCode?: number): void;
}

export interface KeyGateOptions {
  /** How often queued waiters re-probe for a key (cooldown expiry is approximated). */
  pollIntervalMs?: number;
  /** Max time a waiter may sit in the queue before rejecting. */
  timeoutMs?: number;
}

interface Waiter {
  exclude: ReadonlySet<string>;
  resolve: (key: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class KeyGate {
  private readonly queue: Waiter[] = [];
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly source: KeyGateSource,
    options: KeyGateOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Try to take a key immediately. Never waits, never queues. */
  tryAcquire(exclude: ReadonlySet<string> = new Set()): string | null {
    return this.source.getNextKey(exclude);
  }

  /**
   * Acquire a key outside `exclude`. When none is available the caller joins
   * the FIFO queue and is served (strictly in arrival order) as soon as a
   * probe finds a key the head waiter's exclude-set admits. Rejects with
   * AITimeoutError after `timeoutMs`.
   */
  async acquire(exclude: ReadonlySet<string> = new Set()): Promise<string> {
    if (this.queue.length === 0) {
      // No waiters ahead — take a key immediately if the pool admits one.
      const immediate = this.tryAcquire(exclude);
      if (immediate) return immediate;
    }
    return this.enqueue(exclude);
  }

  /** Wake the queue after finishing with a key (or any pool state change). */
  release(): void {
    this.scheduleDrain();
  }

  reportSuccess(key: string): void {
    this.source.reportSuccess(key);
    this.scheduleDrain();
  }

  reportFailure(key: string, statusCode?: number): void {
    this.source.reportFailure(key, statusCode);
    this.scheduleDrain();
  }

  /** Number of callers currently waiting in the FIFO queue. */
  get waiting(): number {
    return this.queue.length;
  }

  /** Drop every waiter (rejecting with the given error) — pool teardown. */
  abortAll(message = 'KeyGate aborted'): void {
    for (const waiter of this.queue.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
  }

  private enqueue(exclude: ReadonlySet<string>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const waiter: Waiter = {
        exclude,
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.queue.indexOf(waiter);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(
            new AITimeoutError(
              this.timeoutMs,
              `KeyGate: no API key became available outside the exclude-set (${exclude.size} excluded)`,
            ),
          );
        }, this.timeoutMs),
      };
      this.queue.push(waiter);
      this.scheduleDrain();
    });
  }

  private scheduleDrain(): void {
    if (this.queue.length === 0 || this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drain();
    }, this.pollIntervalMs);
  }

  private drain(): void {
    const head = this.queue[0];
    if (head) {
      const key = this.tryAcquire(head.exclude);
      if (key) {
        clearTimeout(head.timer);
        this.queue.shift();
        head.resolve(key);
      }
    }
    if (this.queue.length > 0) this.scheduleDrain();
  }
}
