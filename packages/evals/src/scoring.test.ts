import { describe, it, expect } from 'vitest';
import { computeRunScore, coveragePerDimension } from './scoring.js';

describe('computeRunScore', () => {
  it('passes and scores high when expected markers matched + steps executed', () => {
    const outcome = computeRunScore({
      expected: ['implemented', 'done'],
      output: 'implemented: handled. done.',
      artifacts: ['out/result.txt'],
      steps: [{ tool: 'write_file', args: { path: 'a.ts' } }],
      passed: true,
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.score).toBeGreaterThan(80);
    expect(outcome.evidence.some((e) => e.dimension === 'change-validation')).toBe(true);
  });

  it('fails and scores low when no markers matched', () => {
    const outcome = computeRunScore({
      expected: ['implemented'],
      output: 'nothing done',
      artifacts: [],
      steps: [],
      passed: false,
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.score).toBeLessThan(40);
    expect(outcome.failReasons.length).toBeGreaterThan(0);
  });

  it('produces evidence for all five dimensions', () => {
    const outcome = computeRunScore({
      expected: ['x'],
      output: 'x done\nSummary: ok\nNext steps: none',
      artifacts: ['a.txt'],
      steps: [{ tool: 'grep_search' }],
      passed: true,
    });
    const dims = new Set(outcome.evidence.map((e) => e.dimension));
    expect(dims.size).toBe(5);
  });
});

describe('coveragePerDimension', () => {
  it('takes best evidence level per dimension', () => {
    const per = coveragePerDimension([
      { dimension: 'controlled-execution', level: 'present', label: 'a' },
      { dimension: 'controlled-execution', level: 'wired', label: 'b' },
      { dimension: 'task-understanding', level: 'present', label: 'c' },
    ]);
    expect(per['controlled-execution']).toBe(0.7);
    expect(per['task-understanding']).toBe(0.4);
  });

  it('ranks the 7 evidence levels monotonically (harness parity)', () => {
    const per = coveragePerDimension([
      { dimension: 'controlled-execution', level: 'exercised', label: 'ran tools' },
      { dimension: 'change-validation', level: 'unobserved', label: 'nothing observed' },
      { dimension: 'change-validation', level: 'not-applicable', label: 'slot not applicable' },
      { dimension: 'reliable-delivery', level: 'outcome-supported', label: 'completed' },
      { dimension: 'learning-capture', level: 'missing', label: 'nothing captured' },
    ]);
    expect(per['controlled-execution']).toBe(0.85);
    expect(per['reliable-delivery']).toBe(1);
    expect(per['change-validation']).toBe(0);
    expect(per['learning-capture']).toBe(0);
  });
});
