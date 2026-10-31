import { describe, expect, it, vi } from 'vitest';
import { AIMessage } from '../src/messages/message.js';
import {
  BlockRegistry,
  BlockRegistryError,
} from '../src/blocks/registry.js';
import { createDefaultBlockRegistry } from '../src/blocks/builtins.js';
import type { BlockDefinition } from '../src/blocks/types.js';
import {
  INPUT_BLOCK_NAME,
  OUTPUT_BLOCK_NAME,
  validateGraph,
  isValidStatusTransition,
} from '../src/autogpt/graph.js';
import type { GraphDefinition } from '../src/autogpt/graph.js';
import { GraphExecutor } from '../src/autogpt/executor.js';
import type { NodeExecutionEvent } from '../src/autogpt/executor.js';
import { decomposeGoalWithLLM, decomposedGoalToGraph } from '../src/autogpt/goal-decomposer.js';

const stubLlm = (answer: string) => async () => new AIMessage(answer);
const stubText = (answer: string) => async () => answer;

function linearGraph(): GraphDefinition {
  return {
    id: 'g_linear',
    name: 'linear',
    version: 1,
    nodes: [
      { id: 'in', blockName: INPUT_BLOCK_NAME },
      { id: 'ask', blockName: 'llm_text', inputDefault: { prompt: 'Say hello.' } },
      { id: 'out', blockName: OUTPUT_BLOCK_NAME },
    ],
    links: [
      { source: 'in', sourceOutput: 'output', sink: 'ask', sinkInput: 'context' },
      { source: 'ask', sourceOutput: 'output', sink: 'out', sinkInput: 'value' },
    ],
  };
}

