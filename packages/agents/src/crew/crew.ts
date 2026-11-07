// Crew — multi-agent team orchestration (clean-room TS port of the CrewAI
// design: identity-triplet agents, context-linked tasks, sequential and
// hierarchical processes, delegation-as-tools, best-effort planning and
// shared memory). See docs/crew-orchestration.md for the full mapping and
// attribution (CrewAI, MIT).

import type { ReActTool } from '../react/types.js';
import { CrewEventBus } from './event-bus.js';
import { createDelegationTools } from './delegation.js';
import { createMemoryTools } from './memory.js';
import { RpmLimiter } from './rpm.js';
import type { CrewPlanner } from './planner.js';
import type { CrewPlanStep } from './types.js';
import type {
  CrewAgentSpec,
  CrewEvent,
  CrewMemoryBridge,
  CrewProcess,
  CrewResult,
  CrewTask,
  CrewTaskExecutor,
  CrewTaskOutput,
  CrewUsage,
  CrewUsageSample,
} from './types.js';

export interface CrewConfig {
  id?: string;
  process?: CrewProcess;
  /** Pre-flight planner; only consulted when `planning` is true. */
  planner?: CrewPlanner;
  planning?: boolean;
  /** Optional shared memory: recalled before each task, written after. */
  memory?: CrewMemoryBridge;
  /** Hierarchical manager. Synthesized when omitted. */
  manager?: CrewAgentSpec;
  /** Delegation budget per task in hierarchical mode (default 8). */
  maxDelegationsPerTask?: number;
  /**
   * Default wall-clock deadline per task in milliseconds (CrewAI
   * `max_execution_time`). A task-level `maxExecutionTime` overrides it.
   * Covers LLM retries and guardrail revisions; the executor's signal aborts
   * when it fires. When unset, tasks run without a deadline.
   */
  maxExecutionTime?: number;
  /**
   * Transient-LLM-error retry budget per task (default 3) and per run
   * (default 10, NOT reset between tasks). The run-level cap bounds the
   * total burn of a flaky provider across a whole crew run.
   */
  llmRetriesPerTask?: number;
  llmRetriesPerRun?: number;
  /** Giới hạn request/phút cho các lần chạy executor (5.1); bỏ trống = không giới hạn. */
  maxRpm?: number;
  /**
   * (5.4) LLM judge cho guardrail dạng MÔ TẢ (string). Bắt buộc khi có task
   * nào dùng guardrail string — validateKickoff chặn trước khi burn token.
   */
  llmJudge?: (description: string, output: string) => Promise<boolean | string>;
  /** Cooperative cancellation; checked between tasks and inside tools. */
  signal?: AbortSignal;
  /** Stream of replayable run events. Listener errors never break the run. */
  onEvent?: (event: CrewEvent) => void;
}

export interface CrewKickoffOptions {
  /** Interpolated into `{key}` placeholders in task descriptions. */
  inputs?: Record<string, unknown>;
  /** Task executor; required unless one was provided in `setExecutor`. */
  executor?: CrewTaskExecutor;
}

const MEMORY_OUTPUT_LIMIT = 500;

/** Backoff between transient-LLM-error retries: 250ms doubling, capped 2s. */
const LLM_RETRY_BASE_DELAY_MS = 250;
const LLM_RETRY_MAX_DELAY_MS = 2000;

/**
 * Thrown when a task exceeds its wall-clock deadline. Matches CrewAI
 * `max_execution_time` semantics: the task is abandoned (the executor's
 * signal aborts), the run fails with the timeout as its error.
 */
export class CrewTaskTimeoutError extends Error {
  readonly taskId: string;
  readonly timeoutMs: number;

  constructor(taskId: string, timeoutMs: number) {
    super(`Task "${taskId}" timed out after ${timeoutMs}ms (deadline covers retries and guardrail revisions).`);
    this.name = 'CrewTaskTimeoutError';
    this.taskId = taskId;
    this.timeoutMs = timeoutMs;
  }
}

