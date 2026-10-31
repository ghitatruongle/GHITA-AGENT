// GraphExecutor — data-driven scheduling (the core AutoGPT engine idea):
// a node runs the moment all of its required input pins hold data; partial
// executions park in `incomplete`; static links back-fill waiting nodes;
// every state change streams out as a serializable event for the UI.

import { randomUUID } from 'node:crypto';
import type { BlockContext, BlockDefinition } from '../blocks/types.js';
import type { BlockRegistry } from '../blocks/registry.js';
import { INPUT_BLOCK_NAME, OUTPUT_BLOCK_NAME, validateGraph } from './graph.js';
import type { GraphDefinition, GraphTrigger } from './graph.js';

export type NodeRunStatus = 'waiting' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped';

export type NodeExecutionEvent =
  | {
      type: 'execution_start';
      executionId: string;
      graphId: string;
      trigger: GraphTrigger;
      triggerRef?: string;
      timestamp: number;
    }
  | { type: 'node_start'; nodeId: string; input: Record<string, unknown>; timestamp: number }
  | { type: 'node_output'; nodeId: string; outputName: string; value: unknown; timestamp: number }
  | { type: 'node_complete'; nodeId: string; duration: number; timestamp: number }
  | { type: 'node_failed'; nodeId: string; error: string; timestamp: number }
  | { type: 'node_skipped'; nodeId: string; reason: string; timestamp: number }
  | {
      type: 'execution_complete';
      executionId: string;
      status: GraphExecutionResult['status'];
      timestamp: number;
    };

export interface GraphExecutionResult {
  executionId: string;
  graphId: string;
  trigger: GraphTrigger;
  status: 'completed' | 'failed' | 'terminated' | 'incomplete';
  /** Values emitted by the graph's output nodes, keyed by node id. */
  outputs: Record<string, unknown>;
  nodes: Array<{
    nodeId: string;
    status: NodeRunStatus;
    runs: number;
    error?: string;
    duration: number;
  }>;
  error?: string;
  duration: number;
}

export interface GraphExecutorServices {
  onEvent?: (event: NodeExecutionEvent) => void;
  /** ms budget per node (default 120000). */
  nodeTimeoutMs?: number;
  /** Loop bound: max runs per node for cyclic/static-link graphs (default 5). */
  maxRunsPerNode?: number;
  /** Service seams forwarded into every BlockContext. */
  llmCall?: BlockContext['llmCall'];
  tools?: BlockContext['tools'];
  logger?: BlockContext['logger'];
  requestHumanInput?: BlockContext['requestHumanInput'];
  runInSandbox?: BlockContext['runInSandbox'];
  /** Sub-graph runner (nested GraphExecutor) for `sub_graph` blocks. */
  executeGraph?: BlockContext['executeGraph'];
}

export interface GraphExecutionOptions {
  /** Seed values for `input` nodes, keyed by node id. */
  inputs?: Record<string, unknown>;
  trigger?: GraphTrigger;
  /** What exactly started the run (webhook id, cron id, parent execution…). */
  triggerRef?: string;
  signal?: AbortSignal;
}

interface NodeState {
  input: Record<string, unknown>;
  runs: number;
  status: NodeRunStatus;
  error?: string;
  duration: number;
}

function now(): number {
  return Date.now();
}

/**
 * Execute a validated graph. Scheduling is data-driven, not topological:
 * after each output emission the executor delivers values along links
 * (`upsert_execution_input`) and enqueues any sink whose required pins are
 * now fully fed. Multiple string deliveries to the same pin are joined with
 * a blank line; other pins overwrite. Cycles are bounded by
 * `maxRunsPerNode`. A node whose block yields its `error` pin fails the
 * whole run (fail-fast, as on the AutoGPT platform).
 */
export class GraphExecutor {
  constructor(
    private readonly registry: BlockRegistry,
    private readonly services: GraphExecutorServices = {},
  ) {}

