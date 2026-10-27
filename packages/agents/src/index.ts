//
// The Agents package provides the orchestration layer for AI agent lifecycle
// management, multi-agent collaboration, and task execution pipelines.
//
// Key capabilities:
//
// - **ReAct Agent**: Reasoning + Acting agent with tool-use loops, structured
//   output schemas, and configurable max iterations.
// - **Flow Orchestration**: DAG-based workflow execution with typed step results,
//   conditional branching, and parallel/sequential processing modes.
// - **Task Delegation**: Pipeline for breaking complex tasks into subtasks
//   and delegating them to specialized agents.
// - **Multi-Agent Groups**: Create agent teams with shared memory, role-based
//   task assignment, and collaborative problem solving.
// - **Middleware Pipeline**: Pre/post model-call hooks for guardrails, logging,
//   cost tracking, and human-in-the-loop approval.
// - **Debate Engine**: Multi-perspective reasoning with Innovator, Devil's
//   Advocate, and Editor-in-Chief roles for robust decision making.
// - **Runnable Pipeline**: Composable data transformation pipeline with
//   streaming support, inspired by LangChain's LCEL.
// - **Storage Backends**: Pluggable persistence (in-memory, filesystem,
//   encoder-backed) for agent state and conversation history.
// - **Hub Integration**: Pull/push prompt templates from a shared hub
//   for team-wide reuse and versioning.
//
// @packageDocumentation
// @module @ghita/agents

import type { Agent, AgentGroup, AgentRole, AgentTask } from '@ghita/shared';
import type { AgentMemory } from '@ghita/memory';

/** Registry of registered skill tools. Key represents skill name/ID. */
export interface SkillRegistry {
  [key: string]: Record<string, unknown>;
}

/**
 * Message models and parser helpers for agent-to-LLM communications.
 */
export {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  FunctionMessage,
  messageFromData,
} from './messages/message.js';
/** Types representing chat messages, roles, and media content blocks. */
export type {
  MessageRole,
  ContentType,
  ContentPart,
  ToolCall,
  MessageMetadata,
  BaseMessageData,
  HumanMessageData,
  AIMessageData,
  SystemMessageData,
  ToolMessageData,
  FunctionMessageData,
  MessageData,
} from './messages/types.js';
/** Abstract base class defining structural properties of a conversation message. */
export { BaseMessage } from './messages/message.js';

/** ReAct (Reasoning + Acting) Agent runtime orchestrating tool iteration execution. */
export {
  ReActAgent,
  ReActIterationLimitError,
  ReActResumeConfirmationRequiredError,
  createReActAgent,
} from './react/agent.js';
/** Options configuring ReAct runs, tool schemas, and callback hooks. */
export type {
  ReActAgentConfig,
  ReActTool,
  AgentAction,
  AgentFinish,
  AgentStep,
  CreateReActAgentInput,
  ReActAgentRunResult,
  ReActAgentCallbacks,
  ReActCheckpoint,
  ReActCheckpointStatus,
  ReActCheckpointWriter,
  StructuredOutputSchema,
  PolicyGuard,
  ToolPolicyRequest,
  ToolPolicyDecision,
} from './react/types.js';

/** Pipeline executing interceptors sequentially before and after agent model actions. */
export { MiddlewarePipeline } from './middleware/pipeline.js';

export {
  lastNObservations,
  tagToolCalls,
  cacheControl,
  truncateByTokens,
  applyHistoryProcessors,
} from './middleware/history-processors.js';
export type { HistoryProcessor, ProcessorContext } from './middleware/history-processors.js';
export { createHistoryProcessorMiddleware } from './middleware/history-processor-middleware.js';
/** Types representing agent execution middleware, metrics, and approval states. */
export type {
  AgentMiddleware,
  MiddlewareContext,
  PreModelResult,
  PostModelResult,
  AgentStepContext,
  AgentStepResult,
  HumanApprovalRequest,
  HumanApprovalResponse,
  MiddlewarePipelineConfig,
  MiddlewareMetric,
  MiddlewareStats,
} from './middleware/types.js';

