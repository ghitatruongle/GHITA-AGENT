// Track 8.2 — compaction verify 3 outcome.
import { describe, expect, it } from 'vitest';
import { captureCompactionBaseline, verifyCompaction } from './compaction-verify.js';

describe('8.2 — verifyCompaction', () => {
  it('token giảm thật -> compacted kèm số token cứu được', () => {
    const baseline = captureCompactionBaseline('evt-1', 12_000);
    const r = verifyCompaction({ baseline, afterTokens: 7_000, elapsedMs: 900, budgetMs: 1_000 });
    expect(r.outcome).toBe('compacted');
    expect(r.tokensSaved).toBe(5_000);
  });

  it('token không giảm -> no_change', () => {
    const baseline = captureCompactionBaseline('evt-2', 5_000);
    expect(verifyCompaction({ baseline, afterTokens: 5_000, elapsedMs: 100, budgetMs: 1_000 }).outcome).toBe('no_change');
  });

  it('hết budget mà token không giảm -> timeout', () => {
    const baseline = captureCompactionBaseline('evt-3', 5_000);
    const r = verifyCompaction({ baseline, afterTokens: 5_000, elapsedMs: 1_000, budgetMs: 1_000 });
    expect(r.outcome).toBe('timeout');
  });

  it('hết budget NHƯNG token giảm thật -> vẫn là compacted', () => {
    const baseline = captureCompactionBaseline('evt-4', 9_000);
    expect(verifyCompaction({ baseline, afterTokens: 4_000, elapsedMs: 1_200, budgetMs: 1_000 }).outcome).toBe('compacted');
  });
});
