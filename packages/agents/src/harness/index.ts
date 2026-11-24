// v0.4.9 A3: Agent Work Loop Harness — Public API

export {
  WorkLoopEvaluator,
  checkToDimension,
  applyRepairProgress,
  InvalidWorkLoopScoreError,
  passesEmissionBar,
  scoreFindingConsistency,
  LOW_SCORE_FINDING_THRESHOLD,
} from './work-loop.js';
export { renderSessionReport } from './session-report.js';
export type {
  WorkLoopDimension,
  WorkLoopCheckId,
  EvidenceState,
  CheckResult,
  WorkLoopFinding,
  TaskEpisode,
  DimensionScore,
  EvaluateOptions,
  WorkLoopReview,
} from './types.js';
