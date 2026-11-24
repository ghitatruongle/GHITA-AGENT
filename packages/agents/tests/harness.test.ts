// v0.4.9 A3: Agent Work Loop Harness Unit Tests

import { describe, it, expect } from 'vitest';
import {
  WorkLoopEvaluator,
  checkToDimension,
  applyRepairProgress,
  renderSessionReport,
  InvalidWorkLoopScoreError,
  scoreFindingConsistency,
  passesEmissionBar,
} from '../src/harness/index.js';
import type { TaskEpisode, WorkLoopFinding, CheckResult } from '../src/harness/index.js';

function episode(checks: CheckResult[], sessionLinked = true): TaskEpisode {
  return { id: 'ep-1', goal: 'Refactor login flow', sessionLinked, checks };
}

describe('checkToDimension', () => {
  it('maps checks to their owning dimension', () => {
    expect(checkToDimension('goal-understanding')).toBe('task-understanding');
    expect(checkToDimension('permission-boundary')).toBe('controlled-execution');
    expect(checkToDimension('validate-again')).toBe('change-validation');
    expect(checkToDimension('rollback-recovery')).toBe('reliable-delivery');
    expect(checkToDimension('loop-engineering')).toBe('learning-capture');
  });
});

describe('WorkLoopEvaluator', () => {
  it('caps dimension score at the evidence ceiling', () => {
    const review = new WorkLoopEvaluator().evaluate(
      episode([
        { checkId: 'goal-understanding', state: 'Present', summary: 'acceptance recovered' },
        { checkId: 'relevant-context', state: 'Present', summary: 'owner chain followed' },
        { checkId: 'scope-boundary', state: 'Present', summary: 'diff within scope' },
      ]),
    );
    const td = review.dimensions.find((d) => d.dimension === 'task-understanding')!;
    expect(td.ceiling).toBe(74);
    expect(td.score).toBeLessThanOrEqual(74);
    expect(td.highestEvidence).toBe('Present');
  });

  it('resolves the deterministic baseline (mean of evidence scores) below the ceiling', () => {
    // S1: the old formula reached the full ceiling (94). Scores are no longer
    // ceiling-derived — the baseline is the rounded mean of per-check
    // evidence scores (Exercised 75, Not applicable 0) = 25, still bounded by
    // the evidence ceiling 94.
    const review = new WorkLoopEvaluator().evaluate(
      episode([
        { checkId: 'relevant-check', state: 'Exercised', summary: 'ran scoped tests' },
        { checkId: 'failure-repair', state: 'Not applicable', summary: 'no failure' },
        { checkId: 'validate-again', state: 'Not applicable', summary: 'no repair' },
      ]),
    );
    const cv = review.dimensions.find((d) => d.dimension === 'change-validation')!;
    expect(cv.ceiling).toBe(94);
    expect(cv.score).toBe(25);
    expect(cv.scoreSource).toBe('baseline');
  });

  it('accepts an authored score up to the evidence ceiling', () => {
    const review = new WorkLoopEvaluator().evaluate(
      episode([
        { checkId: 'relevant-check', state: 'Exercised', summary: 'ran scoped tests' },
        { checkId: 'failure-repair', state: 'Not applicable', summary: 'no failure' },
        { checkId: 'validate-again', state: 'Not applicable', summary: 'no repair' },
      ]),
      [],
      { authoredScores: { 'change-validation': 90 } },
    );
    const cv = review.dimensions.find((d) => d.dimension === 'change-validation')!;
    expect(cv.score).toBe(90);
    expect(cv.scoreSource).toBe('authored');
    expect(cv.authored).toBe(90);
    expect(cv.validatedCeiling).toBe(94);
  });

  it('rejects an authored score above the evidence ceiling', () => {
    const evaluator = new WorkLoopEvaluator();
    expect(() =>
      evaluator.evaluate(episode([]), [], { authoredScores: { 'task-understanding': 75 } }),
    ).toThrow(InvalidWorkLoopScoreError);
    expect(() =>
      evaluator.evaluate(
        episode([{ checkId: 'goal-understanding', state: 'Outcome-supported', summary: 'ok' }]),
        [],
        { authoredScores: { 'task-understanding': 101 } },
      ),
    ).toThrow(/0\.\.100/);
  });

  it('rejects a non-integer authored score', () => {
    const evaluator = new WorkLoopEvaluator();
    expect(() =>
      evaluator.evaluate(episode([]), [], { authoredScores: { 'task-understanding': 58.5 } }),
    ).toThrow(InvalidWorkLoopScoreError);
  });

  it('caps the authored score at 59 when a check is Missing', () => {
    const evaluator = new WorkLoopEvaluator();
    // Highest evidence is Outcome-supported (ceiling 100), but the Missing
    // check keeps the enforced ceiling at 59.
    expect(() =>
      evaluator.evaluate(
        episode([
          { checkId: 'goal-understanding', state: 'Outcome-supported', summary: 'ok' },
          { checkId: 'relevant-context', state: 'Outcome-supported', summary: 'ok' },
          { checkId: 'scope-boundary', state: 'Missing', summary: 'no scope decision' },
        ]),
        [],
        { authoredScores: { 'task-understanding': 60 } },
      ),
    ).toThrow(/0\.\.59/);
  });

  it('keeps a dimension at 59 or lower when a required check is Missing', () => {
    const review = new WorkLoopEvaluator().evaluate(
      episode([
        { checkId: 'acceptance-evidence', state: 'Missing', summary: 'no PR decision' },
        { checkId: 'high-risk-approval', state: 'Present', summary: 'approval present' },
        { checkId: 'rollback-recovery', state: 'Present', summary: 'rollback present' },
      ]),
    );
    const rd = review.dimensions.find((d) => d.dimension === 'reliable-delivery')!;
    expect(rd.score).toBeLessThanOrEqual(59);
  });

  it('floors learning-capture at 35', () => {
    const review = new WorkLoopEvaluator().evaluate(
      episode([
        { checkId: 'lifecycle-repeat-detection', state: 'Unobserved', summary: 'n/a' },
        { checkId: 'loop-engineering', state: 'Missing', summary: 'no owner' },
        { checkId: 'later-validation', state: 'Unobserved', summary: 'no later window' },
      ]),
    );
    const lc = review.dimensions.find((d) => d.dimension === 'learning-capture')!;
    expect(lc.score).toBeGreaterThanOrEqual(35);
  });

  it('marks the review session-limited when no session evidence', () => {
    const review = new WorkLoopEvaluator().evaluate(episode([], false));
    expect(review.sessionLimited).toBe(true);
    // all dimensions default to Unobserved → ceiling 59
    expect(review.dimensions.every((d) => d.ceiling === 59)).toBe(true);
  });

  it('never derives dimension scores from finding counts', () => {
    // S1: the old formula deducted per open finding (ceiling − findings×6/8),
    // violating "a score never creates or suppresses a finding". Findings now
    // ride alongside the score; they no longer move it.
    const findings: WorkLoopFinding[] = [
      {
        id: 'F1',
        primaryCheck: 'scope-boundary',
        severity: 'high',
        problem: 'scope creep',
        impact: 'unrelated files changed',
        repair: 'revert unrelated edits',
        validationRoute: 'git diff review',
      },
    ];
    const checks: CheckResult[] = [
      { checkId: 'goal-understanding', state: 'Wired', summary: 'ok' },
      { checkId: 'relevant-context', state: 'Wired', summary: 'ok' },
      { checkId: 'scope-boundary', state: 'Wired', summary: 'ok' },
    ];
    const withFinding = new WorkLoopEvaluator().evaluate(episode(checks), findings);
    const withoutFinding = new WorkLoopEvaluator().evaluate(episode(checks), []);
    const dimWith = withFinding.dimensions.find((d) => d.dimension === 'task-understanding')!;
    const dimWithout = withoutFinding.dimensions.find((d) => d.dimension === 'task-understanding')!;
    expect(dimWith.score).toBe(dimWithout.score);
  });

  it('gates authored scores below 70 on a linked finding', () => {
    const evaluator = new WorkLoopEvaluator();
    const checks: CheckResult[] = [
      { checkId: 'goal-understanding', state: 'Wired', summary: 'ok' },
      { checkId: 'relevant-context', state: 'Wired', summary: 'ok' },
      { checkId: 'scope-boundary', state: 'Wired', summary: 'ok' },
    ];
    const finding: WorkLoopFinding = {
      id: 'F1',
      primaryCheck: 'scope-boundary',
      severity: 'high',
      problem: 'scope creep',
      impact: 'unrelated files changed',
      repair: 'revert unrelated edits',
      validationRoute: 'git diff review',
    };
    // Authored 65 with no linked finding → inconsistent, gate blocks.
    expect(() =>
      evaluator.evaluate(episode(checks), [], { authoredScores: { 'task-understanding': 65 } }),
    ).toThrow(InvalidWorkLoopScoreError);
    // Same score with a linked finding on the dimension → consistent.
    expect(() =>
      evaluator.evaluate(episode(checks), [finding], {
        authoredScores: { 'task-understanding': 65 },
      }),
    ).not.toThrow();
    // Escape hatch: violation recorded instead of thrown.
    const review = evaluator.evaluate(episode(checks), [], {
      authoredScores: { 'task-understanding': 65 },
      allowUnlinkedLowScore: true,
    });
    expect(review.consistencyViolations?.length).toBe(1);
    expect(review.consistencyViolations?.[0]).toContain('task-understanding');
  });

  it('exempts deterministic baseline scores from the low-score gate', () => {
    const review = new WorkLoopEvaluator().evaluate(episode([]), []);
    expect(review.dimensions.every((d) => d.scoreSource === 'baseline')).toBe(true);
    expect(review.consistencyViolations).toBeUndefined();
    expect(scoreFindingConsistency(review)).toEqual([]);
  });

  it('emits only findings that pass the emission bar', () => {
    const base: WorkLoopFinding = {
      id: 'F1',
      primaryCheck: 'scope-boundary',
      severity: 'high',
      problem: 'scope creep',
      impact: 'unrelated files changed',
      repair: 'revert unrelated edits',
      validationRoute: 'git diff review',
    };
    const review = new WorkLoopEvaluator().evaluate(episode([]), [
      base,
      { ...base, id: 'F2', repair: '' },
      { ...base, id: 'F3', validationRoute: '   ' },
    ]);
    expect(review.findings.map((f) => f.id)).toEqual(['F1']);
    expect(review.emissionBarRejected).toEqual(['F2', 'F3']);
  });

  it('reverse-links findings and dimensions in both directions', () => {
    const finding: WorkLoopFinding = {
      id: 'F1',
      primaryCheck: 'scope-boundary',
      severity: 'low',
      problem: 'scope creep',
      impact: 'unrelated files changed',
      repair: 'revert unrelated edits',
      validationRoute: 'git diff review',
    };
    const checks: CheckResult[] = [
      { checkId: 'goal-understanding', state: 'Wired', summary: 'ok' },
      { checkId: 'relevant-context', state: 'Wired', summary: 'ok' },
      { checkId: 'scope-boundary', state: 'Wired', summary: 'ok' },
    ];
    const review = new WorkLoopEvaluator().evaluate(episode(checks), [finding]);
    const td = review.dimensions.find((d) => d.dimension === 'task-understanding')!;
    expect(td.findingRefs).toEqual(['F1']);
    expect(review.findings[0]!.dimensionRefs).toEqual(['task-understanding']);
    expect(scoreFindingConsistency(review)).toEqual([]);
    expect(passesEmissionBar(finding)).toBe(true);
  });
});

