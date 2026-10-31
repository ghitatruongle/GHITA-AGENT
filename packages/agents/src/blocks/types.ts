// Block — the composable workflow node (clean-room TS port of the AutoGPT
// Platform block model: typed input/output pins, streaming multi-emission
// runs, mandatory `error` pin, self-describing fixtures). See
// docs/block-workflow.md for attribution (AutoGPT classic MIT / platform
// PolyForm Shield — design ideas only, no code copied).

import type { BaseMessage } from '../messages/message.js';
import type { ReActTool } from '../react/types.js';

/** Minimal JSON Schema shape — intentionally loose for cross-package use. */
export type JsonSchema = Record<string, unknown>;

export type BlockCategory = 'io' | 'ai' | 'logic' | 'tool' | 'human' | 'code' | 'graph';

/**
 * Runtime services handed to every block execution. The executor injects
 * them from the host environment (sidecar wires `llmCall` to the ai-engine
 * Orchestrator, `runInSandbox` to ghita-sandbox via native-bridge, etc.).
 */
export interface BlockContext {
  /** Graph node id running this block (set by the executor). */
  nodeId?: string;
  /** Provider-agnostic LLM call (same shape as ReActAgent's llmCall). */
  llmCall?: (messages: BaseMessage[], config?: { signal?: AbortSignal }) => Promise<BaseMessage>;
  /** ReAct tools available to `tool` blocks. */
  tools?: ReActTool[];
  /** Cooperative cancellation. */
  signal?: AbortSignal;
  logger?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Human-in-the-loop seam (track5 RequestHumanInputManager in the host). */
  requestHumanInput?: (request: { nodeId: string; prompt: string }) => Promise<string>;
  /** Runs a named sub-graph; provided by GraphExecutor for sub_graph blocks. */
  executeGraph?: (
    graphId: string,
    inputs: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  /** Sandbox code runner (ghita-sandbox via native-bridge, JS fallback). */
  runInSandbox?: (code: string) => Promise<string>;
}

/**
 * A block definition. `run` is an async generator yielding `(outputName,
 * value)` tuples — one output pin may emit many times, which is what gives
 * graphs natural fan-out (AutoGPT Block.run semantics).
 */
export interface BlockDefinition {
  /** Stable UUID — persisted in graphs, must never change once published. */
  id: string;
  /** Unique registry name used by graph nodes to reference the block. */
  name: string;
  description: string;
  category: BlockCategory;
  /** JSON Schema of the single input record (required pins from `.required`). */
  inputSchema: JsonSchema;
  /** JSON Schema per declared output pin. */
  outputSchemas: Record<string, JsonSchema>;
  /**
   * Optional self-describing fixture (AutoGPT self-testing blocks): the
   * registry smoke-tests every registered block against it.
   */
  fixture?: { input: Record<string, unknown>; expectOutputPin: string };
  run: (
    input: Record<string, unknown>,
    ctx: BlockContext,
  ) => AsyncGenerator<[string, unknown], void, unknown>;
}
