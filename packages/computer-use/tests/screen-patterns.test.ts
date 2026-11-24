// Track S4 — unit tests cho các pattern port từ nut-js:
// validateSearchRegion (screen.class.ts:39-84), clampRegionToScreen
// (window.class.ts:43-71), waitFor AbortSignal + lastRejectionReason
// (timeout.function.ts:7-76), MatchRequest generic (match-request.class.ts).
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MATCH_CONFIDENCE,
  InvalidSearchRegionError,
  WaitAbortedError,
  clampRegionToScreen,
  createMatchRequest,
  validateSearchRegion,
  waitFor,
  type MatchResult,
} from '../src/screen/index.js';

const SCREEN: { width: number; height: number } = { width: 1920, height: 1080 };

describe('validateSearchRegion (nut-js screen.class.ts port)', () => {
  it('chấp nhận region hợp lệ nằm trong màn hình', () => {
    expect(() =>
      validateSearchRegion({ left: 0, top: 0, width: 100, height: 50 }, SCREEN),
    ).not.toThrow();
    expect(() =>
      validateSearchRegion({ left: 100, top: 200, width: 2, height: 2 }, SCREEN),
    ).not.toThrow();
  });

  it('chặn NaN', () => {
    expect(() =>
      validateSearchRegion({ left: Number.NaN, top: 0, width: 10, height: 10 }, SCREEN),
    ).toThrow(InvalidSearchRegionError);
    expect(() =>
      validateSearchRegion({ left: 0, top: 0, width: Number.NaN, height: 10 }, SCREEN),
    ).toThrow(/NaN width/);
  });

  it('chặn thành phần âm', () => {
    expect(() => validateSearchRegion({ left: -1, top: 0, width: 10, height: 10 }, SCREEN)).toThrow(
      /negative left/,
    );
    expect(() => validateSearchRegion({ left: 0, top: 5, width: -10, height: 10 }, SCREEN)).toThrow(
      /negative width/,
    );
    expect(() =>
      validateSearchRegion({ left: 0, top: -0.5, width: 10, height: 10 }, SCREEN),
    ).toThrow(/negative top/);
  });

  it('chặn region < 2px mỗi chiều', () => {
    expect(() => validateSearchRegion({ left: 0, top: 0, width: 1, height: 50 }, SCREEN)).toThrow(
      /too small/,
    );
    expect(() => validateSearchRegion({ left: 0, top: 0, width: 50, height: 1 }, SCREEN)).toThrow(
      /too small/,
    );
  });

  it('chặn region vượt màn hình', () => {
    expect(() =>
      validateSearchRegion({ left: 1900, top: 0, width: 30, height: 10 }, SCREEN),
    ).toThrow(/beyond the screen/);
    expect(() =>
      validateSearchRegion({ left: 0, top: 1070, width: 10, height: 20 }, SCREEN),
    ).toThrow(/beyond the screen/);
  });

  it('bỏ qua check vượt màn hình khi không truyền screenSize', () => {
    expect(() =>
      validateSearchRegion({ left: 0, top: 0, width: 99999, height: 99999 }),
    ).not.toThrow();
  });

  it('lỗi mang đúng name InvalidSearchRegionError (RangeError)', () => {
    try {
      validateSearchRegion({ left: 0, top: 0, width: 0, height: 10 }, SCREEN);
      expect.unreachable('must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidSearchRegionError);
      expect(err).toBeInstanceOf(RangeError);
      expect((err as Error).name).toBe('InvalidSearchRegionError');
    }
  });
});

describe('clampRegionToScreen (nut-js window.class.ts:43-71 port)', () => {
  it('giữ nguyên region hợp lệ', () => {
    expect(clampRegionToScreen({ left: 10, top: 20, width: 100, height: 50 }, SCREEN)).toEqual({
      left: 10,
      top: 20,
      width: 100,
      height: 50,
    });
  });

  it('gốc âm (shadow border Windows) → dịch về 0, trừ phần thừa', () => {
    expect(clampRegionToScreen({ left: -10, top: -7, width: 100, height: 50 }, SCREEN)).toEqual({
      left: 0,
      top: 0,
      width: 90,
      height: 43,
    });
  });

  it('tràn phải/dưới → cắt phần thừa', () => {
    expect(clampRegionToScreen({ left: 1900, top: 1000, width: 100, height: 200 }, SCREEN)).toEqual(
      { left: 1900, top: 1000, width: 20, height: 80 },
    );
  });

  it('window maximized lớn hơn màn hình → giao = toàn màn hình', () => {
    expect(clampRegionToScreen({ left: -8, top: -8, width: 1936, height: 1096 }, SCREEN)).toEqual({
      left: 0,
      top: 0,
      width: 1920,
      height: 1080,
    });
  });

  it('region nằm hoàn toàn ngoài màn hình → kích thước về 0, không âm', () => {
    expect(clampRegionToScreen({ left: 5000, top: 5000, width: 100, height: 100 }, SCREEN)).toEqual(
      { left: 5000, top: 5000, width: 0, height: 0 },
    );
    expect(clampRegionToScreen({ left: -500, top: -500, width: 100, height: 100 }, SCREEN)).toEqual(
      { left: 0, top: 0, width: 0, height: 0 },
    );
  });

  it('clamp KHÔNG throw (khác validateSearchRegion)', () => {
    expect(() =>
      clampRegionToScreen({ left: -1, top: -1, width: 99999, height: 99999 }, SCREEN),
    ).not.toThrow();
  });
});

describe('waitFor (nut-js timeout.function.ts port)', () => {
  it('resolve ngay khi action trả giá trị truthy lần đầu', async () => {
    const action = vi.fn(async () => 'found');
    await expect(waitFor(action, { timeoutMs: 100, intervalMs: 10 })).resolves.toBe('found');
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('retry đến khi truthy — reject của action được nuốt làm lần thử thất bại', async () => {
    let attempts = 0;
    const action = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`boom ${attempts}`);
      return { ok: true };
    });
    await expect(waitFor(action, { timeoutMs: 1000, intervalMs: 5 })).resolves.toEqual({
      ok: true,
    });
    expect(action).toHaveBeenCalledTimes(3);
  });

  it('timeout → error kèm lastRejectionReason của lần thử cuối', async () => {
    const action = vi.fn(async () => {
      throw new Error('pixel not found');
    });
    await expect(waitFor(action, { timeoutMs: 60, intervalMs: 20 })).rejects.toThrow(
      /timed out after 60ms — last rejection: pixel not found/,
    );
  });

  it('timeout không có lỗi nào → message không có phần last rejection', async () => {
    const action = vi.fn((): string | undefined => undefined);
    await expect(waitFor(action, { timeoutMs: 60, intervalMs: 20 })).rejects.toThrow(
      /^waitFor: timed out after 60ms$/,
    );
  });

  it('AbortSignal trong lúc ngủ → reject NGAY với WaitAbortedError (không đợi timeout)', async () => {
    const controller = new AbortController();
    const action = vi.fn(async (): Promise<string | undefined> => undefined);
    const promise = waitFor(action, {
      timeoutMs: 5000,
      intervalMs: 200,
      signal: controller.signal,
    });
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 30);
    await expect(promise).rejects.toBeInstanceOf(WaitAbortedError);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('AbortSignal đã aborted trước khi gọi → reject ngay, không chạy action', async () => {
    const controller = new AbortController();
    controller.abort();
    const action = vi.fn(async () => 'never');
    await expect(
      waitFor(action, { timeoutMs: 100, intervalMs: 10, signal: controller.signal }),
    ).rejects.toThrow(/waitFor aborted/);
    expect(action).not.toHaveBeenCalled();
  });

  it('WaitAbortedError có name AbortError', () => {
    expect(new WaitAbortedError().name).toBe('AbortError');
  });

  it('options vô lý → RangeError', async () => {
    await expect(waitFor(async () => 'x', { intervalMs: 0 })).rejects.toThrow(RangeError);
    await expect(waitFor(async () => 'x', { timeoutMs: -5 })).rejects.toThrow(RangeError);
  });
});

describe('createMatchRequest (nut-js match-request.class.ts port)', () => {
  it('áp confidence mặc định 0.99', () => {
    const request = createMatchRequest({ haystack: 'screen.png', needle: 'icon' });
    expect(request.confidence).toBe(DEFAULT_MATCH_CONFIDENCE);
    expect(request.confidence).toBe(0.99);
    expect(request.haystack).toBe('screen.png');
    expect(request.needle).toBe('icon');
    expect(request.providerData).toBeUndefined();
  });

  it('nhận confidence + providerData riêng (kênh generic của provider)', () => {
    interface MyProviderData {
      scale: number;
      tags: string[];
    }
    const request = createMatchRequest<string, string, MyProviderData>({
      haystack: 'capture',
      needle: 'logo',
      confidence: 0.8,
      providerData: { scale: 1.5, tags: ['ui'] },
    });
    expect(request.confidence).toBe(0.8);
    expect(request.providerData).toEqual({ scale: 1.5, tags: ['ui'] });
  });

  it('chặn confidence vô lý (0, >1, NaN, Infinity)', () => {
    expect(() => createMatchRequest({ haystack: 'h', needle: 'n', confidence: 0 })).toThrow(
      RangeError,
    );
    expect(() => createMatchRequest({ haystack: 'h', needle: 'n', confidence: 1.5 })).toThrow(
      RangeError,
    );
    expect(() =>
      createMatchRequest({ haystack: 'h', needle: 'n', confidence: Number.NaN }),
    ).toThrow(/confidence/);
    expect(() =>
      createMatchRequest({ haystack: 'h', needle: 'n', confidence: Number.POSITIVE_INFINITY }),
    ).toThrow(/confidence/);
  });

  it('MatchResult shape: confidence + location (+ error optional)', () => {
    const result: MatchResult = {
      confidence: 0.95,
      location: { left: 1, top: 2, width: 3, height: 4 },
    };
    expect(result.location).toEqual({ left: 1, top: 2, width: 3, height: 4 });
  });
});
