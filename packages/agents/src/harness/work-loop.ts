// v0.4.9 A3: Agent Work Loop Harness — Evaluator
//
// Resolves dimension scores under evidence-bounded ceilings and produces a
// finding-bound review. This is a runtime guardrail/reporting aid, not the full
// human review process it is modeled on.

import type {
  CheckResult,
  DimensionScore,
  EvidenceState,
  TaskEpisode,
  WorkLoopCheckId,
  WorkLoopDimension,
  WorkLoopFinding,
  WorkLoopReview,
} from './types.js';

/** Which checks belong to which dimension (stable review map). */
const DIMENSION_CHECKS: Record<WorkLoopDimension, WorkLoopCheckId[]> = {
  'task-understanding': ['goal-understanding', 'relevant-context', 'scope-boundary'],
  'controlled-execution': ['instruction-led-start', 'supported-operation', 'permission-boundary'],
  'change-validation': ['relevant-check', 'failure-repair', 'validate-again'],
  'reliable-delivery': ['acceptance-evidence', 'high-risk-approval', 'rollback-recovery'],
  'learning-capture': ['lifecycle-repeat-detection', 'loop-engineering', 'later-validation'],
};

/** Absolute score ceiling per highest supported evidence state. */
const EVIDENCE_CEILING: Record<EvidenceState, number> = {
  Missing: 59,
  Unobserved: 59,
  'Not applicable': 59,
  Present: 74,
  Wired: 84,
  Exercised: 94,
  'Outcome-supported': 100,
};

/** Strength ordering used to find the highest evidence in a dimension. */
const EVIDENCE_STRENGTH: Record<EvidenceState, number> = {
  Missing: 0,
  Unobserved: 0,
  'Not applicable': 0,
  Present: 1,
  Wired: 2,
  Exercised: 3,
  'Outcome-supported': 4,
};

/** Learning Capture floor once a bounded review completes. */
const LEARNING_CAPTURE_FLOOR = 35;

export function checkToDimension(checkId: WorkLoopCheckId): WorkLoopDimension | undefined {
  for (const [dim, checks] of Object.entries(DIMENSION_CHECKS) as [
    WorkLoopDimension,
    WorkLoopCheckId[],
  ][]) {
    if (checks.includes(checkId)) return dim;
  }
  // Trả undefined thay vì throw: hàm này được gọi bên trong `.filter()` cho
  // MỌI finding × MỌI dimension, nên một finding dữ liệu bẩn sẽ làm hỏng
  // toàn bộ quá trình đánh giá — mất sạch báo cáo review của phiên đó.
  return undefined;
}

/**
 * WorkLoopEvaluator — resolves an Agent Work Loop review from check results.
 *

 *   const review = new WorkLoopEvaluator().evaluate(episode, findings);
 *   console.log(review.loopEffectiveness, review.dimensions);
 */
export class WorkLoopEvaluator {
  evaluate(episode: TaskEpisode, findings: WorkLoopFinding[] = []): WorkLoopReview {
    const byCheck = new Map<WorkLoopCheckId, CheckResult>();
    for (const check of episode.checks) byCheck.set(check.checkId, check);

    const dimensions: DimensionScore[] = [];
    for (const dimension of Object.keys(DIMENSION_CHECKS) as WorkLoopDimension[]) {
      dimensions.push(this.scoreDimension(dimension, byCheck, findings));
    }

    const loopEffectiveness = Math.round(
      dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length,
    );

    return {
      episodeId: episode.id,
      goal: episode.goal,
      sessionLimited: !episode.sessionLinked,
      dimensions,
      findings,
      loopEffectiveness,
    };
  }

  private scoreDimension(
    dimension: WorkLoopDimension,
    byCheck: Map<WorkLoopCheckId, CheckResult>,
    findings: WorkLoopFinding[],
  ): DimensionScore {
    const checkIds = DIMENSION_CHECKS[dimension];
    const checks: CheckResult[] = checkIds.map(
      (id) =>
        byCheck.get(id) ?? {
          checkId: id,
          state: 'Unobserved' as EvidenceState,
          summary: 'No evidence supplied for this check.',
        },
    );

    // Highest evidence state across the dimension's three checks.
    let highest: EvidenceState = 'Unobserved';
    for (const check of checks) {
      if (EVIDENCE_STRENGTH[check.state] > EVIDENCE_STRENGTH[highest]) {
        highest = check.state;
      }
    }
    const ceiling = EVIDENCE_CEILING[highest];

    // A required check that is Missing keeps the dimension at 59 or lower.
    const hasMissing = checks.some((c) => c.state === 'Missing');
    // Open findings on this dimension pull the score toward the ceiling floor.
    const dimensionFindingCount = findings.filter(
      (f) => checkToDimension(f.primaryCheck) === dimension && f.repairProgress !== 'verified',
    ).length;

    let score: number;
    if (dimension === 'learning-capture') {
      // Learning Capture is an authored integer 35..100 bounded by evidence.
      score = Math.max(LEARNING_CAPTURE_FLOOR, ceiling - dimensionFindingCount * 8);
    } else {
      const base = hasMissing ? Math.min(ceiling, 59) : ceiling;
      score = Math.max(0, base - dimensionFindingCount * 6);
    }

    return { dimension, score, highestEvidence: highest, ceiling, checks };
  }
}

/**
 * Finding-bound repair progress — updates a finding's repairProgress after an
 * independent post-fix review, WITHOUT changing dimension scores (per model).
 */
export function applyRepairProgress(
  findings: WorkLoopFinding[],
  findingId: string,
  progress: 'verified' | 'partial' | 'blocked',
): WorkLoopFinding[] {
  return findings.map((f) => (f.id === findingId ? { ...f, repairProgress: progress } : f));
}
