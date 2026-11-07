// ReconnectPolicy — kết nối lại phân lớp + grace period (design ported from
// OpenHands use-websocket + connection-error-grace-period, MIT): backoff
// 1s→cap 30s kèm jitter ≤30% (nhiều socket song song không dồn cụm đánh
// server), và nguyên tắc "mất socket KHÔNG phải bằng chứng agent thất bại" —
// mất transport mới → im lặng 30s → báo "reconnecting" 30s → mới báo
// "retryable" sau 60s.

export type ConnectionGracePhase = 'silent' | 'reconnecting' | 'retryable';

export interface ReconnectDelay {
  delayMs: number;
  attempt: number;
}

export class ReconnectPolicy {
  attempt = 0;
  /** Lỗi mới xảy ra tại thời điểm này (ms epoch). */
  private firstFailureAt = 0;

  /** Delay cho lần kết nối lại kế tiếp: backoff + jitter. */
  nextDelay(now = Date.now()): ReconnectDelay {
    this.attempt += 1;
    if (this.firstFailureAt === 0) this.firstFailureAt = now;
    const base = Math.min(1000 * 2 ** (this.attempt - 1), 30_000);
    // jitter ±15% quanh base (đối xứng) — nhiều socket song song không dồn cụm
    const delayMs = Math.max(250, Math.round(base * (1 + (Math.random() * 0.3 - 0.15))));
    return { delayMs, attempt: this.attempt };
  }

  /** Gọi khi kết nối thành công — reset attempt + grace. */
  reset(): void {
    this.attempt = 0;
    this.firstFailureAt = 0;
  }

  /**
   * Phase grace-period hiện tại kể từ lần lỗi đầu tiên của đợt mất kết nối.
   * `now` truyền vào cho test.
   */
  gracePhase(now = Date.now()): ConnectionGracePhase {
    if (this.firstFailureAt === 0) return 'silent';
    const elapsed = now - this.firstFailureAt;
    if (elapsed < 30_000) return 'silent';
    if (elapsed < 60_000) return 'reconnecting';
    return 'retryable';
  }

  /** Ghi nhận lần lỗi MỚI (đợt mất kết nối bắt đầu lại từ đầu). */
  /** Ghi nhận lần lỗi MỚI (đợt mất kết nối bắt đầu lại từ đầu). */
  markFailure(now = Date.now()): void {
    if (this.firstFailureAt === 0) this.firstFailureAt = now;
  }

  /** Báo lỗi đã hết (kết nối lại thành công). */
  clearFailure(): void {
    this.firstFailureAt = 0;
  }
}