function crewId(): string {
  return `crew_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function interpolate(text: string, inputs: Record<string, unknown>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = inputs[key];
    if (value === undefined) return match;
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * Conservative transient-error classifier for LLM call failures (rate
 * limiting, provider outages, network hiccups). Only these are retried by the
 * crew's retry loop; anything else (policy, parse, cancel, real bugs) fails
 * the task immediately so real defects surface instead of being masked.
 */
export function isTransientLlmError(message: string): boolean {
  const normalized = message.toLowerCase();
  const patterns = [
    'rate limit',
    'ratelimit',
    '429',
    'too many requests',
    'overloaded',
    'over capacity',
    'timeout',
    'timed out',
    'etimedout',
    'econnreset',
    'econnrefused',
    'econnaborted',
    'enotfound',
    'eai_again',
    'network error',
    'socket hang up',
    'fetch failed',
    'bad gateway',
    'service unavailable',
    'gateway timeout',
    '502',
    '503',
    '504',
  ];
  return patterns.some((p) => normalized.includes(p));
}

/** Backoff delay before LLM retry N (1-based): 250ms doubling, capped 2s. */
function llmRetryDelayMs(attempt: number): number {
  return Math.min(LLM_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), LLM_RETRY_MAX_DELAY_MS);
}

/** Sleep for the retry backoff; resolves early-ish when aborted (next executor call re-checks the signal). */
function sleepLlmRetry(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Accumulate a per-call usage sample into a cumulative aggregate (mutates `total`). */
function addUsage(total: CrewUsage, sample: CrewUsageSample): void {
  total.promptTokens += sample.promptTokens;
  total.cachedTokens = (total.cachedTokens ?? 0) + (sample.cachedTokens ?? 0);
  total.completionTokens += sample.completionTokens;
  total.requests += sample.requests;
}

/**
 * Crew assembles specialized agents into a team and executes an ordered task
 * list through a sequential or hierarchical process.
 *
 * Sequential runs each task on its assigned member, feeding prior outputs as
 * context. Hierarchical runs a manager whose only duty is routing: it solves
 * each task by delegating to crewmates through the `delegate_work` /
 * `ask_question` tools and integrates their answers.
 */
export class Crew {
  readonly id: string;
  private readonly agentsMap = new Map<string, CrewAgentSpec>();
  private readonly tasksList: CrewTask[] = [];
  private readonly config: CrewConfig;
  private executor?: CrewTaskExecutor;

  /** Event bus nội bộ (5.3): nhiều listener độc lập, lỗi listener cô lập. */
  private readonly bus = new CrewEventBus();
  /** Giới hạn request/phút (5.1), tạo khi config.maxRpm được đặt. */
  private readonly rpm?: RpmLimiter;

  constructor(config: CrewConfig = {}) {
    this.id = config.id ?? crewId();
    this.config = config;
    if (config.onEvent) this.bus.on(config.onEvent);
    if (config.maxRpm !== undefined) this.rpm = new RpmLimiter(config.maxRpm);
  }

  setExecutor(executor: CrewTaskExecutor): this {
    this.executor = executor;
    return this;
  }

  addAgent(spec: CrewAgentSpec): this {
    if (this.agentsMap.has(spec.id)) {
      throw new Error(`Crew agent id already exists: ${spec.id}`);
    }
    this.agentsMap.set(spec.id, spec);
    return this;
  }

  addTask(task: CrewTask): this {
    if (this.tasksList.some((t) => t.id === task.id)) {
      throw new Error(`Crew task id already exists: ${task.id}`);
    }
    this.tasksList.push(task);
    return this;
  }

  listAgents(): CrewAgentSpec[] {
    return [...this.agentsMap.values()];
  }

  listTasks(): CrewTask[] {
    return [...this.tasksList];
  }

  async kickoff(options: CrewKickoffOptions = {}): Promise<CrewResult> {
    const executor = options.executor ?? this.executor;
    if (!executor) {
      throw new Error('Crew.kickoff requires a task executor.');
    }
    if (this.tasksList.length === 0) {
      throw new Error('Crew.kickoff requires at least one task.');
    }
    const process = this.config.process ?? 'sequential';
    this.validateKickoff(process);
    // Only the sequential process routes tasks to members; hierarchical tasks
    // are solved by the manager, so member resolution is not required there.
    if (process === 'sequential') {
      for (const task of this.tasksList) {
        if (!this.resolveAgent(task)) {
          throw new Error(
            `Task "${task.id}" cannot be resolved to a crew member (agentId="${task.agentId ?? ''}"). ` +
              `Available: ${this.listAgents().map((a) => `${a.id} (${a.role})`).join(', ') || 'none'}.`,
          );
        }
      }
    }
    const inputs = options.inputs ?? {};
    const startTime = Date.now();
    // P2 fix: state của run nằm Ở TẠI (không phải field instance) — hai
    // kickoff() chạy đồng thời trên cùng Crew không còn nhiễm chéo outputs
    // và không chung trần retry.
    const partialOutputs: CrewTaskOutput[] = [];
    const retryState = { used: 0 };
    const runUsage: CrewUsage = { promptTokens: 0, completionTokens: 0, requests: 0 };
    const emit = (event: CrewEvent): void => {
      this.bus.emit(event);
    };

    emit({
      type: 'crew_start',
      crewId: this.id,
      process,
      taskCount: this.tasksList.length,
      timestamp: Date.now(),
    });

    let plans: Map<string, CrewPlanStep> | undefined;
    if (this.config.planning && this.config.planner) {
      // The planner is an LLM call outside any executor's abort wiring —
      // check the signal on both sides so a cancel cannot wedge the run.
      this.throwIfAborted();
      const steps = await this.config.planner.plan(
        this.listAgents(),
        this.tasksList,
        inputs,
      );
      this.throwIfAborted();
      plans = new Map(steps.map((step) => [step.taskId, step]));
      if (steps.length > 0) {
        emit({ type: 'plan_created', steps, timestamp: Date.now() });
      }
    }

    try {
      const taskOutputs =
        process === 'hierarchical'
          ? await this.runHierarchical(executor, inputs, plans, emit, runUsage, partialOutputs, retryState)
          : await this.runSequential(executor, inputs, plans, emit, runUsage, partialOutputs, retryState);
      const last = taskOutputs.at(-1);
      const result: CrewResult = {
        crewId: this.id,
        status: 'completed',
        output: last?.output ?? '',
        taskOutputs,
        duration: Date.now() - startTime,
        usage: { ...runUsage },
      };
      emit({
        type: 'crew_complete',
        crewId: this.id,
        status: 'completed',
        output: result.output,
        duration: result.duration,
        usage: { ...runUsage },
        timestamp: Date.now(),
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const partial = [...partialOutputs];
      const result: CrewResult = {
        crewId: this.id,
        status: 'failed',
        output: partial.at(-1)?.output ?? '',
        taskOutputs: partial,
        duration: Date.now() - startTime,
        usage: { ...runUsage },
        error: message,
      };
      emit({
        type: 'crew_complete',
        crewId: this.id,
        status: 'failed',
        output: result.output,
        duration: result.duration,
        usage: { ...runUsage },
        timestamp: Date.now(),
      });
      return result;
    }
  }

  /**
   * Pre-flight validation that fails the run BEFORE any LLM call is made
   * (CrewAI validates at kickoff: manager wiring, context references). Each
   * branch returns a specific, actionable message instead of a mid-run
   * failure that would already have burned tokens.
   */
  private validateKickoff(process: CrewProcess): void {
    if (process === 'hierarchical') {
      if (this.config.manager && this.agentsMap.has(this.config.manager.id)) {
        throw new Error(
          `Crew manager "${this.config.manager.id}" must not also be added as a crew member ` +
            '(the manager routes, members execute — one role per id).',
        );
      }
      if (this.listAgents().length === 0) {
        throw new Error(
          'Hierarchical crew requires at least one crewmate besides the manager ' +
            '(the manager has nobody to delegate to).',
        );
      }
    }
    // (5.4) Guardrail dạng mô tả cần một LLM judge để chấm.
    for (const task of this.tasksList) {
      if (typeof task.guardrail === 'string' && !this.config.llmJudge) {
        throw new Error(
          `Task "${  task.id  }" uses a guardrail description but Crew config.llmJudge is not set. ` +
            `Pass llmJudge or convert the guardrail to a function.`,
        );
      }
    }
    // Task contexts may only reference tasks that run EARLIER (CrewAI
    // validate_context_no_future_tasks) and must reference real task ids.
    for (let i = 0; i < this.tasksList.length; i += 1) {
      const task = this.tasksList[i];
      if (!task) continue;
      if (!task.context || task.context.length === 0) continue;
      for (const ctxId of task.context) {
        const source = this.tasksList.findIndex((t) => t.id === ctxId);
        if (source === -1) {
          throw new Error(
            `Task "${task.id}" context references unknown task "${ctxId}". ` +
              `Known tasks: ${this.tasksList.map((t) => t.id).join(', ')}.`,
          );
        }
        if (source >= i) {
          throw new Error(
            `Task "${task.id}" context references future task "${ctxId}" — ` +
              'only outputs of tasks that run earlier can be used as context.',
          );
        }
      }
    }
  }

  // ---- Processes ----

  private async runSequential(
    executor: CrewTaskExecutor,
    inputs: Record<string, unknown>,
    plans: Map<string, CrewPlanStep> | undefined,
    emit: (event: CrewEvent) => void,
    runUsage: CrewUsage,
    partialOutputs: CrewTaskOutput[],
    retryState: { used: number },
  ): Promise<CrewTaskOutput[]> {
    const outputs = partialOutputs;
    for (const task of this.tasksList) {
      this.throwIfAborted();
      const agent = this.resolveAgent(task) as CrewAgentSpec;
      const context = this.assembleContext(task, outputs);
      const memoryContext = this.safeRecall(task.description);
      const prompt = this.buildMemberPrompt(
        task,
        context,
        inputs,
        plans?.get(task.id)?.plan,
        memoryContext,
      );
      const output = await this.executeTask(task, agent, prompt, executor, emit, runUsage, retryState);
      outputs.push(output);
    }
    return outputs;
  }

  private async runHierarchical(
    executor: CrewTaskExecutor,
    inputs: Record<string, unknown>,
    plans: Map<string, CrewPlanStep> | undefined,
    emit: (event: CrewEvent) => void,
    runUsage: CrewUsage,
    partialOutputs: CrewTaskOutput[],
    retryState: { used: number },
  ): Promise<CrewTaskOutput[]> {
    const manager = this.config.manager ?? this.synthesizeManager();
    const crewmates = this.listAgents().filter((a) => a.id !== manager.id);
    const outputs = partialOutputs;

    for (const task of this.tasksList) {
      this.throwIfAborted();
      const context = this.assembleContext(task, outputs);
      const memoryContext = this.safeRecall(task.description);
      const roster = crewmates.map((m) => `- ${m.name} (${m.role}): ${m.goal}`).join('\n');
      const plan = plans?.get(task.id)?.plan;
      const prompt = [
        '# Task',
        interpolate(task.description, inputs),
        '',
        '# Expected output',
        task.expectedOutput ?? '(unspecified — use professional judgement)',
        ...(plan ? ['', '# Plan', plan] : []),
        ...(context ? ['', '# Context from previous tasks', context] : []),
        ...(memoryContext ? ['', '# Workspace memory', memoryContext] : []),
        '',
        '# Crew roster',
        roster,
        '',
        'Route the task with the `delegate_work` tool, gather missing details with',
        '`ask_question`, then reply with the final answer yourself. Your final',
        'message is recorded as the task output.',
      ].join('\n');

      const output = await this.executeTask(
        task,
        manager,
        prompt,
        executor,
        emit,
        runUsage,
        retryState,
        { crewmates, hierarchical: true },
      );
      outputs.push(output);
    }
    return outputs;
  }

  // ---- Task execution ----

  private async executeTask(
    task: CrewTask,
    agent: CrewAgentSpec,
    prompt: string,
    executor: CrewTaskExecutor,
    emit: (event: CrewEvent) => void,
    runUsage: CrewUsage,
    retryState: { used: number },
    delegation?: { crewmates: CrewAgentSpec[]; hierarchical: boolean },
  ): Promise<CrewTaskOutput> {
    emit({ type: 'task_start', taskId: task.id, agentId: agent.id, timestamp: Date.now() });
    const startedAt = Date.now();

    // Per-task abort wiring: the shared crew signal and the task deadline both
    // funnel into one combined signal (no manual listener cleanup — signals
    // created by AbortSignal.any are collected with their controllers).
    const outerSignal = this.config.signal;
    const taskAbort = new AbortController();
    const taskSignal = outerSignal ? AbortSignal.any([outerSignal, taskAbort.signal]) : taskAbort.signal;
    const cancelled = (): boolean => taskSignal.aborted;

    // A task may emit at most ONE terminal-event dedup guard: complete,
    // failed and timeout are mutually exclusive for one task.
    let terminalEmitted = false;
    const emitTerminal = (event: CrewEvent): void => {
      if (terminalEmitted) return;
      if (event.type === 'task_failed' || event.type === 'task_timeout' || event.type === 'task_complete') {
        terminalEmitted = true;
      }
      emit(event);
    };

    // Token usage aggregation (per task + per run): the executor reports each
    // LLM call through `onUsage`; the crew sums samples into task and run
    // totals (CrewAI UsageMetrics pattern).
    const taskUsage: CrewUsage = { promptTokens: 0, completionTokens: 0, requests: 0 };
    const onUsage = (sample: CrewUsageSample): void => {
      addUsage(taskUsage, sample);
      addUsage(runUsage, sample);
    };

    const delegationBudget = this.config.maxDelegationsPerTask ?? 8;
    const delegationTools: ReActTool[] = [];
    let delegationResult: ReturnType<typeof createDelegationTools> | undefined;
    if (delegation || agent.allowDelegation) {
      const members = delegation ? delegation.crewmates : this.listAgents().filter((a) => a.id !== agent.id);
      delegationResult = createDelegationTools({
        members,
        currentAgent: agent,
        maxDelegations: delegationBudget,
        signal: taskSignal,
        onDelegation: emit,
        // Members never receive delegation tools: it keeps the recursion
        // depth fixed and matches the inline-execution semantics.
        executeMemberTask: async (member, memberPrompt) => {
          // P2 fix: member delegate cũng chịu RPM (trước đây bypass limiter)
          // và ĐƯỢC memory tools (trước đây mất crew_memorize/crew_recall).
          if (this.rpm) await this.acquireRpm(taskSignal);
          return executor({
            crewId: this.id,
            taskId: task.id,
            agent: member,
            prompt: memberPrompt,
            tools: [...(member.tools ?? []), ...memoryTools],
            signal: taskSignal,
            onUsage,
          });
        },
      });
      delegationTools.push(...delegationResult.tools);
    }

    const baseTools = task.tools ?? agent.tools ?? [];
    // Track 5.2 — memory là tool: agent tự memorize/recall giữa task.
    const memoryTools = this.config.memory ? createMemoryTools(this.config.memory) : [];
    const tools = [...baseTools, ...delegationTools, ...memoryTools];
    const maxRetries = task.maxRetries ?? 2;

    // Every executor invocation funnels through here so an unexpected throw
    // still emits exactly ONE terminal event (the UI would otherwise show the
    // task as running forever). Transient LLM failures (rate limits, network
    // hiccups) are retried with backoff under a DUAL cap — per task and per
    // run (the run cap is NOT reset between tasks) — so a flaky provider can
    // neither wedge a task forever nor burn an unbounded run budget.
    const perTaskCap = Math.max(0, this.config.llmRetriesPerTask ?? 3);
    const perRunCap = Math.max(0, this.config.llmRetriesPerRun ?? 10);
    let taskLlmRetries = 0;

    const runExecutor = async (taskPrompt: string): Promise<string> => {
      for (;;) {
        try {
          if (this.rpm) await this.acquireRpm(taskSignal);
          return await executor({
            crewId: this.id,
            taskId: task.id,
            agent,
            prompt: taskPrompt,
            tools,
            signal: taskSignal,
            onUsage,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (cancelled()) {
            // Cancelled — by the user's signal OR by the task deadline. A
            // deadline aborts the signal synchronously, so the executor's
            // rejection lands here BEFORE the race settles; emitting
            // `task_failed` now would win the dedup and mask the real cause.
            // The deadline path emits `task_timeout` itself; only user
            // cancellation reports `task_failed` here.
            const deadlineFired = taskAbort.signal.reason instanceof CrewTaskTimeoutError;
            if (!deadlineFired) {
              emitTerminal({
                type: 'task_failed',
                taskId: task.id,
                agentId: agent.id,
                error: message,
                timestamp: Date.now(),
              });
            }
            throw err;
          }
          const canRetry =
            isTransientLlmError(message) && taskLlmRetries < perTaskCap && retryState.used < perRunCap;
          if (!canRetry) {
            emitTerminal({
              type: 'task_failed',
              taskId: task.id,
              agentId: agent.id,
              error: message,
              timestamp: Date.now(),
            });
            throw err;
          }
          taskLlmRetries += 1;
          retryState.used += 1;
          emit({
            type: 'task_llm_retry',
            taskId: task.id,
            agentId: agent.id,
            attempt: taskLlmRetries,
            reason: message,
            timestamp: Date.now(),
          });
          await sleepLlmRetry(llmRetryDelayMs(taskLlmRetries));
        }
      }
    };

    // Deadline (CrewAI `max_execution_time`): the WHOLE task — initial run,
    // LLM retries AND guardrail revisions — shares ONE wall-clock budget:
    // each attempt races the REMAINING time, not a fresh full timeoutMs
    // (khác sẽ khiến tổng thời gian task phình tới timeoutMs × attempts).
    const timeoutMs = task.maxExecutionTime ?? this.config.maxExecutionTime;
    const deadlineAt = timeoutMs && timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
    // Deadline dùng chung cho MỌI promise trong task (executor + guardrail/
    // llmJudge — P2 fix: judge chậm/treo không còn vượt maxExecutionTime).
    const underDeadline = <T,>(p: Promise<T>): Promise<T> => {
      if (deadlineAt === undefined) return p;
      const remaining = deadlineAt - Date.now();
      const timeoutErr = () => new CrewTaskTimeoutError(task.id, timeoutMs as number);
      if (remaining <= 0) {
        p.catch(() => undefined);
        taskAbort.abort(timeoutErr());
        return Promise.reject(timeoutErr());
      }
      p.catch(() => undefined); // late failure sau deadline không được thành unhandledRejection
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const err = timeoutErr();
            taskAbort.abort(err);
            reject(err);
          }, remaining);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    };

    let retries = 0;
    // Deadline wrapper that also reports the `task_timeout` terminal event
    // when the race loses to the timer.
    const runUnderDeadline = async (taskPrompt: string): Promise<string> => {
      try {
        return await underDeadline(runExecutor(taskPrompt));
      } catch (err) {
        if (err instanceof CrewTaskTimeoutError) {
          emitTerminal({
            type: 'task_timeout',
            taskId: task.id,
            agentId: agent.id,
            timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : 0,
            timestamp: Date.now(),
          });
        }
        throw err;
      }
    };

    let output = await runUnderDeadline(prompt);

    const guardrail = this.resolveGuardrail(task);
    if (guardrail) {
      let verdict: boolean | string;
      try {
        verdict = await underDeadline(Promise.resolve(guardrail(output)));
      } catch (err) {
        // Judge lỗi (LLM/network) cũng phải có terminal event, nếu không UI
        // treo task "running" vĩnh viễn — đi ngược invariant dedup ở trên.
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof CrewTaskTimeoutError) {
          emitTerminal({
            type: 'task_timeout',
            taskId: task.id,
            agentId: agent.id,
            timeoutMs: timeoutMs as number,
            timestamp: Date.now(),
          });
        } else         emitTerminal({
          type: 'task_failed',
          taskId: task.id,
          agentId: agent.id,
          error: `Guardrail judge failed: ${  message}`,
          timestamp: Date.now(),
        });
        throw err;
      }
      while (verdict !== true && verdict !== '') {
        const reason = typeof verdict === 'string' ? verdict : 'Guardrail rejected the output.';
        if (retries >= maxRetries) {
          const error = `Task "${task.id}" failed its guardrail after ${retries + 1} attempt(s): ${reason}`;
          emitTerminal({ type: 'task_failed', taskId: task.id, agentId: agent.id, error, timestamp: Date.now() });
          throw new Error(error);
        }
        retries += 1;
        emit({
          type: 'task_guardrail_retry',
          taskId: task.id,
          attempt: retries,
          reason,
          timestamp: Date.now(),
        });
        const revisionPrompt = [
          prompt,
          '',
          '# Previous attempt (rejected by the guardrail)',
          output,
          '',
          '# Guardrail feedback',
          reason,
          '',
          'Revise your answer so it satisfies the expected output, then reply with the full corrected result.',
        ].join('\n');
        output = await runUnderDeadline(revisionPrompt);
        try {
          verdict = await underDeadline(Promise.resolve(guardrail(output)));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof CrewTaskTimeoutError) {
            emitTerminal({
              type: 'task_timeout',
              taskId: task.id,
              agentId: agent.id,
              timeoutMs: timeoutMs as number,
              timestamp: Date.now(),
            });
          } else           emitTerminal({
            type: 'task_failed',
            taskId: task.id,
            agentId: agent.id,
            error: `Guardrail judge failed: ${  message}`,
            timestamp: Date.now(),
          });
          throw err;
        }
      }
    }

    const record: CrewTaskOutput = {
      taskId: task.id,
      agentId: agent.id,
      output,
      duration: Date.now() - startedAt,
      retries,
      ...(taskLlmRetries > 0 ? { llmRetries: taskLlmRetries } : {}),
      ...(taskUsage.requests > 0 ? { usage: { ...taskUsage } } : {}),
      delegations: delegationResult?.accepted() ?? 0,
    };
    emitTerminal({
      type: 'task_complete',
      taskId: task.id,
      agentId: agent.id,
      output,
      duration: record.duration,
      timestamp: Date.now(),
    });
    this.safeRemember(
      `Task "${task.id}" completed by ${agent.name}: ${truncate(output, MEMORY_OUTPUT_LIMIT)}`,
      { crewId: this.id, taskId: task.id, agentId: agent.id },
    );
    return record;
  }

  /**
   * (5.4) Guardrail dạng MÔ TẢ string → bọc qua config.llmJudge (LLM chấm
   * output theo mô tả, CrewAI llm_guardrail pattern). Hàm guardrail tự viết
   * đi thẳng. llmJudge thiếu thì validateKickoff đã chặn trước.
   */
  private resolveGuardrail(task: CrewTask):
    | ((output: string) => boolean | string | Promise<boolean | string>)
    | undefined {
    const raw = task.guardrail;
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') return raw;
    const judge = this.config.llmJudge;
    if (!judge) {
      throw new Error(
        `Task "${  task.id  }" guardrail is a description but Crew config.llmJudge is not set.`,
      );
    }
    return async (output: string) => judge(raw, output);
  }

  // ---- Prompting & resolution ----

  private buildMemberPrompt(
    task: CrewTask,
    context: string,
    inputs: Record<string, unknown>,
    plan?: string,
    memoryContext?: string,
  ): string {
    const inputEntries = Object.entries(inputs);
    return [
      '# Task',
      interpolate(task.description, inputs),
      '',
      '# Expected output',
      task.expectedOutput ?? '(unspecified — use professional judgement)',
      ...(plan ? ['', '# Plan', plan] : []),
      '',
      '# Context from the crew',
      context || '(no prior task output)',
      ...(memoryContext ? ['', '# Workspace memory', memoryContext] : []),
      ...(inputEntries.length > 0
        ? ['', '# Crew inputs', JSON.stringify(Object.fromEntries(inputEntries), null, 2)]
        : []),
    ].join('\n');
  }

  /** Context blocks for a task: explicit `task.context` list or all prior outputs. */
  private assembleContext(task: CrewTask, outputs: CrewTaskOutput[]): string {
    // An empty `context` array means "no explicit list" (CrewAI default:
    // every prior output is provided) — otherwise UI-only runs would ship
    // `context: []` and every task would run blind.
    const allowed = task.context && task.context.length > 0 ? task.context : undefined;
    const relevant = allowed ? outputs.filter((o) => allowed.includes(o.taskId)) : outputs;
    return relevant
      .map((o) => {
        const agent = o.agentId ? this.agentsMap.get(o.agentId) : undefined;
        return `[${o.taskId}${agent ? ` — ${agent.name}` : ''}]:\n${o.output}`;
      })
      .join('\n\n');
  }

  /** Resolve a task's member: exact id first, then role match (CrewAI-style). */
  private resolveAgent(task: CrewTask): CrewAgentSpec | undefined {
    if (task.agentId) {
      const wanted = task.agentId;
      const byId = this.agentsMap.get(wanted);
      if (byId) return byId;
      const byRole = [...this.agentsMap.values()].find(
        (a) => a.role.toLowerCase() === wanted.toLowerCase(),
      );
      if (byRole) return byRole;
      return undefined;
    }
    // Without an explicit assignment, round-robin from the task index.
    const index = this.tasksList.indexOf(task);
    const agents = this.listAgents();
    return agents.length > 0 ? agents[index % agents.length] : undefined;
  }

  private synthesizeManager(): CrewAgentSpec {
    return (
      this.config.manager ?? {
        id: `${this.id}_manager`,
        name: 'Crew Manager',
        role: 'manager',
        goal: 'Coordinate the crew so every task meets its expected output. Delegate each task to the most suitable crewmate and integrate their results.',
        backstory:
          'An experienced project lead who breaks work down, routes it to specialists, and verifies the result before shipping.',
      }
    );
  }

  /** P2 fix: RPM acquire CHỊU cancel — race với signal, không ngủ mồ côi. */
  private async acquireRpm(signal: AbortSignal): Promise<void> {
    if (!this.rpm) return;
    const cancelled = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(new Error('Crew task was cancelled.'));
        return;
      }
      signal.addEventListener(
        'abort',
        () => reject(new Error('Crew task was cancelled.')),
        { once: true },
      );
    });
    await Promise.race([this.rpm.acquire(), cancelled]);
  }

  /** P3 fix: memory bridge tự viết có thể ném — recall là best-effort. */
  private safeRecall(query: string): string {
    try {
      return this.config.memory?.recall(query) ?? '';
    } catch {
      return '';
    }
  }

  /** P2 fix: remember fire-and-forget — async reject/sync throw không được
   *  phép thành unhandledRejection hay giết task sau khi đã hoàn thành. */
  private safeRemember(text: string, meta: { crewId: string; taskId: string; agentId: string }): void {
    try {
      const result = this.config.memory?.remember(text, meta);
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // best-effort
    }
  }

  private throwIfAborted(): void {
    if (this.config.signal?.aborted) {
      throw new Error('Crew run was cancelled.');
    }
  }
}
