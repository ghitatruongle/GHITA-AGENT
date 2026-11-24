//
// Port pattern waitFor/poll từ nut-js
// (core/nut.js/lib/util/timeout.function.ts:7-76, deep-dive nut-js 02 mục waitFor):
//
//   - Chạy action NGAY LẬP TỨC, nếu kết quả falsy (hoặc reject) thì retry sau
//     `intervalMs` (mặc định 500ms), tổng thời gian giới hạn `timeoutMs`
//     (mặc định 5000ms như screen.class.ts:547-548).
//   - AbortSignal → cleanup + reject NGAY (không đợi hết interval).
//   - Lưu lastRejectionReason để báo lý do CUỐI CÙNG khi timeout — thông tin
//     debug quan trọng nhất: biết vì sao các lần thử trước thất bại.

/** Lỗi khi waitFor bị hủy qua AbortSignal (name = 'AbortError'). */
export class WaitAbortedError extends Error {
  constructor(lastRejectionReason?: string) {
    super(
      lastRejectionReason
        ? `waitFor aborted — last rejection: ${lastRejectionReason}`
        : 'waitFor aborted',
    );
    this.name = 'AbortError';
  }
}

export interface WaitForOptions {
  /** Khoảng nghỉ giữa các lần thử (ms). Mặc định 500 như nut-js. */
  intervalMs?: number;
  /** Tổng thời gian tối đa (ms). Mặc định 5000 như nut-js screen.waitFor. */
  timeoutMs?: number;
  /** Hủy sớm: reject ngay lập tức với WaitAbortedError (name 'AbortError'). */
  signal?: AbortSignal;
}

export type WaitForAction<T> = () => Promise<T> | T;

/**
 * Poll một action đến khi trả về giá trị truthy hoặc hết giờ.
 *
 * Ngữ nghĩa truthy giữ như nut-js: `undefined` / `null` / `false` (và các giá
 * trị falsy khác như 0 / '') được coi là "chưa thấy" — tiếp tục retry.
 *
 * Timeout error message luôn kèm `lastRejectionReason` (lỗi của lần thử cuối)
 * nếu có, mirror hành vi nut-js timeout.function.ts:61-64.
 */
export async function waitFor<T>(
  action: WaitForAction<T>,
  options: WaitForOptions = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 5000;
  const signal = options.signal;

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError(`waitFor: intervalMs must be a positive number, got ${intervalMs}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`waitFor: timeoutMs must be a positive number, got ${timeoutMs}`);
  }
  if (signal?.aborted) {
    throw new WaitAbortedError();
  }

  let lastRejectionReason: string | undefined;

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new WaitAbortedError(lastRejectionReason));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (signal?.aborted) {
      throw new WaitAbortedError(lastRejectionReason);
    }

    let result: unknown;
    try {
      result = await action();
    } catch (err) {
      lastRejectionReason = err instanceof Error ? err.message : String(err);
      result = undefined;
    }

    if (result) {
      return result as T;
    }

    // Không ngủ vượt deadline — lần thử kế tiếp phải còn dư ít nhất 1 interval.
    if (Date.now() + intervalMs > deadline) {
      const reason = lastRejectionReason ? ` — last rejection: ${lastRejectionReason}` : '';
      throw new Error(`waitFor: timed out after ${timeoutMs}ms${reason}`);
    }

    await sleep(intervalMs);
  }
}