describe('applyRepairProgress', () => {
  it('updates only the targeted finding', () => {
    const findings: WorkLoopFinding[] = [
      {
        id: 'F1',
        primaryCheck: 'scope-boundary',
        severity: 'low',
        problem: 'p',
        impact: 'i',
        repair: 'r',
        validationRoute: 'v',
      },
      {
        id: 'F2',
        primaryCheck: 'relevant-check',
        severity: 'low',
        problem: 'p',
        impact: 'i',
        repair: 'r',
        validationRoute: 'v',
      },
    ];
    const updated = applyRepairProgress(findings, 'F1', 'verified');
    expect(updated.find((f) => f.id === 'F1')!.repairProgress).toBe('verified');
    expect(updated.find((f) => f.id === 'F2')!.repairProgress).toBeUndefined();
  });
});

describe('renderSessionReport', () => {
  it('renders dimensions, findings and session-limited note', async () => {
    const review = new WorkLoopEvaluator().evaluate(
      episode([{ checkId: 'goal-understanding', state: 'Wired', summary: 'ok' }], false),
      [
        {
          id: 'F1',
          primaryCheck: 'goal-understanding',
          severity: 'medium',
          problem: 'vague acceptance',
          impact: 'ambiguous done',
          repair: 'record acceptance criteria',
          validationRoute: 'review spec',
        },
      ],
    );
    const md = await renderSessionReport(review);
    expect(md).toContain('# Agent Work Loop Report');
    expect(md).toContain('session-limited');
    expect(md).toContain('F1');
    expect(md).toContain('Loop Effectiveness');
  });

  it('sanitizes PII and injected scripts from report fields', async () => {
    const review = new WorkLoopEvaluator().evaluate(
      episode([
        {
          checkId: 'goal-understanding',
          state: 'Wired',
          summary:
            'Contact owner@example.com or ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 <script>alert(1)</script>',
        },
      ]),
      [
        {
          id: 'F1',
          primaryCheck: 'goal-understanding',
          severity: 'medium',
          problem: 'reviewer email reviewer@example.org leaked into notes',
          impact: 'PII exposure',
          repair: 'redact notes',
          validationRoute: 'log review',
        },
      ],
    );
    const md = await renderSessionReport(review);
    expect(md).not.toContain('owner@example.com');
    expect(md).not.toContain('reviewer@example.org');
    expect(md).toContain('[REDACTED:EMAIL]');
    expect(md).not.toContain('<script>');
    expect(md).toContain('[REDACTED:TOKEN]');
  });

  it('does not render findings below the emission bar', async () => {
    const review = new WorkLoopEvaluator().evaluate(
      episode([{ checkId: 'goal-understanding', state: 'Wired', summary: 'ok' }]),
      [
        {
          id: 'F2',
          primaryCheck: 'goal-understanding',
          severity: 'low',
          problem: 'gap only — no impact/repair/validation',
          impact: '',
          repair: '',
          validationRoute: '',
        },
      ],
    );
    const md = await renderSessionReport(review);
    expect(md).not.toContain('F2');
    expect(md).toContain('No repairable findings');
  });
});