  async execute(
    graph: GraphDefinition,
    options: GraphExecutionOptions = {},
  ): Promise<GraphExecutionResult> {
    const validation = validateGraph(graph, this.registry);
    if (!validation.ok) {
      throw new Error(`Invalid graph "${graph.name}": ${validation.errors.join('; ')}`);
    }

    const startedAt = now();
    const executionId = `exec_${randomUUID()}`;
    const trigger: GraphTrigger = options.trigger ?? 'manual';
    const emit = (event: NodeExecutionEvent): void => {
      try {
        this.services.onEvent?.(event);
      } catch {
        // Listener failures must not break the run.
      }
    };

    const externalSignal = options.signal;
    const abortController = new AbortController();
    const onExternalAbort = (): void => abortController.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const signal = abortController.signal;

    const states = new Map<string, NodeState>();
    for (const node of graph.nodes) {
      states.set(node.id, {
        input: { ...(node.inputDefault ?? {}) },
        runs: 0,
        status: 'waiting',
        duration: 0,
      });
    }
    for (const inputNodeId of validation.inputNodeIds) {
      const state = states.get(inputNodeId);
      const seeded = options.inputs?.[inputNodeId];
      if (state && seeded !== undefined) {
        state.input['value'] = seeded;
      }
    }

    emit({
      type: 'execution_start',
      executionId,
      graphId: graph.id,
      trigger,
      ...(options.triggerRef !== undefined ? { triggerRef: options.triggerRef } : {}),
      timestamp: now(),
    });

    const ready: string[] = graph.nodes
      .filter((n) => {
        const state = states.get(n.id);
        return state?.status === 'waiting' && this.isReady(n, state);
      })
      .map((n) => n.id);
    for (const nodeId of ready) {
      const state = states.get(nodeId);
      if (state) state.status = 'queued';
    }

    const nodeResults = new Map<string, NodeState>();
    const outputs: Record<string, unknown> = {};
    let failure: { nodeId: string; error: string } | undefined;

    const deliver = (sinkId: string, pin: string, value: unknown): void => {
      const state = states.get(sinkId);
      if (!state) return;
      const existing = state.input[pin];
      state.input[pin] =
        typeof existing === 'string' && typeof value === 'string' && existing.length > 0
          ? `${existing}\n\n${value}`
          : value;
    };

    while (ready.length > 0 && !failure && !externalSignal?.aborted) {
      const nodeId = ready.shift() as string;
      const node = graph.nodes.find((n) => n.id === nodeId);
      const state = states.get(nodeId);
      if (!node || !state) continue;

      const maxRuns = this.services.maxRunsPerNode ?? 5;
      if (state.runs >= maxRuns) {
        state.status = 'skipped';
        nodeResults.set(nodeId, state);
        emit({
          type: 'node_skipped',
          nodeId,
          reason: `max runs (${maxRuns}) reached`,
          timestamp: now(),
        });
        continue;
      }

      state.runs += 1;
      state.status = 'running';
      const nodeStartedAt = now();
      emit({ type: 'node_start', nodeId, input: { ...state.input }, timestamp: now() });

      const block = this.registry.require(node.blockName);
      const ctx: BlockContext = {
        nodeId,
        llmCall: this.services.llmCall,
        tools: this.services.tools,
        signal,
        logger: this.services.logger,
        requestHumanInput: this.services.requestHumanInput,
        runInSandbox: this.services.runInSandbox,
        executeGraph: this.services.executeGraph,
      };

      try {
        // Pausable per-node deadline: while a human-in-the-loop request is
        // pending the timer is disarmed and the remaining budget banked, so
        // a user taking longer than `nodeTimeoutMs` to answer is not killed.
        const timeoutMs = this.services.nodeTimeoutMs ?? 120_000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let remainingMs = timeoutMs;
        let segmentStartedAt = now();
        let rejectRun: ((err: Error) => void) | undefined;
        const timeoutError = new Error(`Node "${nodeId}" timed out after ${timeoutMs}ms`);
        const arm = (): void => {
          segmentStartedAt = now();
          timer = setTimeout(() => {
            timer = undefined;
            abortController.abort();
            rejectRun?.(timeoutError);
          }, Math.max(remainingMs, 1));
        };
        const disarm = (): void => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
            remainingMs -= now() - segmentStartedAt;
          }
        };
        const timeoutPromise = new Promise<never>((_, reject) => {
          rejectRun = reject;
        });
        arm();

        const innerRequestHumanInput = this.services.requestHumanInput;
        const ctxForRun: BlockContext = innerRequestHumanInput
          ? {
              ...ctx,
              requestHumanInput: async (request) => {
                disarm();
                try {
                  return await innerRequestHumanInput(request);
                } finally {
                  arm();
                }
              },
            }
          : ctx;

        const runPromise = this.drainBlock(
          nodeId,
          block,
          ctxForRun,
          state,
          graph,
          deliver,
          ready,
          states,
          outputs,
          emit,
        );
        const race = Promise.race([runPromise, timeoutPromise]);
        // When the timeout wins, the losing block run still rejects later
        // (e.g. an abort-aware primitive). Swallow that late rejection — the
        // timeout error is the one reported; without this the process would
        // emit an unhandledRejection.
        runPromise.catch(() => undefined);
        try {
          await race;
        } finally {
          disarm();
        }
        if (state.status === 'running') {
          state.status = 'completed';
        }
        state.duration += now() - nodeStartedAt;
        nodeResults.set(nodeId, state);
        if (state.status === 'completed') {
          emit({ type: 'node_complete', nodeId, duration: state.duration, timestamp: now() });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state.status = 'failed';
        state.error = message;
        state.duration += now() - nodeStartedAt;
        nodeResults.set(nodeId, state);
        failure = { nodeId, error: message };
        emit({ type: 'node_failed', nodeId, error: message, timestamp: now() });
      }
    }

