// Crew — multi-agent team orchestration (clean-room TS port of the CrewAI
// design: identity-triplet agents, context-linked tasks, sequential and
// hierarchical processes, delegation-as-tools, best-effort planning and
// shared memory). See docs/crew-orchestration.md for the full mapping and
// attribution (CrewAI, MIT).

import type { ReActTool } from '../react/types.js';
import { createDelegationTools } from './delegation.js';
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
  /** Outputs of tasks completed in the current kickoff (kept for failure results). */
  private partialOutputs: CrewTaskOutput[] = [];

  constructor(config: CrewConfig = {}) {
    this.id = config.id ?? crewId();
    this.config = config;
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
    this.partialOutputs = [];
    const emit = (event: CrewEvent): void => {
      try {
        this.config.onEvent?.(event);
      } catch {
        // A broken event listener must never break the run.
      }
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
          ? await this.runHierarchical(executor, inputs, plans, emit)
          : await this.runSequential(executor, inputs, plans, emit);
      const last = taskOutputs.at(-1);
      const result: CrewResult = {
        crewId: this.id,
        status: 'completed',
        output: last?.output ?? '',
        taskOutputs,
        duration: Date.now() - startTime,
      };
      emit({
        type: 'crew_complete',
        crewId: this.id,
        status: 'completed',
        output: result.output,
        duration: result.duration,
        timestamp: Date.now(),
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const partial = [...this.partialOutputs];
      const result: CrewResult = {
        crewId: this.id,
        status: 'failed',
        output: partial.at(-1)?.output ?? '',
        taskOutputs: partial,
        duration: Date.now() - startTime,
        error: message,
      };
      emit({
        type: 'crew_complete',
        crewId: this.id,
        status: 'failed',
        output: result.output,
        duration: result.duration,
        timestamp: Date.now(),
      });
      return result;
    }
  }

  // ---- Processes ----

  private async runSequential(
    executor: CrewTaskExecutor,
    inputs: Record<string, unknown>,
    plans: Map<string, CrewPlanStep> | undefined,
    emit: (event: CrewEvent) => void,
  ): Promise<CrewTaskOutput[]> {
    const outputs = this.partialOutputs;
    for (const task of this.tasksList) {
      this.throwIfAborted();
      const agent = this.resolveAgent(task) as CrewAgentSpec;
      const context = this.assembleContext(task, outputs);
      const memoryContext = this.config.memory?.recall(task.description) ?? '';
      const prompt = this.buildMemberPrompt(
        task,
        context,
        inputs,
        plans?.get(task.id)?.plan,
        memoryContext,
      );
      const output = await this.executeTask(task, agent, prompt, executor, emit);
      outputs.push(output);
    }
    return outputs;
  }

  private async runHierarchical(
    executor: CrewTaskExecutor,
    inputs: Record<string, unknown>,
    plans: Map<string, CrewPlanStep> | undefined,
    emit: (event: CrewEvent) => void,
  ): Promise<CrewTaskOutput[]> {
    const manager = this.config.manager ?? this.synthesizeManager();
    const crewmates = this.listAgents().filter((a) => a.id !== manager.id);
    const outputs = this.partialOutputs;

    for (const task of this.tasksList) {
      this.throwIfAborted();
      const context = this.assembleContext(task, outputs);
      const memoryContext = this.config.memory?.recall(task.description) ?? '';
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
    delegation?: { crewmates: CrewAgentSpec[]; hierarchical: boolean },
  ): Promise<CrewTaskOutput> {
    emit({ type: 'task_start', taskId: task.id, agentId: agent.id, timestamp: Date.now() });
    const startedAt = Date.now();

    const delegationBudget = this.config.maxDelegationsPerTask ?? 8;
    const delegationTools: ReActTool[] = [];
    let delegationResult: ReturnType<typeof createDelegationTools> | undefined;
    if (delegation || agent.allowDelegation) {
      const members = delegation ? delegation.crewmates : this.listAgents().filter((a) => a.id !== agent.id);
      delegationResult = createDelegationTools({
        members,
        currentAgent: agent,
        maxDelegations: delegationBudget,
        signal: this.config.signal,
        onDelegation: emit,
        // Members never receive delegation tools: it keeps the recursion
        // depth fixed and matches the inline-execution semantics.
        executeMemberTask: async (member, memberPrompt) =>
          executor({
            crewId: this.id,
            taskId: task.id,
            agent: member,
            prompt: memberPrompt,
            tools: member.tools ?? [],
            signal: this.config.signal,
          }),
      });
      delegationTools.push(...delegationResult.tools);
    }

    const baseTools = task.tools ?? agent.tools ?? [];
    const tools = [...baseTools, ...delegationTools];
    const maxRetries = task.maxRetries ?? 2;

    // Every executor invocation funnels through here so an unexpected throw
    // still emits `task_failed` (the UI would otherwise show the task as
    // running forever). Guardrail exhaustion throws outside this wrapper and
    // emits its own event before throwing.
    const runExecutor = async (taskPrompt: string): Promise<string> => {
      try {
        return await executor({
          crewId: this.id,
          taskId: task.id,
          agent,
          prompt: taskPrompt,
          tools,
          signal: this.config.signal,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({
          type: 'task_failed',
          taskId: task.id,
          agentId: agent.id,
          error: message,
          timestamp: Date.now(),
        });
        throw err;
      }
    };

    let retries = 0;
    let output = await runExecutor(prompt);

    if (task.guardrail) {
      let verdict = await task.guardrail(output);
      while (verdict !== true && verdict !== '') {
        const reason = typeof verdict === 'string' ? verdict : 'Guardrail rejected the output.';
        if (retries >= maxRetries) {
          const error = `Task "${task.id}" failed its guardrail after ${retries + 1} attempt(s): ${reason}`;
          emit({ type: 'task_failed', taskId: task.id, agentId: agent.id, error, timestamp: Date.now() });
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
        output = await runExecutor(revisionPrompt);
        verdict = await task.guardrail(output);
      }
    }

    const record: CrewTaskOutput = {
      taskId: task.id,
      agentId: agent.id,
      output,
      duration: Date.now() - startedAt,
      retries,
      delegations: delegationResult?.accepted() ?? 0,
    };
    emit({
      type: 'task_complete',
      taskId: task.id,
      agentId: agent.id,
      output,
      duration: record.duration,
      timestamp: Date.now(),
    });
    this.config.memory?.remember(
      `Task "${task.id}" completed by ${agent.name}: ${truncate(output, MEMORY_OUTPUT_LIMIT)}`,
      { crewId: this.id, taskId: task.id, agentId: agent.id },
    );
    return record;
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

  private throwIfAborted(): void {
    if (this.config.signal?.aborted) {
      throw new Error('Crew run was cancelled.');
    }
  }
}