/** Flow engine organizing complex workflows into structured DAG step chains. */
export { Flow, createStep } from './flow/flow.js';
/** Configurations controlling flow runs, contexts, and steps. */
export type {
  FlowStep,
  FlowStepResult,
  FlowContext,
  FlowConfig,
  FlowRunResult,
  FlowProcessMode,
} from './flow/types.js';

/** Pipeline decomposing single tasks into smaller subtasks for team agents. */
export { TaskDelegationPipeline } from './orchestrator/pipeline.js';
/** Configs defining task decomposition plans and results. */
export type { DelegatedTask, PipelineConfig, PipelineResult } from './orchestrator/pipeline.js';

/** Adapters translating external agent definitions (LangGraph, OpenAI) to local agents. */
export { LangGraphAdapter } from './adapters/langgraph.js';
/** OpenAI-specific agent runner conversion middleware. */
export { OpenAIAgentsAdapter } from './adapters/openai-agents.js';
/** Types representing adapter interfaces and source engine configurations. */
export type {
  AgentAdapter,
  AdapterConvertedConfig,
  AdapterRunResult,
  LangGraphAgentConfig,
  LangGraphTool,
  LangGraphNode,
  LangGraphEdge,
  OpenAIAgentConfig,
  OpenAIAgentTool,
  OpenAIAgentResult,
} from './adapters/types.js';

/** Runnable transformer pipeline simplifying async data streams, inspired by LCEL. */
export { Runnable, LambdaRunnable, runnable, sequence, parallel } from './pipeline/runnable.js';
/** Configurations controlling pipeline transforms and streaming blocks. */
export type {
  RunnableConfig,
  StreamChunk,
  RunnableInput,
  TransformFn,
  StreamTransformFn,
} from './pipeline/types.js';

/** Pluggable storage mechanisms for maintaining agent state histories. */
export { InMemoryStorage } from './storage/memory.js';
/** Filesystem directory persistence engine for agent histories. */
export { FileSystemStorage } from './storage/filesystem.js';
/** Encoder-backed database translating state structures into binary streams. */
export { EncoderBackedStorage, JSONEncoder } from './storage/encoder.js';
/** Types defining storage backends and custom data serialization encoders. */
export type {
  StorageBackend,
  SerializedEntry,
  StorageOptions,
  EncoderFn,
  DecoderFn,
} from './storage/types.js';
export type { FileSystemStorageOptions } from './storage/filesystem.js';

/** Client communicating with a remote agent hub workspace. */
export { HubClient } from './hub/hub.js';
/** Configurations controlling prompt template indexing and search queries. */
export type {
  HubPrompt,
  HubConfig,
  HubSearchQuery,
  HubPushInput,
  HubCacheEntry,
} from './hub/types.js';

// --- Original exports below ---

export const AGENTS_VERSION = '0.0.0-preview';

export type AgentStatus = 'idle' | 'working' | 'completed' | 'error';

export interface ManagedAgent extends Agent {
  status: AgentStatus;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRuntimeContext {
  agent: ManagedAgent;
  task: AgentTask;
  skills?: SkillRegistry;
  memory?: AgentMemory;
  /** Aborted when the caller cancels/timeout — runtimes should observe it and stop early. */
  signal?: AbortSignal;
}

export type AgentRuntime = (context: AgentRuntimeContext) => Promise<string>;

export interface CreateAgentInput {
  name: string;
  role: AgentRole;
  description: string;
  skills?: string[];
  model?: string;
  systemPrompt?: string;
}

export interface CreateGroupInput {
  name: string;
  description: string;
  agents?: string[];
  task?: string;
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function now(): number {
  return Date.now();
}

function createTask(agentId: string, description: string, groupId?: string): AgentTask {
  return {
    id: generateId('task'),
    agentId,
    groupId,
    description,
    status: 'pending',
  };
}

const DEFAULT_RUNTIME: AgentRuntime = async ({ agent, task, memory }) => {
  const memoryContext = memory?.injectContext(task.description, { limit: 3 });
  const contextLine = memoryContext ? `\n\nContext:\n${memoryContext}` : '';
  return `${agent.name} (${agent.role}) accepted task "${task.description}".${contextLine}`;
};

export class AgentManager {
  private readonly agents = new Map<string, ManagedAgent>();
  private readonly tasks = new Map<string, AgentTask>();

