// Mirrors the 5-dimension Agent Work Loop harness (packages/agents harness).

export const EVALS_VERSION = '1.1.0';

/** Five work-loop dimensions used to score an agent run. */
export const EVAL_DIMENSIONS = [
  'task-understanding',
  'controlled-execution',
  'change-validation',
  'reliable-delivery',
  'learning-capture',
] as const;

export type EvalDimension = (typeof EVAL_DIMENSIONS)[number];

/**
 * Evidence strength levels (from weakest to strongest) — mirrors the 7
 * EvidenceState values of the Agent Work Loop harness
 * (packages/agents/src/harness/types.ts:41-48).
 */
export type EvidenceLevel =
  | 'missing'
  | 'unobserved'
  | 'not-applicable'
  | 'present'
  | 'wired'
  | 'exercised'
  | 'outcome-supported';

export interface Evidence {
  dimension: EvalDimension;
  /** Default: present. */
  level: EvidenceLevel;
  /** Short human label, e.g. "expected marker 'TODO removed' found". */
  label: string;
  /** Optional concrete detail (bounded, safe to render). */
  detail?: string;
}

/** One evaluation task. */
export interface EvalTask {
  id: string;
  title: string;
  prompt: string;
  /** Expected markers checked against the final output / artifacts. */
  expected: readonly string[];
  /** Optional tags for suite filtering. */
  tags?: string[];
  /** Safe, human-readable setup description (not executed). */
  setup?: string;
  /** Optional fixture answer used by the offline fixture agent. */
  fixture?: string;
}

/** One step performed by the agent during a run. */
export interface EvalStep {
  tool: string;
  args?: Record<string, unknown>;
  output?: string;
}

/** Trajectory captured during a run (replayable). */
export interface EvalTrajectory {
  steps: EvalStep[];
}

/** Raw result that an agent adapter returns for one task. */
export interface AgentResult {
  task: EvalTask;
  /** Final assistant output text. */
  output: string;
  /** List of file/artifact paths produced (relative to workspace). */
  artifacts?: string[];
  /** Trajectory of tool calls. */
  trajectory?: EvalTrajectory;
  /** Wall-clock duration in ms. */
  durationMs?: number;
}

/** Computed outcome for one task run. */
export interface RunOutcome {
  passed: boolean;
  /** 0..100 composite score. */
  score: number;
  evidence: Evidence[];
  passReasons: string[];
  failReasons: string[];
}

/** Full evaluation run record (persisted for longitudinal tracking). */
export interface EvalRun extends RunOutcome {
  runId: string;
  suite: string;
  task: EvalTask;
  version: string;
  status: 'passed' | 'failed';
  startedAt: string;
  durationMs: number;
  steps: EvalStep[];
  trajectoryFingerprint: string;
}

/** Adapter that runs an agent (or a deterministic stand-in) for a task. */
export type AgentAdapter = (task: EvalTask) => Promise<AgentResult>;

/** Definition of a suite of tasks. */
export interface EvalSuite {
  name: string;
  tasks: EvalTask[];
}

export interface RunOptions {
  suite: string;
  taskFilter?: ReadonlyArray<string>;
  version?: string;
  adapter?: AgentAdapter;
}

export type EvalStatusName = 'passed' | 'failed';