    externalSignal?.removeEventListener('abort', onExternalAbort);

    const allNodes: GraphExecutionResult['nodes'] = graph.nodes.map((n) => {
      const result = nodeResults.get(n.id) ?? states.get(n.id);
      if (!result) {
        return { nodeId: n.id, status: 'waiting' as NodeRunStatus, runs: 0, duration: 0 };
      }
      return {
        nodeId: n.id,
        status: result.status,
        runs: result.runs,
        ...(result.error !== undefined ? { error: result.error } : {}),
        duration: result.duration,
      };
    });

    let status: GraphExecutionResult['status'];
    if (externalSignal?.aborted) {
      status = 'terminated';
    } else if (failure) {
      status = 'failed';
    } else if (
      allNodes.every((n) => n.status === 'completed' || n.status === 'skipped') ||
      // Untaken conditional branches legitimately leave nodes waiting; the
      // graph is done once it has produced a result (AutoGPT COMPLETED
      // semantics — unvisited branches simply never get node executions).
      Object.keys(outputs).length > 0
    ) {
      status = 'completed';
    } else {
      // The queue drained with no result produced — the graph is runnable
      // but starved of seed data. Park it (AutoGPT INCOMPLETE): resume later
      // by re-executing with the missing inputs.
      status = 'incomplete';
    }

    const result: GraphExecutionResult = {
      executionId,
      graphId: graph.id,
      trigger,
      status,
      outputs,
      nodes: allNodes,
      ...(failure ? { error: failure.error } : {}),
      duration: now() - startedAt,
    };
    emit({ type: 'execution_complete', executionId, status, timestamp: now() });
    return result;
  }

  private isReady(node: GraphDefinition['nodes'][number], state: NodeState): boolean {
    if (node.blockName === INPUT_BLOCK_NAME) {
      return state.input['value'] !== undefined;
    }
    const block = this.registry.get(node.blockName);
    const required = (block?.inputSchema['required'] as string[] | undefined) ?? [];
    return required.every((pin) => state.input[pin] !== undefined);
  }

  /** Consume one block run: emit outputs, fan out along links, enqueue sinks. */
  private async drainBlock(
    nodeId: string,
    block: BlockDefinition,
    ctx: BlockContext,
    state: NodeState,
    graph: GraphDefinition,
    deliver: (sinkId: string, pin: string, value: unknown) => void,
    ready: string[],
    states: Map<string, NodeState>,
    outputs: Record<string, unknown>,
    emit: (event: NodeExecutionEvent) => void,
  ): Promise<void> {
    for await (const [pin, value] of block.run({ ...state.input }, ctx)) {
      if (pin === 'error') {
        throw new Error(String(value));
      }
      emit({ type: 'node_output', nodeId, outputName: pin, value, timestamp: now() });
      if (block.name === OUTPUT_BLOCK_NAME && pin === 'done') {
        outputs[nodeId] = value;
      }
      // Fan-out: deliver this emission along every matching link.
      for (const link of graph.links) {
        if (link.source !== nodeId || link.sourceOutput !== pin) continue;
        deliver(link.sink, link.sinkInput, value);
        const sinkState = states.get(link.sink);
        const sinkNode = graph.nodes.find((n) => n.id === link.sink);
        if (!sinkState || !sinkNode) continue;
        // A static link may back-fill a node that already ran (loops and
        // stateful graphs): re-arm it for another bounded run. Self-loops
        // (source === sink) are not re-armed — the node is 'running' during
        // its own delivery; model such loops with two nodes.
        if (
          link.isStatic &&
          sinkState.status === 'completed' &&
          sinkState.runs < (this.services.maxRunsPerNode ?? 5)
        ) {
          sinkState.status = 'waiting';
        }
        if (
          (sinkState.status === 'waiting' || sinkState.status === 'queued') &&
          this.isReady(sinkNode, sinkState) &&
          !ready.includes(link.sink)
        ) {
          sinkState.status = 'queued';
          ready.push(link.sink);
        }
      }
    }
  }
}