  constructor(
    private readonly runtime: AgentRuntime = DEFAULT_RUNTIME,
    private readonly skills?: SkillRegistry,
    private readonly memory?: AgentMemory,
  ) {}

  create(input: CreateAgentInput): ManagedAgent {
    const timestamp = now();
    const agent: ManagedAgent = {
      id: generateId('agent'),
      name: input.name,
      role: input.role,
      description: input.description,
      skills: input.skills ?? [],
      model: input.model,
      systemPrompt: input.systemPrompt,
      status: 'idle',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.agents.set(agent.id, agent);
    return agent;
  }

  register(agent: Agent): ManagedAgent {
    const timestamp = now();
    const managed: ManagedAgent = {
      ...agent,
      status: 'idle',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.agents.set(managed.id, managed);
    return managed;
  }

  update(id: string, patch: Partial<Omit<ManagedAgent, 'id' | 'createdAt'>>): ManagedAgent {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Agent not found: ${id}`);
    const updated = { ...agent, ...patch, updatedAt: now() };
    this.agents.set(id, updated);
    return updated;
  }

  remove(id: string): boolean {
    return this.agents.delete(id);
  }

  get(id: string): ManagedAgent | undefined {
    return this.agents.get(id);
  }

  list(): ManagedAgent[] {
    return [...this.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  listByRole(role: AgentRole): ManagedAgent[] {
    return this.list().filter((agent) => agent.role === role);
  }

  listTasks(agentId?: string): AgentTask[] {
    const tasks = [...this.tasks.values()];
    const filtered = agentId ? tasks.filter((task) => task.agentId === agentId) : tasks;
    return filtered.sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
  }

  async assignTask(
    agentId: string,
    description: string,
    groupId?: string,
    options?: { signal?: AbortSignal },
  ): Promise<AgentTask> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    if (options?.signal?.aborted) {
      throw new Error(`Agent task cancelled before start: ${description.slice(0, 80)}`);
    }

    const task = createTask(agentId, description, groupId);
    this.tasks.set(task.id, task);
    this.update(agentId, { status: 'working' });

    const running: AgentTask = {
      ...task,
      status: 'running',
      startTime: now(),
    };
    this.tasks.set(task.id, running);

    try {
      const result = await this.runtime({
        agent,
        task: running,
        skills: this.skills,
        memory: this.memory,
        signal: options?.signal,
      });
      const completed: AgentTask = {
        ...running,
        status: 'completed',
        result,
        endTime: now(),
      };
      this.tasks.set(task.id, completed);
      this.update(agentId, { status: 'completed' });
      this.memory?.remember({
        type: 'context',
        content: `${agent.name} completed: ${description}`,
        metadata: { agentId, taskId: task.id, groupId },
      });
      return completed;
    } catch (error) {
      const failed: AgentTask = {
        ...running,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        endTime: now(),
      };
      this.tasks.set(task.id, failed);
      this.update(agentId, { status: 'error' });
      return failed;
    }
  }
}

export class AgentGroupManager {
  private readonly groups = new Map<string, AgentGroup>();

  constructor(private readonly agents: AgentManager) {}

  create(input: CreateGroupInput): AgentGroup {
    const group: AgentGroup = {
      id: generateId('group'),
      name: input.name,
      description: input.description,
      agents: input.agents ?? [],
      task: input.task,
      status: 'idle',
    };
    this.groups.set(group.id, group);
    return group;
  }

  register(group: AgentGroup): AgentGroup {
    this.groups.set(group.id, group);
    return group;
  }

  get(id: string): AgentGroup | undefined {
    return this.groups.get(id);
  }

  list(): AgentGroup[] {
    return [...this.groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  addAgent(groupId: string, agentId: string): AgentGroup {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Group not found: ${groupId}`);
    if (!this.agents.get(agentId)) throw new Error(`Agent not found: ${agentId}`);
    if (group.agents.includes(agentId)) return group;

    const updated = { ...group, agents: [...group.agents, agentId] };
    this.groups.set(groupId, updated);
    return updated;
  }

  removeAgent(groupId: string, agentId: string): AgentGroup {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Group not found: ${groupId}`);

    const updated = { ...group, agents: group.agents.filter((id) => id !== agentId) };
    this.groups.set(groupId, updated);
    return updated;
  }

  async runGroup(groupId: string, taskDescription?: string): Promise<AgentTask[]> {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Group not found: ${groupId}`);

    const description = taskDescription ?? group.task ?? group.description;
    this.groups.set(groupId, { ...group, status: 'working', task: description });

    const tasks: AgentTask[] = [];
    for (const agentId of group.agents) {
      tasks.push(await this.agents.assignTask(agentId, description, groupId));
    }

    const failed = tasks.some((task) => task.status === 'failed');
    this.groups.set(groupId, {
      ...group,
      task: description,
      status: failed ? 'error' : 'completed',
    });
    return tasks;
  }
}

export function createDefaultAgentManager(
  skills?: SkillRegistry,
  memory?: AgentMemory,
): AgentManager {
  const manager = new AgentManager(undefined, skills, memory);

  manager.create({
    name: 'Coder Agent',
    role: 'coder',
    description: 'Implements scoped code changes.',
    skills: ['file.read', 'file.write', 'terminal.run'],
  });
  manager.create({
    name: 'Reviewer Agent',
    role: 'reviewer',
    description: 'Reviews code for correctness, risk, and missing tests.',
    skills: ['file.read', 'terminal.run'],
  });
  manager.create({
    name: 'Browser Agent',
    role: 'executor',
    description: 'Controls browser workflows and extracts page data.',
    skills: ['browser.open', 'browser.navigate', 'browser.extract', 'browser.fill'],
  });
  manager.create({
    name: 'Desktop Agent',
    role: 'executor',
    description: 'Controls desktop mouse, keyboard, screenshots, and apps.',
    skills: [
      'computer.moveMouse',
      'computer.click',
      'computer.typeText',
      'screenshot.capture',
      'app.open',
    ],
  });
  manager.create({
    name: 'Memory Agent',
    role: 'planner',
    description: 'Stores session context and injects relevant memories into tasks.',
    skills: ['file.read'],
  });

  return manager;
}

export function createDefaultAgentGroupManager(agentManager: AgentManager): AgentGroupManager {
  const groupManager = new AgentGroupManager(agentManager);
  const agents = agentManager.list();
  const byName = new Map(agents.map((agent) => [agent.name, agent.id]));

  groupManager.create({
    name: 'Dev Team',
    description: 'Code implementation, review, and verification.',
    agents: [byName.get('Coder Agent'), byName.get('Reviewer Agent')].filter((id): id is string =>
      Boolean(id),
    ),
    task: 'Implement a scoped code change and verify it.',
  });
  groupManager.create({
    name: 'Automation Team',
    description: 'Browser and desktop automation workflows.',
    agents: [byName.get('Browser Agent'), byName.get('Desktop Agent')].filter((id): id is string =>
      Boolean(id),
    ),
    task: 'Open browser, inspect page data, and execute desktop actions when approved.',
  });
  groupManager.create({
    name: 'Memory Team',
    description: 'Session memory and context planning.',
    agents: [byName.get('Memory Agent')].filter((id): id is string => Boolean(id)),
    task: 'Store session facts and inject relevant context.',
  });

  return groupManager;
}

export { SubagentSpawner } from './subagent/spawner.js';
export { AgentChannel } from './subagent/channel.js';
export { StateSyncManager } from './subagent/sync.js';
export type {
  SubagentSpawnInput,
  SubagentSpawnResult,
  SubagentState,
  SpawnerConfig,
  ChannelMessage,
  ChannelSubscription,
  StateSnapshot,
  StateDiff,
  SyncConfig,
} from './subagent/types.js';
export { CronScheduler } from './scheduler/cron.js';
export type { ScheduledTaskConfig, ScheduledTask } from './scheduler/types.js';

export { DebateEngine } from './orchestrator/debateEngine.js';
export type {
  DebateResult,
  DebateCallbacks,
  DebateEngineOptions,
} from './orchestrator/debateEngine.js';

export { GhitAgentClient } from './sdk/client.js';
export type { AgentSDKConfig, SendMessageOptions, AgentMessage } from './sdk/types.js';

export { AgentProtocolServer } from './protocol/ap.js';
export type { APTask, APStep, APArtifact } from './protocol/ap.js';
export { AgentRouter } from './router/router.js';
export type { ComplexityLevel, RouteResolution } from './router/router.js';

export { WorkflowAgent } from './workflow/engine.js';
export type { WorkflowStep, WorkflowCallbacks } from './workflow/engine.js';

export {
  ASTLockEngine,
  ASTLockMiddleware,
  buildHierarchy,
  computeSemanticHash,
  loadASTLockConfig,
} from './checker/astLock.js';
export type { HierarchicalSymbol, ASTLockConfig } from './checker/astLock.js';

export { GitSafePointManager, GitSafePointMiddleware } from './git/workflow.js';

export { MarkdownRulesChecker, MarkdownChecksMiddleware } from './checker/markdownRules.js';
export type { MarkdownRule, CheckIssue } from './checker/markdownRules.js';

// --- Instinct System (ECC & Superpowers Inspired) ---
export {
  InstinctEngine,
  BUILTIN_INSTINCTS,
  type InstinctRule,
  type InstinctContext,
} from './instincts/instinct-engine.js';

// --- Super-Agent Modules (v0.2.5) ---
export {
  AutoRepairGate,
  type TestRunResult,
  type RepairAttempt,
  type AutoRepairOptions,
} from './checker/autoRepairGate.js';
export { SwarmSpawner, type SwarmTask, type SwarmTaskResult } from './subagent/swarmSpawner.js';
export { DAGDecomposer, type DAGTaskNode } from './autogpt/dag-decomposer.js';
export {
  CrewAIOrchestrator,
  type CrewMember,
  type CrewTaskSpec,
} from './crew/crewai-orchestrator.js';

// v0.4.9 A3: Agent Work Loop harness (evidence-bounded evaluation)
export {
  WorkLoopEvaluator,
  checkToDimension,
  applyRepairProgress,
  renderSessionReport,
} from './harness/index.js';
export type {
  WorkLoopDimension,
  WorkLoopCheckId,
  EvidenceState,
  CheckResult,
  WorkLoopFinding,
  TaskEpisode,
  DimensionScore,
  WorkLoopReview,
} from './harness/index.js';

export * from './track5/index.js';

export * from './hooks/index.js';

export * from './headless/index.js';

export * from './mailbox/index.js';

export {
  createSummarizationMiddleware,
  createContextEditingMiddleware,
  createToolErrorRecoveryMiddleware,
  createPiiRedactionMiddleware,
} from './middleware/context-middleware.js';

export * from './interjection/index.js';

export * from './routing/index.js';

export { runWithRetry, createHeuristicReviewer, createLlmReviewer } from './retry-agent.js';
export type { ReviewerVerdict, ReviewerFn, RetryAgentConfig } from './retry-agent.js';

export { createInitialState, agentRunReducer, replayEvents } from './reducer.js';
export type { AgentRunEvent, AgentRunState } from './reducer.js';
