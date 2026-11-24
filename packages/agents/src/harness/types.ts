// v0.4.9 A3: Agent Work Loop Harness — Types
//
// A five-dimension / fifteen-check evaluation model for agent task episodes,
// with explicit evidence states and evidence-bounded score ceilings.

/** Five stable review dimensions. */
export type WorkLoopDimension =
  | 'task-understanding'
  | 'controlled-execution'
  | 'change-validation'
  | 'reliable-delivery'
  | 'learning-capture';

/** Fifteen stable check ids (three per dimension). */
export type WorkLoopCheckId =
  // Task Understanding
  | 'goal-understanding'
  | 'relevant-context'
  | 'scope-boundary'
  // Controlled Execution
  | 'instruction-led-start'
  | 'supported-operation'
  | 'permission-boundary'
  // Change Validation
  | 'relevant-check'
  | 'failure-repair'
  | 'validate-again'
  // Reliable Delivery
  | 'acceptance-evidence'
  | 'high-risk-approval'
  | 'rollback-recovery'
  // Learning Capture
  | 'lifecycle-repeat-detection'
  | 'loop-engineering'
  | 'later-validation';

/**
 * Evidence states, ordered weakest → strongest. `Missing`, `Unobserved` and
 * `Not applicable` do not raise confidence beyond the floor ceiling.
 */
export type EvidenceState =
  | 'Present'
  | 'Wired'
  | 'Exercised'
  | 'Outcome-supported'
  | 'Missing'
  | 'Unobserved'
  | 'Not applicable';

/** Result of resolving a single check. */
export interface CheckResult {
  checkId: WorkLoopCheckId;
  state: EvidenceState;
  /** Concise reviewer summary. */
  summary: string;
  /** Bounded evidence references (redacted facet ids, file paths…). */
  evidenceRefs?: string[];
  /** Finding ids linked to this check. */
  findingRefs?: string[];
}

/** A repairable finding bound to exactly one primary check. */
export interface WorkLoopFinding {
  id: string;
  primaryCheck: WorkLoopCheckId;
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** Inspected gap. */
  problem: string;
  /** Bounded impact. */
  impact: string;
  /** Smallest owner-aligned repair. */
  repair: string;
  /** How the repair will be validated. */
  validationRoute: string;
  /** Repair progress after an independent post-fix review. */
  repairProgress?: 'verified' | 'partial' | 'blocked' | 'pending';
  /** Dimension ids linked to this finding (reverse-link of dimension findingRefs). */
  dimensionRefs?: WorkLoopDimension[];
}

/** A Task Episode — one user goal with one acceptance boundary. */
export interface TaskEpisode {
  id: string;
  goal: string;
  /** Whether session-linked evidence was available for this episode. */
  sessionLinked: boolean;
  checks: CheckResult[];
}

/** A resolved dimension score. */
export interface DimensionScore {
  dimension: WorkLoopDimension;
  /** 0–100 (learning-capture floors at 35). */
  score: number;
  /** Whether the score was authored by a reviewer or the deterministic baseline. */
  scoreSource: 'authored' | 'baseline';
  /** Authored score exactly as submitted, when one was supplied. */
  authored?: number;
  /** Highest evidence state observed across the dimension's checks. */
  highestEvidence: EvidenceState;
  /** Ceiling imposed by the highest evidence state. */
  ceiling: number;
  /** Ceiling actually enforced on an authored score (a Missing check caps at 59). */
  validatedCeiling: number;
  checks: CheckResult[];
  /** Finding ids whose primary check belongs to this dimension (reverse-link). */
  findingRefs?: string[];
}

/** Options for {@link WorkLoopEvaluator.evaluate}. */
export interface EvaluateOptions {
  /**
   * Reviewer/AI-authored integer scores per dimension. Each score is validated
   * against the evidence ceiling (state-highest, capped at 59 when a check is
   * Missing). Dimensions without an authored score fall back to the
   * deterministic evidence-score baseline.
   */
  authoredScores?: Partial<Record<WorkLoopDimension, number>>;
  /**
   * Escape hatch for the score-finding consistency gate: allow an authored
   * score below 70 without a linked finding (mirrors the reference model's
   * low-confidence exception). Violations are still recorded on the review.
   */
  allowUnlinkedLowScore?: boolean;
}

/** Full Agent Work Loop review result. */
export interface WorkLoopReview {
  episodeId: string;
  goal: string;
  /** Whether the review ran without full session evidence. */
  sessionLimited: boolean;
  dimensions: DimensionScore[];
  findings: WorkLoopFinding[];
  /** Mean of the five dimension scores (Loop Effectiveness). */
  loopEffectiveness: number;
  /** Finding ids dropped by the emission bar (no gap/impact/repair/validation). */
  emissionBarRejected?: string[];
  /** Score-finding consistency violations (recorded when the gate is not enforced). */
  consistencyViolations?: string[];
}