describe('BlockRegistry invariants', () => {
  const base: Omit<BlockDefinition, 'id' | 'name' | 'outputSchemas' | 'run'> = {
    description: 'test',
    category: 'logic',
    inputSchema: { type: 'object' },
  };

  const minimalRun = async function* () {
    yield ['error', 'x'] as [string, unknown];
  };

  it('requires a stable id, unique names and ids', () => {
    const registry = new BlockRegistry();
    const def: BlockDefinition = {
      ...base,
      id: 'block.t.v1',
      name: 't',
      outputSchemas: { error: { type: 'string' } },
      run: minimalRun,
    };
    expect(() => registry.register({ ...def, id: '' })).toThrow(BlockRegistryError);
    registry.register(def);
    expect(() => registry.register({ ...def, id: 'block.t2.v1' })).toThrow(/name already registered/);
    expect(() => registry.register({ ...def, name: 't2' })).toThrow(/id already registered/);
  });

  it('enforces the mandatory string error pin', () => {
    const registry = new BlockRegistry();
    expect(() =>
      registry.register({
        ...base,
        id: 'block.e1.v1',
        name: 'e1',
        outputSchemas: {},
        run: minimalRun,
      }),
    ).toThrow(/must declare an "error" output pin/);
    expect(() =>
      registry.register({
        ...base,
        id: 'block.e2.v1',
        name: 'e2',
        outputSchemas: { error: { type: 'object' } },
        run: minimalRun,
      }),
    ).toThrow(/pin "error" must be a string/);
  });

  it('rejects fixtures referencing unknown output pins', () => {
    const registry = new BlockRegistry();
    expect(() =>
      registry.register({
        ...base,
        id: 'block.f.v1',
        name: 'f',
        outputSchemas: { error: { type: 'string' } },
        fixture: { input: {}, expectOutputPin: 'nope' },
        run: minimalRun,
      }),
    ).toThrow(/unknown output pin/);
  });

  it('runs self-describing fixtures for pure blocks', async () => {
    const results = await createDefaultBlockRegistry().runFixtureTests({});
    expect(results.length).toBeGreaterThanOrEqual(4);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

describe('Graph validation', () => {
  const registry = createDefaultBlockRegistry();

  it('accepts a well-formed linear graph', () => {
    const result = validateGraph(linearGraph(), registry);
    expect(result.ok).toBe(true);
    expect(result.inputNodeIds).toEqual(['in']);
    expect(result.outputNodeIds).toEqual(['out']);
  });

  it('rejects unknown blocks, dangling links and bad pins', () => {
    const bad: GraphDefinition = {
      id: 'g_bad',
      name: 'bad',
      version: 1,
      nodes: [
        { id: 'a', blockName: 'no_such_block' },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [
        { source: 'ghost', sourceOutput: 'output', sink: 'out', sinkInput: 'value' },
        { source: 'a', sourceOutput: 'nope', sink: 'out', sinkInput: 'wrong_pin' },
      ],
    };
    const result = validateGraph(bad, registry);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });

  it('requires boundary input and output nodes', () => {
    const bad: GraphDefinition = {
      id: 'g_boundary',
      name: 'boundary',
      version: 1,
      nodes: [{ id: 'ask', blockName: 'llm_text' }],
      links: [],
    };
    const result = validateGraph(bad, registry);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it('enforces the AutoGPT status transition table', () => {
    expect(isValidStatusTransition('running', 'completed')).toBe(true);
    expect(isValidStatusTransition('running', 'review')).toBe(true);
    expect(isValidStatusTransition('terminated', 'queued')).toBe(true);
    expect(isValidStatusTransition('completed', 'queued')).toBe(false);
    expect(isValidStatusTransition('failed', 'running')).toBe(false);
  });
});

describe('GraphExecutor', () => {
  const registry = createDefaultBlockRegistry();

  it('runs a linear graph and streams serializable events', async () => {
    const events: NodeExecutionEvent[] = [];
    const executor = new GraphExecutor(registry, {
      llmCall: stubLlm('hello from the model'),
      onEvent: (e) => events.push(e),
    });

    const result = await executor.execute(linearGraph(), {
      inputs: { in: 'the goal' },
      trigger: 'api',
      triggerRef: 'req_42',
    });

    expect(result.status).toBe('completed');
    expect(result.outputs['out']).toBe('hello from the model');
    expect(result.trigger).toBe('api');
    expect(JSON.stringify(events)).not.toContain('undefined');
    expect(events.map((e) => e.type)).toEqual([
      'execution_start',
      // input node
      'node_start',
      'node_output',
      'node_complete',
      // llm node
      'node_start',
      'node_output',
      'node_complete',
      // output node
      'node_start',
      'node_output',
      'node_complete',
      'execution_complete',
    ]);
    const start = events[0];
    expect(start?.type === 'execution_start' && start.triggerRef).toBe('req_42');
  });

  it('fans one output out to many sinks and joins string deliveries', async () => {
    const graph: GraphDefinition = {
      id: 'g_fanout',
      name: 'fanout',
      version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME },
        { id: 'items', blockName: 'step_through_items' },
        { id: 'collector', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [
        { source: 'in', sourceOutput: 'output', sink: 'items', sinkInput: 'items' },
        { source: 'items', sourceOutput: 'item', sink: 'collector', sinkInput: 'value' },
      ],
    };
    const executor = new GraphExecutor(registry, {});
    const result = await executor.execute(graph, {
      inputs: { in: ['first', 'second', 'third'] },
    });

    expect(result.status).toBe('completed');
    // Three emissions delivered to one string pin are joined.
    expect(result.outputs['collector']).toBe('first\n\nsecond\n\nthird');
  });

  it('fans in from two sources into one sink', async () => {
    const graph: GraphDefinition = {
      id: 'g_fanin',
      name: 'fanin',
      version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME },
        {
          id: 'a',
          blockName: 'llm_text',
          inputDefault: { prompt: 'A?' },
        },
        {
          id: 'b',
          blockName: 'llm_text',
          inputDefault: { prompt: 'B?' },
        },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [
        { source: 'a', sourceOutput: 'output', sink: 'out', sinkInput: 'value' },
        { source: 'b', sourceOutput: 'output', sink: 'out', sinkInput: 'value' },
      ],
    };
    const executor = new GraphExecutor(registry, {
      llmCall: stubLlm('answer'),
    });
    const result = await executor.execute(graph, { inputs: { in: 'go' } });

    expect(result.status).toBe('completed');
    expect(result.outputs['out']).toBe('answer\n\nanswer');
  });

  it('parks an under-fed graph as incomplete instead of failing', async () => {
    const graph: GraphDefinition = {
      id: 'g_incomplete',
      name: 'incomplete',
      version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [{ source: 'in', sourceOutput: 'output', sink: 'out', sinkInput: 'value' }],
    };
    const executor = new GraphExecutor(registry, {});
    // No seed for the input node → nothing runs, nothing fails.
    const result = await executor.execute(graph);

    expect(result.status).toBe('incomplete');
    expect(result.nodes.find((n) => n.nodeId === 'in')?.status).toBe('waiting');
  });

  it('reports completed when an untaken conditional branch leaves a node waiting', async () => {
    const graph: GraphDefinition = {
      id: 'g_branch',
      name: 'branch',
      version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME },
        {
          id: 'check',
          blockName: 'condition',
          inputDefault: { operator: 'equals', compareTo: 'yes' },
        },
        { id: 'taken', blockName: 'llm_text' },
        { id: 'untaken', blockName: 'llm_text' },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [
        { source: 'in', sourceOutput: 'output', sink: 'check', sinkInput: 'value' },
        { source: 'check', sourceOutput: 'true', sink: 'taken', sinkInput: 'prompt' },
        { source: 'check', sourceOutput: 'false', sink: 'untaken', sinkInput: 'prompt' },
        { source: 'taken', sourceOutput: 'output', sink: 'out', sinkInput: 'value' },
      ],
    };
    const executor = new GraphExecutor(registry, { llmCall: stubLlm('branch output') });
    const result = await executor.execute(graph, { inputs: { in: 'yes' } });

    // The 'false' branch never fires — that must not poison the run status.
    expect(result.status).toBe('completed');
    expect(result.outputs['out']).toBe('branch output');
    expect(result.nodes.find((n) => n.nodeId === 'untaken')?.status).toBe('waiting');
  });

  it('re-runs a completed node when a static link back-fills it, bounded by maxRunsPerNode', async () => {
    // A↔B loop through static links: each back-edge re-arms the other node
    // once per bound window; the graph must terminate and still produce its
    // output.
    const graph: GraphDefinition = {
      id: 'g_loop',
      name: 'loop',
      version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME },
        { id: 'a', blockName: 'llm_text' },
        { id: 'b', blockName: 'llm_text' },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [
        { source: 'in', sourceOutput: 'output', sink: 'a', sinkInput: 'prompt' },
        { source: 'a', sourceOutput: 'output', sink: 'b', sinkInput: 'prompt' },
        { source: 'b', sourceOutput: 'output', sink: 'out', sinkInput: 'value' },
        { source: 'a', sourceOutput: 'output', sink: 'b', sinkInput: 'context', isStatic: true },
        { source: 'b', sourceOutput: 'output', sink: 'a', sinkInput: 'context', isStatic: true },
      ],
    };
    const executor = new GraphExecutor(registry, {
      llmCall: stubLlm('cycle answer'),
      maxRunsPerNode: 2,
    });
    const result = await executor.execute(graph, { inputs: { in: 'go' } });

    expect(result.status).toBe('completed');
    // Each node ran exactly up to the bound, then the loop terminated.
    expect(result.nodes.find((n) => n.nodeId === 'a')?.runs).toBe(2);
    expect(result.nodes.find((n) => n.nodeId === 'b')?.runs).toBe(2);
    expect(result.nodes.find((n) => n.nodeId === 'out')?.runs).toBe(1);
    expect(result.outputs['out']).toBe('cycle answer');
  });

  it('fails fast when a block yields its error pin', async () => {
    const graph: GraphDefinition = {
      id: 'g_err',
      name: 'err',
      version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME },
        { id: 'ask', blockName: 'llm_text', inputDefault: { prompt: 'x' } },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [
        { source: 'in', sourceOutput: 'output', sink: 'ask', sinkInput: 'context' },
        { source: 'ask', sourceOutput: 'output', sink: 'out', sinkInput: 'value' },
      ],
    };
    const executor = new GraphExecutor(registry, {
      llmCall: async () => {
        throw new Error('provider down');
      },
    });
    const result = await executor.execute(graph, { inputs: { in: 'go' } });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('provider down');
    // Downstream node never ran.
    expect(result.nodes.find((n) => n.nodeId === 'out')?.status).toBe('waiting');
  });

  it('terminates on an external abort', async () => {
    const controller = new AbortController();
    const graph: GraphDefinition = {
      id: 'g_abort',
      name: 'abort',
      version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME },
        { id: 'wait', blockName: 'delay', inputDefault: { ms: 5_000 } },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [
        { source: 'in', sourceOutput: 'output', sink: 'wait', sinkInput: 'ms' },
        { source: 'wait', sourceOutput: 'done', sink: 'out', sinkInput: 'value' },
      ],
    };
    const executor = new GraphExecutor(registry, {});
    const runPromise = executor.execute(graph, { inputs: { in: 5_000 }, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const result = await runPromise;

    expect(result.status).toBe('terminated');
  });

  it('runs a sub-graph through the executeGraph seam', async () => {
    const graph: GraphDefinition = {
      id: 'g_sub',
      name: 'sub',
      version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME },
        { id: 'nested', blockName: 'sub_graph', inputDefault: { graphId: 'g_child' } },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [
        { source: 'in', sourceOutput: 'output', sink: 'nested', sinkInput: 'inputs' },
        { source: 'nested', sourceOutput: 'output', sink: 'out', sinkInput: 'value' },
      ],
    };
    const executeGraph = vi.fn(async () => ({ done: true }));
    const executor = new GraphExecutor(registry, { executeGraph });
    const result = await executor.execute(graph, { inputs: { in: { q: 1 } } });

    expect(result.status).toBe('completed');
    expect(executeGraph).toHaveBeenCalledWith('g_child', { q: 1 });
    expect(result.outputs['out']).toEqual({ done: true });
  });

  it('rejects an invalid graph before running', async () => {
    const executor = new GraphExecutor(registry, {});
    await expect(
      executor.execute({
        id: 'g_invalid',
        name: 'invalid',
        version: 1,
        nodes: [],
        links: [],
      }),
    ).rejects.toThrow(/Invalid graph/);
  });

  it('pauses the node deadline while a human-in-the-loop request is pending', async () => {
    const graph: GraphDefinition = {
      id: 'g_hitl',
      name: 'hitl',
      version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME },
        { id: 'ask', blockName: 'human_in_the_loop', inputDefault: { prompt: 'Approve?' } },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [
        { source: 'in', sourceOutput: 'output', sink: 'ask', sinkInput: 'prompt' },
        { source: 'ask', sourceOutput: 'output', sink: 'out', sinkInput: 'value' },
      ],
    };
    const executor = new GraphExecutor(registry, {
      // 100ms budget vs a 300ms human delay: only the pause mechanism lets
      // this run complete instead of timing out.
      nodeTimeoutMs: 100,
      requestHumanInput: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return 'approved';
      },
    });
    const result = await executor.execute(graph, { inputs: { in: 'go' } });

    expect(result.status).toBe('completed');
    expect(result.outputs['out']).toBe('approved');
  });

  it('yields the error pin when a tool block receives non-object args', async () => {
    const graph: GraphDefinition = {
      id: 'g_toolargs',
      name: 'toolargs',
      version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME },
        { id: 'call', blockName: 'tool', inputDefault: { name: 'echo', args: 'not-an-object' } },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [{ source: 'call', sourceOutput: 'output', sink: 'out', sinkInput: 'value' }],
    };
    const executor = new GraphExecutor(registry, {
      tools: [
        {
          name: 'echo',
          description: 'echo',
          parameters: { type: 'object' },
          execute: async () => 'should not run',
        },
      ],
    });
    const result = await executor.execute(graph, { inputs: { in: 'go' } });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/non-object args/);
  });
});

