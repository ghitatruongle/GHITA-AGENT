// Crew orchestration types (design ported from CrewAI, MIT — clean-room TS
// reimplementation; see docs/crew-orchestration.md for attribution).

import type { ReActTool } from '../react/types.js';

/**
 * A crew member definition. The role/goal/backstory triplet is the CrewAI
 * identity model: it is compiled into the agent's system prompt so each
 * member behaves like a specialised teammate rather than a generic assistant.
 */
export interface CrewAgentSpec {
  id: string;
  name: string;
  role: string;
  goal: string;
  backstory?: string;
  /** Tools always available to this member, on top of task-level tools. */
  tools?: ReActTool[];
  /** ReAct iteration budget for this member's own loop. */
  maxIterations?: number;
  /**
   * Allow this member to delegate to crewmates via the `delegate_work` /
   * `ask_question` tools (CrewAI `allow_delegation`). In hierarchical mode
   * the manager always has these tools regardless of this flag.
   */
  allowDelegation?: boolean;
}

/**
 * A unit of work assigned to one crew member. `context` lists the task IDs
 * whose outputs are injected as context; when omitted, every previously
 * completed task's output is provided (CrewAI default behaviour).
 */
export interface CrewTask {
  id: string;
  description: string;
  expectedOutput?: string;
  /** Crew member that executes this task. Resolvable by id or role. */
  agentId?: string;
  context?: string[];
  /** Extra tools for this task only (override the member's toolset when set). */
  tools?: ReActTool[];
  /**
   * Output guardrail: return `true` to accept, `false` to retry with a
   * generic reason, or a non-empty string to retry with that reason.
   */
  /**
   * Output guardrail: hàm tự viết, HOẶC một MÔ TẢ string — khi đó Crew
   * config.llmJudge (5.4) sẽ chấm output theo mô tả (CrewAI llm_guardrail).
   */
  guardrail?: string | ((output: string) => boolean | string | Promise<boolean | string>);
  /** Guardrail retry budget (default: 2). */
  maxRetries?: number;
  /**
   * Wall-clock deadline for this task in milliseconds (CrewAI
   * `max_execution_time`). Covers the whole task including LLM retries and
   * guardrail revisions; the executor's signal aborts when it fires. When
   * unset, the crew-level `maxExecutionTime` applies.
   */
  maxExecutionTime?: number;
}

export type CrewProcess = 'sequential' | 'hierarchical';

/** A single task plan produced by the optional CrewPlanner pre-flight. */
export interface CrewPlanStep {
  taskId: string;
  plan: string;
}

/** Serializable, replayable event describing one step of a crew run. */
export type CrewEvent =
  | { type: 'crew_start'; crewId: string; process: CrewProcess; taskCount: number; timestamp: number }
  | { type: 'plan_created'; steps: CrewPlanStep[]; timestamp: number }
  | { type: 'task_start'; taskId: string; agentId?: string; timestamp: number }
  | { type: 'task_guardrail_retry'; taskId: string; attempt: number; reason: string; timestamp: number }
  | {
      type: 'task_llm_retry';
      taskId: string;
      agentId?: string;
      /** 1-based retry index within the task. */
      attempt: number;
      reason: string;
      timestamp: number;
    }
  | {
      type: 'task_timeout';
      taskId: string;
      agentId?: string;
      /** Wall-clock deadline that fired. */
      timeoutMs: number;
      timestamp: number;
    }
  | { type: 'task_complete'; taskId: string; agentId?: string; output: string; duration: number; timestamp: number }
  | { type: 'task_failed'; taskId: string; agentId?: string; error: string; timestamp: number }
  | { type: 'delegation'; fromAgentId?: string; toAgentId: string; kind: 'work' | 'question'; timestamp: number }
  | {
      type: 'crew_complete';
      crewId: string;
      status: 'completed' | 'failed';
      output: string;
      duration: number;
      /** Aggregate token usage across every LLM call of the run. */
      usage?: CrewUsage;
      timestamp: number;
    };

/**
 * Aggregate token usage of one task or a whole run. Counters are cumulative;
 * `cachedTokens` is only present when at least one sample reported it.
 */
export interface CrewUsage {
  /** Total prompt (input) tokens across sampled LLM calls. */
  promptTokens: number;
  /** Total completion (output) tokens across sampled LLM calls. */
  completionTokens: number;
  /** Prompt tokens served from cache, when the provider reports it. */
  cachedTokens?: number;
  /** Number of LLM calls included in these counters. */
  requests: number;
}

/** Output of a single executed task. */
export interface CrewTaskOutput {
  taskId: string;
  agentId?: string;
  output: string;
  duration: number;
  retries: number;
  /** LLM retries consumed by this task (transient-error retry loop). */
  llmRetries?: number;
  /** Aggregate token usage of this task's LLM calls, when reported. */
  usage?: CrewUsage;
  /** Delegations accepted while producing this output (hierarchical mode). */
  delegations?: number;
}

/** Result of a full crew kickoff. */
export interface CrewResult {
  crewId: string;
  status: 'completed' | 'failed';
  /** Final answer = output of the last executed task (CrewAI `CrewOutput.raw`). */
  output: string;
  taskOutputs: CrewTaskOutput[];
  duration: number;
  /** Aggregate token usage of the whole run, when reported. */
  usage?: CrewUsage;
  error?: string;
}

/** Everything a task executor needs to run one member's turn. */
export interface CrewExecutionRequest {
  crewId: string;
  taskId: string;
  agent: CrewAgentSpec;
  /** Fully assembled user prompt (task + context + inputs). */
  prompt: string;
  tools: ReActTool[];
  signal?: AbortSignal;
  /**
   * Called once per LLM call with that call's token usage (crew metrics
   * aggregation). Executors that never call it simply leave usage unset.
   */
  onUsage?: (sample: CrewUsageSample) => void;
}

/** Token usage of a single LLM call. */
export interface CrewUsageSample {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  /** Always 1 for a per-call sample. */
  requests: 1;
}

/**
 * Executes one member's turn and returns the final text output. The default
 * implementation wraps a fresh `ReActAgent` per execution; tests and the
 * sidecar can inject their own.
 */
export type CrewTaskExecutor = (request: CrewExecutionRequest) => Promise<string>;

/** Minimal memory seam so Crew stays decoupled from `@ghita/memory`. */
export interface CrewMemoryBridge {
  recall(query: string, limit?: number): string | null;
  remember(content: string, metadata?: Record<string, unknown>): void;
}
