import { describe, it, expect, beforeEach } from 'vitest';

describe('Quotas - Rate Limiter', () => {
  let RateLimiter: any;

  beforeEach(async () => {
    const mod = await import('@ghita/quotas');
    RateLimiter = mod.RateLimiter;
  });

  it('should create a rate limiter', () => {
    const limiter = new RateLimiter();
    expect(limiter).toBeDefined();
  });

  it('should allow requests within limit', () => {
    const limiter = new RateLimiter();
    limiter.registerLimit({ id: 'test', limit: 5, window: 'minute', scope: 'requests' });
    for (let i = 0; i < 5; i++) {
      const result = limiter.check('user-1', 'test');
      expect(result.allowed).toBe(true);
    }
  });

  it('should block requests exceeding limit', () => {
    const limiter = new RateLimiter();
    limiter.registerLimit({ id: 'test', limit: 3, window: 'minute', scope: 'requests' });
    for (let i = 0; i < 3; i++) limiter.check('user-1', 'test');
    const result = limiter.check('user-1', 'test');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('should have separate buckets per user', () => {
    const limiter = new RateLimiter();
    limiter.registerLimit({ id: 'test', limit: 2, window: 'minute', scope: 'requests' });
    limiter.check('user-a', 'test');
    limiter.check('user-a', 'test');
    // user-b should still have 2 tokens
    const result = limiter.check('user-b', 'test');
    expect(result.allowed).toBe(true);
  });

  it('should provide peek without consuming', () => {
    const limiter = new RateLimiter();
    limiter.registerLimit({ id: 'test', limit: 10, window: 'minute', scope: 'requests' });
    const peekBefore = limiter.peek('user-1', 'test');
    expect(peekBefore).toBe(10);
    // Consume some
    limiter.check('user-1', 'test');
    limiter.check('user-1', 'test');
    const peekAfter = limiter.peek('user-1', 'test');
    expect(peekAfter).toBeLessThan(10);
  });

  it('should fail CLOSED when no limit registered (Track 2 security fix)', () => {
    const limiter = new RateLimiter();
    const result = limiter.check('user-1', 'nonexistent');
    // Limit chưa đăng ký phải CHẶN, không được cấp phát vô hạn — nếu không
    // một lỗi gõ nhầm id hay quên register là bỏ qua toàn bộ rate limiting.
    // Kỳ vọng cũ (allowed=true) là hợp đồng fail-open đã bị thay.
    expect(result.allowed).toBe(false);
    expect(result.limit).toBe(0);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('should return stats', () => {
    const limiter = new RateLimiter();
    limiter.registerLimit({ id: 'test', limit: 5, window: 'minute', scope: 'requests' });
    limiter.check('user-1', 'test');
    limiter.check('user-2', 'test');
    const stats = limiter.stats();
    expect(stats.registeredLimits).toBe(1);
    expect(stats.totalChecks).toBe(2);
  });

  it('should reset user buckets', () => {
    const limiter = new RateLimiter();
    limiter.registerLimit({ id: 'test', limit: 1, window: 'minute', scope: 'requests' });
    limiter.check('user-1', 'test');
    limiter.reset('user-1');
    const result = limiter.check('user-1', 'test');
    expect(result.allowed).toBe(true);
  });

  it('should clear all buckets', () => {
    const limiter = new RateLimiter();
    limiter.registerLimit({ id: 'test', limit: 1, window: 'minute', scope: 'requests' });
    limiter.check('user-1', 'test');
    limiter.clear();
    const stats = limiter.stats();
    expect(stats.uniqueUsers).toBe(0);
  });
});
