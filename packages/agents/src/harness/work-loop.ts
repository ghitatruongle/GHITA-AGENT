// v0.4.9 A3: Agent Work Loop Harness — Evaluator
//
// Resolves dimension scores under evidence-bounded ceilings and produces a
// finding-bound review. This is a runtime guardrail/reporting aid, not the full
// human review process it is modeled on.

import type {
  CheckResult,
  DimensionScore,
  EvaluateOptions,
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

/**
 * Deterministic evidence score per check state — the baseline a dimension
 * falls back to when no score was authored. Non-observed states score 0
 * (Missing/Unobserved/Not applicable carry no positive evidence).
 */
const EVIDENCE_SCORES: Record<EvidenceState, number> = {
  Present: 40,
  Wired: 60,
  Exercised: 75,
  'Outcome-supported': 90,
  Missing: 0,
  Unobserved: 0,
  'Not applicable': 0,
};

/** Learning Capture floor once a bounded review completes. */
const LEARNING_CAPTURE_FLOOR = 35;

/** An authored dimension score below this must carry at least one linked finding. */
export const LOW_SCORE_FINDING_THRESHOLD = 70;

/**
 * Thrown when an authored score violates the evidence-ceiling validator, or
 * when an authored score below 70 is not backed by a linked finding (score-
 * finding consistency gate) and `allowUnlinkedLowScore` is not set.
 */
export class InvalidWorkLoopScoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWorkLoopScoreError';
  }
}

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
  /**
   * Resolve the Agent Work Loop review for one episode.
   *
   * Scores follow the original model: the ceiling is a cap, never a score
   * formula. Each dimension resolves to either a reviewer-authored integer
   * (validated against the evidence ceiling) or the deterministic baseline —
   * the rounded mean of per-check evidence scores. Findings never move the
   * score ("a score never creates or suppresses a finding").
   *
   *   const review = new WorkLoopEvaluator().evaluate(episode, findings, {
   *     authoredScores: { 'change-validation': 88 },
   *   });
   *   console.log(review.loopEffectiveness, review.dimensions);
   */
  evaluate(
    episode: TaskEpisode,
    findings: WorkLoopFinding[] = [],
    options: EvaluateOptions = {},
  ): WorkLoopReview {
    // Emission bar — a finding is emitted only when it carries an inspected
    // gap, a bounded impact, a smallest-owner repair and a validation route.
    const emitted = findings.filter(passesEmissionBar);
    const emissionBarRejected = findings.filter((f) => !passesEmissionBar(f)).map((f) => f.id);

    const byCheck = new Map<WorkLoopCheckId, CheckResult>();
    for (const check of episode.checks) byCheck.set(check.checkId, check);

    const dimensions: DimensionScore[] = [];
    for (const dimension of Object.keys(DIMENSION_CHECKS) as WorkLoopDimension[]) {
      dimensions.push(this.scoreDimension(dimension, byCheck, options.authoredScores?.[dimension]));
    }

    // Reverse-link both ways, projected from primaryCheck ownership.
    for (const dim of dimensions) {
      dim.findingRefs = emitted
        .filter((f) => checkToDimension(f.primaryCheck) === dim.dimension)
        .map((f) => f.id);
    }
    const emittedFindings = emitted.map((f) => {
      const owner = checkToDimension(f.primaryCheck);
      return { ...f, dimensionRefs: owner ? [owner] : [] };
    });

    const loopEffectiveness = Math.round(
      dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length,
    );

    const review: WorkLoopReview = {
      episodeId: episode.id,
      goal: episode.goal,
      sessionLimited: !episode.sessionLinked,
      dimensions,
      findings: emittedFindings,
      loopEffectiveness,
    };
    if (emissionBarRejected.length > 0) {
      review.emissionBarRejected = emissionBarRejected;
    }

    // Consistency gate — an authored score below the threshold must be backed
    // by at least one linked finding. The deterministic baseline is generated
    // with low confidence and is exempt (reference-model escape hatch); link
    // integrity is checked for every review.
    const violations = scoreFindingConsistency(review);
    if (violations.length > 0) {
      const hasAuthored = dimensions.some((d) => d.scoreSource === 'authored');
      if (hasAuthored && !options.allowUnlinkedLowScore) {
        throw new InvalidWorkLoopScoreError(
          `INVALID_AGENT_WORK_LOOP_SCORE_REVIEW: ${violations.join('; ')}`,
        );
      }
      review.consistencyViolations = violations;
    }

    return review;
  }

  private scoreDimension(
    dimension: WorkLoopDimension,
    byCheck: Map<WorkLoopCheckId, CheckResult>,
    authoredScore?: number,
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

    // A required check that is Missing keeps the dimension at 59 or lower,
    // even when another check carries stronger evidence.
    const hasMissing = checks.some((c) => c.state === 'Missing');
    const validatedCeiling = hasMissing ? Math.min(ceiling, 59) : ceiling;

    // Deterministic baseline: rounded mean of the per-check evidence scores.
    const baseline = Math.round(
      checks.reduce((sum, c) => sum + EVIDENCE_SCORES[c.state], 0) / checks.length,
    );

    let score: number;
    let scoreSource: 'authored' | 'baseline' = 'baseline';
    if (authoredScore !== undefined) {
      // Ceiling validator — an authored score may never exceed the evidence
      // ceiling, and must be a non-negative integer.
      if (
        !Number.isInteger(authoredScore) ||
        authoredScore < 0 ||
        authoredScore > validatedCeiling
      ) {
        throw new InvalidWorkLoopScoreError(
          `INVALID_AGENT_WORK_LOOP_SCORE_REVIEW: dimension "${dimension}" authored score ${authoredScore} is not an integer within 0..${validatedCeiling} (highest evidence: ${highest}${hasMissing ? '; a check is Missing' : ''}).`,
        );
      }
      score = authoredScore;
      scoreSource = 'authored';
    } else {
      score = baseline;
    }

    if (dimension === 'learning-capture') {
      // Learning Capture floor: 35 only means "a bounded review completed" —
      // it never rewards finding counts or asset volume.
      score = Math.max(LEARNING_CAPTURE_FLOOR, score);
    }

    return {
      dimension,
      score,
      scoreSource,
      authored: authoredScore,
      highestEvidence: highest,
      ceiling,
      validatedCeiling,
      checks,
    };
  }
}

