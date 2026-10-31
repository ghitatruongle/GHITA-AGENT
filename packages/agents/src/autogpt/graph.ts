// Graph / Node / Link model (clean-room TS port of the AutoGPT Platform
// graph layer): block-referencing nodes, typed links, computed graph-level
// input/output schema from boundary `input`/`output` nodes, persisted
// trigger taxonomy, and an explicit status-transition table.

import type { BlockRegistry } from '../blocks/registry.js';
import type { JsonSchema } from '../blocks/types.js';

export const INPUT_BLOCK_NAME = 'input';
export const OUTPUT_BLOCK_NAME = 'output';

/** One workflow node: a block instance with static input defaults. */
export interface GraphNode {
  id: string;
  /** Block registry name (resolved at validation time). */
  blockName: string;
  /** Static values merged under link-delivered data. */
  inputDefault?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** Directed edge delivering one output pin to one input pin. */
export interface GraphLink {
  source: string;
  sourceOutput: string;
  sink: string;
  sinkInput: string;
  /**
   * Static links back-fill waiting executions later — the AutoGPT primitive
   * that makes loops and stateful graphs expressible.
   */
  isStatic?: boolean;
}

export type GraphTrigger = 'manual' | 'api' | 'schedule' | 'webhook' | 'subgraph';

export interface GraphDefinition {
  id: string;
  name: string;
  /** Immutable version number; a save produces a new version. */
  version: number;
  nodes: GraphNode[];
  links: GraphLink[];
}

export type ExecutionStatus =
  | 'incomplete'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'terminated'
  | 'review';

/** AutoGPT's explicit transition table — resume paths stay valid by design. */
export const VALID_STATUS_TRANSITIONS: Record<ExecutionStatus, ExecutionStatus[]> = {
  incomplete: ['queued', 'running', 'terminated'],
  queued: ['running', 'terminated'],
  running: ['completed', 'failed', 'terminated', 'review', 'queued'],
  completed: [],
  failed: ['queued'],
  terminated: ['queued'],
  review: ['queued'],
};

export function isValidStatusTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return VALID_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface GraphValidationResult {
  ok: boolean;
  errors: string[];
  /** Computed graph-level schemas (from boundary input/output nodes). */
  inputSchema: JsonSchema;
  outputSchema: Record<string, JsonSchema>;
  inputNodeIds: string[];
  outputNodeIds: string[];
}

/**
 * Validate a graph against a registry (AutoGPT `Graph.validate_graph`):
 * structure (unique ids, known blocks and pins, no dangling links), boundary
 * nodes, and the computed graph-level schemas.
 */
export function validateGraph(def: GraphDefinition, registry: BlockRegistry): GraphValidationResult {
  const errors: string[] = [];
  const nodeIds = new Set<string>();

  for (const node of def.nodes) {
    if (nodeIds.has(node.id)) {
      errors.push(`Duplicate node id: "${node.id}"`);
    }
    nodeIds.add(node.id);
    if (!registry.get(node.blockName)) {
      errors.push(`Node "${node.id}" references unknown block "${node.blockName}"`);
    }
  }

  const nodeById = new Map(def.nodes.map((n) => [n.id, n]));
  for (const link of def.links) {
    const source = nodeById.get(link.source);
    const sink = nodeById.get(link.sink);
    if (!source) {
      errors.push(`Link source node "${link.source}" does not exist`);
      continue;
    }
    if (!sink) {
      errors.push(`Link sink node "${link.sink}" does not exist`);
      continue;
    }
    const sourceBlock = registry.get(source.blockName);
    const sinkBlock = registry.get(sink.blockName);
    if (sourceBlock && !(link.sourceOutput in sourceBlock.outputSchemas)) {
      errors.push(
        `Node "${source.id}" (block ${sourceBlock.name}) has no output pin "${link.sourceOutput}"`,
      );
    }
    if (sinkBlock) {
      const properties = (sinkBlock.inputSchema['properties'] as Record<string, unknown>) ?? {};
      if (!(link.sinkInput in properties)) {
        errors.push(
          `Node "${sink.id}" (block ${sinkBlock.name}) has no input pin "${link.sinkInput}"`,
        );
      }
    }
  }

  const inputNodes = def.nodes.filter((n) => n.blockName === INPUT_BLOCK_NAME);
  const outputNodes = def.nodes.filter((n) => n.blockName === OUTPUT_BLOCK_NAME);
  if (inputNodes.length === 0) {
    errors.push('Graph must declare at least one "input" node.');
  }
  if (outputNodes.length === 0) {
    errors.push('Graph must declare at least one "output" node.');
  }

  // Graph-level input schema: each input node contributes a `value` property
  // keyed by node id (the executor seeds `inputs[nodeId]` into that node).
  const inputProperties: Record<string, JsonSchema> = {};
  for (const node of inputNodes) {
    const block = registry.get(node.blockName);
    const blockProps = (block?.inputSchema['properties'] as Record<string, JsonSchema>) ?? {};
    inputProperties[node.id] = blockProps['value'] ?? {};
  }
  const inputSchema: JsonSchema = { type: 'object', properties: inputProperties };

  const outputSchema: Record<string, JsonSchema> = {};
  for (const node of outputNodes) {
    outputSchema[node.id] = {};
  }

  return {
    ok: errors.length === 0,
    errors,
    inputSchema,
    outputSchema,
    inputNodeIds: inputNodes.map((n) => n.id),
    outputNodeIds: outputNodes.map((n) => n.id),
  };
}
