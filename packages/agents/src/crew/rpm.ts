// RpmLimiter — giới hạn request/phút cho crew (CrewAI RPMController
// pattern, MIT — clean-room TS): đếm mốc thời gian, sleep tới khi có slot.
export class RpmLimiter {
  private readonly maxPerMinute: number;
  private readonly stamps: number[] = [];

  constructor(maxPerMinute: number) {
    if (!Number.isFinite(maxPerMinute) || maxPerMinute <= 0) {
      throw new Error('RpmLimiter requires a positive maxPerMinute');
    }
    this.maxPerMinute = Math.floor(maxPerMinute);
  }

  /** Số slot còn trống trong phút lăn (rolling 60s). */
  private freeSlots(now: number): number {
    while (this.stamps.length > 0) {
      const oldest = this.stamps[0];
      if (oldest !== undefined && now - oldest >= 60_000) {
        this.stamps.shift();
      } else {
        break;
      }
    }
    return this.maxPerMinute - this.stamps.length;
  }

  /**
   * Chiếm 1 slot; khi hết slot thì sleep tới mốc cũ nhất hết hạn rồi tiếp.
   * `nowFn` cho test tiêm đồng hồ giả.
   */
  async acquire(
    nowFn: () => number = Date.now,
    sleepFn: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => {
        // P1 fix: timer sleep KHÔNG giữ process sống (unref) — run bị hủy
        // giữa lúc chờ RPM thì process vẫn thoát ngay, không treo 60s.
        const timer = setTimeout(resolve, ms);
        (timer as { unref?: () => void }).unref?.();
      }),
  ): Promise<void> {
    for (;;) {
      const now = nowFn();
      const free = this.freeSlots(now);
      if (free > 0) {
        this.stamps.push(now);
        return;
      }
      const oldest = this.stamps[0];
      if (oldest === undefined) return;
      const waitMs = Math.max(1, 60_000 - (now - oldest) + 5);
      await sleepFn(waitMs);
    }
  }

  /** Đã chiếm trong phút lăn (bằng chứng đo được cho test/UI). */
  used(nowFn: () => number = Date.now): number {
    this.freeSlots(nowFn());
    return this.stamps.length;
  }
}
