// DoomLoopGate — chặn vòng lặp vô ích (pattern từ grok-build turn.rs
// "action-stationarity", Apache-2.0 — clean-room TS): đếm run-length của
// tool call GIỐNG NHAU liên tiếp (cùng tên + cùng tham số). Vượt ngưỡng →
// nudge model một lần; vẫn lặp → cắt turn.
export type DoomVerdict = 'ok' | 'nudge' | 'stop';

export class DoomLoopGate {
  private lastKey = '';
  private runLength = 0;
  private nudged = false;
  private readonly threshold: number;

  constructor(threshold = 5) {
    if (!Number.isFinite(threshold) || threshold < 2) {
      throw new Error('DoomLoopGate threshold must be >= 2');
    }
    this.threshold = Math.floor(threshold);
  }

  /**
   * Quan sát một tool call. argsKey là định danh tham số (JSON.stringify
   * ổn định) — cùng key liên tiếp mới đếm run-length.
   */
  observe(toolName: string, argsKey: string): { verdict: DoomVerdict; runLength: number } {
    const key = `${toolName  }::${  argsKey}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.runLength = 1;
      this.nudged = false;
      return { verdict: 'ok', runLength: 1 };
    }
    this.runLength += 1;
    if (this.runLength >= this.threshold) {
      if (this.nudged) return { verdict: 'stop', runLength: this.runLength };
      this.nudged = true;
      return { verdict: 'nudge', runLength: this.runLength };
    }
    return { verdict: 'ok', runLength: this.runLength };
  }

  /** Reset cho turn mới. */
  reset(): void {
    this.lastKey = '';
    this.runLength = 0;
    this.nudged = false;
  }
}