describe('Goal decomposition', () => {
  const validAnswer =
    '```json\n{"title": "Ship feature", "tasks": [\n' +
    '{"id": "design", "title": "Design", "description": "Design it.", "dependencies": []},\n' +
    '{"id": "build", "title": "Build", "description": "Build it.", "dependencies": ["design"]}\n' +
    ']}\n```';

  it('parses an LLM answer into a verified DAG', async () => {
    const decomposition = await decomposeGoalWithLLM('Ship the feature', stubText(validAnswer));
    expect(decomposition.title).toBe('Ship feature');
    expect(decomposition.nodes.map((n) => n.id)).toEqual(['design', 'build']);
    expect(decomposition.nodes[1]?.dependencies).toEqual(['design']);
  });

  it('rejects answers without tasks or with cycles', async () => {
    await expect(
      decomposeGoalWithLLM('goal', stubText('I cannot do that.')),
    ).rejects.toThrow(/contained no tasks/);
    await expect(
      decomposeGoalWithLLM(
        'goal',
        stubText(
          '{"title":"t","tasks":[{"id":"a","title":"a","description":"","dependencies":["b"]},{"id":"b","title":"b","description":"","dependencies":["a"]}]}',
        ),
      ),
    ).rejects.toThrow(/cycle/);
  });

  it('rejects a cycle hidden behind a healthy root task', async () => {
    await expect(
      decomposeGoalWithLLM(
        'goal',
        stubText(
          '{"title":"t","tasks":[' +
            '{"id":"root","title":"r","description":"","dependencies":[]},' +
            '{"id":"a","title":"a","description":"","dependencies":["b"]},' +
            '{"id":"b","title":"b","description":"","dependencies":["a"]}]}',
        ),
      ),
    ).rejects.toThrow(/cycle/);
  });

  it('materializes a runnable graph that the executor completes', async () => {
    const decomposition = await decomposeGoalWithLLM('Ship the feature', stubText(validAnswer));
    const graph = decomposedGoalToGraph(decomposition, 'g_plan');
    const registry = createDefaultBlockRegistry();

    const validation = validateGraph(graph, registry);
    expect(validation.ok).toBe(true);

    const executor = new GraphExecutor(registry, {
      llmCall: stubLlm('step result'),
    });
    const result = await executor.execute(graph, { trigger: 'manual' });

    expect(result.status).toBe('completed');
    expect(result.outputs['result']).toContain('step result');
    // The goal flowed into root tasks via the input node.
    expect(result.nodes.find((n) => n.nodeId === 'goal_input')?.status).toBe('completed');
  });

  it('topologically orders the materialized graph so dependents see dependency outputs', async () => {
    // The LLM listed the dependent FIRST — the graph must still run it after
    // its dependency and deliver the dependency's output as context.
    const unsorted =
      '```json\n{"title": "t", "tasks": [\n' +
      '{"id": "build", "title": "Build", "description": "Build it.", "dependencies": ["design"]},\n' +
      '{"id": "design", "title": "Design", "description": "Design it.", "dependencies": []}\n' +
      ']}\n```';
    const decomposition = await decomposeGoalWithLLM('goal', stubText(unsorted));
    const graph = decomposedGoalToGraph(decomposition, 'g_order');
    const registry = createDefaultBlockRegistry();

    const prompts: string[] = [];
    const executor = new GraphExecutor(registry, {
      llmCall: async (messages) => {
        prompts.push(messages.at(-1)?.getText() ?? '');
        return new AIMessage('DESIGN AND BUILD DONE');
      },
    });
    const result = await executor.execute(graph, { trigger: 'manual' });

    expect(result.status).toBe('completed');
    // task_build's prompt must contain the dependency's context — the design
    // task ran before build and its output was delivered into build's
    // context pin.
    const buildIndex = prompts.findIndex((p) => p.includes('Build it.'));
    const designIndex = prompts.findIndex((p) => p.includes('Design it.'));
    expect(designIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(designIndex);
    expect(prompts[buildIndex]).toContain('DESIGN AND BUILD DONE');
  });
});
