export { RequestHumanInputManager, buildRequestHumanInputTool } from './hitl.js';
export type { HumanInputRequest, Urgency, RequestHumanInputManagerOptions } from './hitl.js';

export { AgentLifecycleManager } from './lifecycle.js';
export type { RunState, ManagedRun, RunExecutor, LifecycleHooks } from './lifecycle.js';

export { WorktreeManager } from './worktree.js';
export type { GitRunner, WorktreeOptions, WorktreeInfo } from './worktree.js';

export { runFanout } from './fanout.js';
export type { FanoutAgentRunner, FanoutConfig, FanoutResult, FanoutDeps } from './fanout.js';

export { GitAutoCommitPolicy, createGitOps } from './autocommit.js';
export type {
  AutoCommitMode,
  GitAutoCommitPolicyOptions,
  GitCommitResult,
  GitOps,
} from './autocommit.js';

export { PRReviewPipeline, renderReviewReport } from './review.js';
export type {
  ReviewContext,
  ReviewFinding,
  Reviewer,
  Validator,
  GateCheck,
  ReviewReport,
} from './review.js';

export {
  parseAgentDefinition,
  loadAgentDefinitions,
  dispatchAgentTasks,
  isToolAllowed,
} from './declarative.js';
export type {
  AgentDefinition,
  AgentTask,
  AgentTaskResult,
  AgentDispatcher,
} from './declarative.js';

export {
  MemoryFlowStateStore,
  SqliteFlowStateStore,
  runFlowNodeWithResume,
  withHumanFeedback,
} from './flow-persist.js';
export type { FlowNodeState, FlowStateStore, HumanFeedbackResult } from './flow-persist.js';

export { classifyError, compactErrorForContext, backoffForAttempt } from './error-compact.js';
export type { ErrorCategory, ClassifiedError } from './error-compact.js';

export { RemoteJobStatusProvider } from './remote.js';
export type { RemoteJob, RemoteAction } from './remote.js';

// demo2 P3.5 (Điểm 9 + 10)
export * from './completion-contract.js';