/**
 * Emission bar — a finding is emittable only when it carries all four bound
 * fields: an inspected gap, a bounded impact, a smallest-owner repair and a
 * validation route. Counts, filenames, severities, ages, churn or scores are
 * never findings on their own.
 */
export function passesEmissionBar(finding: WorkLoopFinding): boolean {
  return [finding.problem, finding.impact, finding.repair, finding.validationRoute].every(
    (v) => typeof v === 'string' && v.trim().length > 0,
  );
}

/**
 * Score–finding consistency gate: every dimension whose score is below
 * {@link LOW_SCORE_FINDING_THRESHOLD} must carry at least one linked finding,
 * and every reverse-link must resolve in both directions. The deterministic
 * baseline is exempt from the low-score rule (generated with low confidence);
 * link integrity is checked for every review. Returns violation messages —
 * an empty array means the review is consistent.
 */
export function scoreFindingConsistency(review: WorkLoopReview): string[] {
  const violations: string[] = [];
  const findingIds = new Set(review.findings.map((f) => f.id));

  for (const dim of review.dimensions) {
    const refs = dim.findingRefs ?? [];
    for (const ref of refs) {
      if (!findingIds.has(ref)) {
        violations.push(`dimension "${dim.dimension}" references unknown finding "${ref}"`);
      }
    }
    if (
      dim.score < LOW_SCORE_FINDING_THRESHOLD &&
      dim.scoreSource === 'authored' &&
      refs.length === 0
    ) {
      violations.push(
        `dimension "${dim.dimension}" has authored score ${dim.score} < ${LOW_SCORE_FINDING_THRESHOLD} without a linked finding`,
      );
    }
  }

  for (const f of review.findings) {
    if (!f.dimensionRefs || f.dimensionRefs.length === 0) {
      violations.push(`finding "${f.id}" has no dimensionRefs reverse-link`);
    }
  }

  return violations;
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
