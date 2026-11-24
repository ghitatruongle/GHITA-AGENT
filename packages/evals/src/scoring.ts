// Computes a 0..100 score from evidence collected per task. Scoring is
// evidence-bound over the 7 EvidenceState levels (parity with the harness):
// outcome-supported > exercised > wired > present > unobserved/not-applicable
// > missing, and the expected-marker check produces the strongest evidence.

import type { EvalDimension, EvalStep, Evidence, EvidenceLevel, RunOutcome } from './types.js';
import { EVAL_DIMENSIONS } from './types.js';

/**
 * Evidence weights over the 7 EvidenceState levels (parity with the harness).
 * Monotonic: missing/unobserved/not-applicable carry no positive coverage,
 * present < wired < exercised < outcome-supported.
 */
const LEVEL_WEIGHT: Record<EvidenceLevel, number> = {
  missing: 0,
  unobserved: 0,
  'not-applicable': 0,
  present: 0.4,
  wired: 0.7,
  exercised: 0.85,
  'outcome-supported': 1,
};

/// Per-dimension expected evidence points (what keeps a dimension healthy).
export const DIMENSION_EXPECTATIONS: Record<
  EvalDimension,
  ReadonlyArray<{ label: string; level: EvidenceLevel }>
> = {
  'task-understanding': [
    { label: 'agent produced a relevant final output', level: 'present' },
    { label: 'output references the task goal', level: 'wired' },
  ],
  'controlled-execution': [
    { label: 'tool calls were executed', level: 'exercised' },
    { label: 'no destructive/unexpected tool misuse', level: 'present' },
  ],
  'change-validation': [
    { label: 'artifacts / output produced', level: 'wired' },
    { label: 'expected markers matched', level: 'outcome-supported' },
  ],
  'reliable-delivery': [
    { label: 'run completed within bounds', level: 'present' },
    { label: 'trajectory present', level: 'wired' },
  ],
  'learning-capture': [
    { label: 'follow-up summary/learnings captured', level: 'present' },
    { label: 'output reflects structured summary', level: 'wired' },
  ],
};

/** Aggregate best evidence for each dimension into a 0-1 coverage. */
export function coveragePerDimension(evidence: Evidence[]): Record<EvalDimension, number> {
  const out = {} as Record<EvalDimension, number>;
  for (const dim of EVAL_DIMENSIONS) {
    const best = evidence
      .filter((e) => e.dimension === dim)
      .reduce((max, e) => Math.max(max, LEVEL_WEIGHT[e.level]), 0);
    out[dim] = best;
  }
  return out;
}

export interface ScoringInput {
  expected: readonly string[];
  output: string;
  artifacts: string[];
  steps: readonly EvalStep[];
  /** Optional custom evidence (e.g. from domain-specific adapters). */
  evidence?: readonly Evidence[];
  passed: boolean;
}

/** Compute the run outcome from raw signal + evidence. */
export function computeRunScore(input: ScoringInput): RunOutcome {
  const evidence: Evidence[] = [...(input.evidence ?? [])];
  const passReasons: string[] = [];
  const failReasons: string[] = [];

  const markerHits = input.expected.filter((m) => input.output.includes(m));

  // 1. Marker matching → outcome-supported / wired evidence.
  const allMarkersMatched =
    input.expected.length > 0 && input.expected.every((m) => input.output.includes(m));
  if (input.expected.length > 0) {
    if (markerHits.length > 0) {
      evidence.push({
        dimension: 'change-validation',
        level: allMarkersMatched ? 'outcome-supported' : 'wired',
        label: `${markerHits.length}/${input.expected.length} expected markers matched`,
      });
      passReasons.push('expected markers matched in output');
    } else {
      failReasons.push('no expected marker matched in output');
    }
  }

  // 2. Artifacts produced → wired evidence.
  if (input.artifacts.length > 0) {
    evidence.push({
      dimension: 'change-validation',
      level: 'wired',
      label: `${input.artifacts.length} artifact(s) produced`,
    });
    passReasons.push('artifacts produced');
  } else {
    evidence.push({
      dimension: 'change-validation',
      level: 'present',
      label: 'no artifacts produced — output only',
    });
  }

  // 3. Trajectory evidence.
  if (input.steps.length > 0) {
    evidence.push({
      dimension: 'controlled-execution',
      level: 'exercised',
      label: `${input.steps.length} tool steps executed`,
    });
    passReasons.push('steps executed');
  } else {
    evidence.push({
      dimension: 'controlled-execution',
      level: 'present',
      label: 'no tool steps (direct answer)',
    });
  }

  // 4. Overall pass signal → reliable-delivery evidence.
  evidence.push({
    dimension: 'reliable-delivery',
    level: input.passed ? 'outcome-supported' : 'present',
    label: input.passed ? 'task completed' : 'task failed',
  });
  if (input.passed) passReasons.push('task completed (adapter verdict)');
  else failReasons.push('task failed (adapter verdict)');

  // 5. Learning capture: passing with all markers = strongest evidence.
  const looksStructured =
    /(summary|conclusion|next steps|plan)/i.test(input.output.slice(0, 3000)) ||
    input.output.split('\n').length >= 4;
  evidence.push({
    dimension: 'learning-capture',
    level: allMarkersMatched ? 'outcome-supported' : looksStructured ? 'present' : 'missing',
    label: allMarkersMatched
      ? 'expected markers evidence captured'
      : looksStructured
        ? 'output has structured summary-like content'
        : 'output unstructured',
  });

  // 6. Task understanding: non-empty output is the base signal.
  evidence.push({
    dimension: 'task-understanding',
    level: allMarkersMatched ? 'wired' : input.output.trim().length > 0 ? 'present' : 'missing',
    label: allMarkersMatched
      ? 'final output satisfies expected markers'
      : input.output.trim().length > 0
        ? 'agent produced a final output'
        : 'no final output produced',
  });

  const coverage = coveragePerDimension(evidence);
  const score = Math.round(
    ((coverage['task-understanding'] +
      coverage['controlled-execution'] +
      coverage['change-validation'] +
      coverage['reliable-delivery'] +
      coverage['learning-capture']) /
      5) *
      100,
  );

  return { passed: input.passed, score, evidence, passReasons, failReasons };
}

/** Build the interactive pair for compatibility with Runner. */
export function scoreResult(input: ScoringInput): RunOutcome {
  return computeRunScore(input);
}
