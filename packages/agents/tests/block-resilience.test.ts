// Track 2 — Block-graph chắc tay (AutoGPT patterns, ý tưởng only).
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage } from '../src/messages/message.js';
import { createDefaultBlockRegistry } from '../src/blocks/builtins.js';
import { readFieldHints } from '../src/blocks/types.js';
import {
  BlockInputError,
  BlockOutputError,
  coerceValueAgainstSchema,
  validateBlockInput,
  validateEmission,
} from '../src/blocks/validation.js';
import { GraphExecutor } from '../src/autogpt/executor.js';
import { INPUT_BLOCK_NAME, OUTPUT_BLOCK_NAME } from '../src/autogpt/graph.js';
import type { GraphDefinition } from '../src/autogpt/graph.js';
import { GraphLibraryStore } from '../src/autogpt/store.js';

function linearGraph(prompt: string): GraphDefinition {
  return {
    id: 'g_test',
    name: 'test-graph',
    version: 1,
    nodes: [
      { id: 'in', blockName: INPUT_BLOCK_NAME },
      { id: 'ask', blockName: 'llm_text', inputDefault: { prompt } },
      { id: 'out', blockName: OUTPUT_BLOCK_NAME },
    ],
    links: [
      { source: 'in', sourceOutput: 'output', sink: 'ask', sinkInput: 'context' },
      { source: 'ask', sourceOutput: 'output', sink: 'out', sinkInput: 'value' },
    ],
  };
}

describe('2.1 — validate input: coerce + mismatch', () => {
  it('coerces string to number per schema type', () => {
    const schema = { type: 'object', properties: { n: { type: 'number' } } };
    const result = coerceValueAgainstSchema(schema, { n: '42' }, 'x');
    expect(result).toEqual({ n: 42 });
  });

  it('rejects an unparseable number with an actionable message', () => {
    const schema = { type: 'object', properties: { n: { type: 'number' } } };
    expect(() => coerceValueAgainstSchema(schema, { n: 'abc' }, 'x')).toThrow(BlockInputError);
    expect(() => coerceValueAgainstSchema(schema, { n: 'abc' }, 'x')).toThrow(/expected number, got unparseable string "abc"/);
  });

  it('coerces boolean strings and rejects junk booleans', () => {
    const schema = { type: 'object', properties: { flag: { type: 'boolean' } } };
    expect(coerceValueAgainstSchema(schema, { flag: 'true' }, 'x')).toEqual({ flag: true });
    expect(() => coerceValueAgainstSchema(schema, { flag: 'maybe' }, 'x')).toThrow(/expected boolean/);
  });

  it('merges schema defaults into missing optional pins', () => {
    const block = {
      name: 'b',
      inputSchema: {
        type: 'object',
        properties: { greeting: { type: 'string', default: 'hi' } },
      },
    };
    const result = validateBlockInput(block as never, {}, 'n1');
    expect(result).toEqual({ greeting: 'hi' });
  });

  it('fails when a required pin is missing', () => {
    const block = {
      name: 'b',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
      },
    };
    expect(() => validateBlockInput(block as never, {}, 'n1')).toThrow(/pin "q" is required but missing/);
  });

  it('runs the graph: string seed coerced through the executor pipeline', async () => {
    const registry = createDefaultBlockRegistry();
    const executor = new GraphExecutor(registry, {
      llmCall: async () => new AIMessage('ok'),
      nodeTimeoutMs: 2000,
    });
    const graph = linearGraph('Say ok.');
    const result = await executor.execute(graph, { inputs: { in: 'seed-value' } });
    expect(result.status).toBe('completed');
    expect(Object.keys(result.outputs)).toEqual(['out']);
  });
});

describe('2.2 — validate output mỗi emission', () => {
  const badBlock = {
    id: 'block.bad.v1',
    name: 'bad_emitter',
    description: 'Emits a string where the pin says object',
    category: 'logic' as const,
    inputSchema: { type: 'object', properties: {} },
    outputSchemas: { out: { type: 'object' }, error: { type: 'string' } },
    // eslint-disable-next-line require-yield
    async *run() {
      yield ['out', 'plain string'] as [string, unknown];
    },
  };

  const goodBlock = {
    id: 'block.good.v1',
    name: 'good_emitter',
    description: 'Emits matching shapes',
    category: 'logic' as const,
    inputSchema: { type: 'object', properties: {} },
    outputSchemas: { out: { type: 'object' }, error: { type: 'string' } },
    // eslint-disable-next-line require-yield
    async *run() {
      yield ['out', { ok: true }] as [string, unknown];
    },
  };

  it('validateEmission rejects a schema-violating value', () => {
    const block = badBlock;
    expect(() => validateEmission(block, 'out', 'plain string')).toThrow(BlockOutputError);
    expect(() => validateEmission(goodBlock, 'out', { ok: true })).not.toThrow();
  });

  it('fails the node when a block emits a schema-violating output', async () => {
    const registry = createDefaultBlockRegistry();
    registry.register(badBlock);
    const executor = new GraphExecutor(registry, { nodeTimeoutMs: 2000 });
    const graph: GraphDefinition = {
      id: 'g_bad',
      name: 'bad-graph',
      version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME, inputDefault: { value: 'go' } },
        { id: 'n1', blockName: 'bad_emitter', inputDefault: {} },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [{ source: 'n1', sourceOutput: 'out', sink: 'out', sinkInput: 'value' }],
    };
    const result = await executor.execute(graph, {});
    expect(result.status).toBe('failed');
    expect(result.error).toContain('violating schema');
    const n1 = result.nodes.find((n) => n.nodeId === 'n1');
    expect(n1?.status).toBe('failed');
  });
});

describe('2.2 — llm_structured pin schema', () => {
  it('validates parsed JSON against the schema pin', async () => {
    const registry = createDefaultBlockRegistry();
    const executor = new GraphExecutor(registry, {
      llmCall: async () => new AIMessage('{"count": 3}'),
      nodeTimeoutMs: 2000,
    });
    const graph: GraphDefinition = {
      id: 'g_schema_ok',
      name: 'schema-ok',
      version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME, inputDefault: { value: 'go' } },
        { id: 'n1', blockName: 'llm_structured', inputDefault: { prompt: 'give count', schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } } },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [{ source: 'n1', sourceOutput: 'output', sink: 'out', sinkInput: 'value' }],
    };
    const result = await executor.execute(graph, {});
    expect(result.status).toBe('completed');
    expect(result.outputs['out']).toEqual({ count: 3 });
  });

  it('fails the node when parsed JSON violates the schema pin', async () => {
    const registry = createDefaultBlockRegistry();
    const executor = new GraphExecutor(registry, {
      llmCall: async () => new AIMessage('{"wrong": 1}'),
      nodeTimeoutMs: 2000,
    });
    const graph: GraphDefinition = {
      id: 'g_schema_bad',
      name: 'schema-bad',
      version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME, inputDefault: { value: 'go' } },
        { id: 'n1', blockName: 'llm_structured', inputDefault: { prompt: 'give count', schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } } },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [{ source: 'n1', sourceOutput: 'output', sink: 'out', sinkInput: 'value' }],
    };
    const result = await executor.execute(graph, {});
    expect(result.status).toBe('failed');
    expect(result.error).toContain('is required');
  });
});

describe('2.3 — UI hints', () => {
  it('reads hints off a property schema', () => {
    const hints = readFieldHints({ type: 'string', placeholder: 'URL…', secret: true, advanced: true });
    expect(hints).toEqual({ placeholder: 'URL…', secret: true, advanced: true });
  });

  it('returns empty hints for plain schemas', () => {
    expect(readFieldHints({ type: 'string' })).toEqual({});
  });

  it('llm_structured ships hints (advanced/title/placeholder)', () => {
    const registry = createDefaultBlockRegistry();
    const block = registry.get('llm_structured');
    expect(block).toBeDefined();
    const props = block?.inputSchema['properties'] as Record<string, Record<string, unknown>>;
    expect(readFieldHints(props['system'] ?? {})).toMatchObject({ advanced: true });
    expect(readFieldHints(props['schema'] ?? {})).toMatchObject({ advanced: true, title: 'Output schema' });
    expect(readFieldHints(props['prompt'] ?? {})).toMatchObject({ placeholder: 'What to generate…' });
  });
});

describe('2.4 — GraphLibraryStore persist + version', () => {
  const baseGraph = (): GraphDefinition => ({
    id: 'g_lib',
    name: 'lib-graph',
    version: 1,
    nodes: [{ id: 'in', blockName: INPUT_BLOCK_NAME }],
    links: [],
  });

  it('save bumps version when saving the same draft version again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ghita-graphs-'));
    const store = await GraphLibraryStore.open(dir);
    const v1 = await store.saveGraph(baseGraph());
    expect(v1.version).toBe(1);
    const v2 = await store.saveGraph(baseGraph());
    expect(v2.version).toBe(2);
    const latest = await store.getGraph('g_lib');
    expect(latest?.version).toBe(2);
  });

  it('restart keeps graphs and run history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ghita-graphs-'));
    const first = await GraphLibraryStore.open(dir);
    await first.saveGraph(baseGraph());
    await first.recordRun({
      executionId: 'exec_1',
      graphId: 'g_lib',
      graphVersion: 1,
      trigger: 'manual',
      status: 'completed',
      outputs: { out: { done: true } },
      nodes: [],
      startedAt: 1,
      finishedAt: 2,
    });

    const reopened = await GraphLibraryStore.open(dir);
    const latest = await reopened.getGraph('g_lib');
    expect(latest?.version).toBe(1);
    const runs = await reopened.listRuns('g_lib');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outputs).toEqual({ out: { done: true } });
  });

  it('recordRun upserts by executionId and listRuns sorts newest first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ghita-graphs-'));
    const store = await GraphLibraryStore.open(dir);
    await store.recordRun({ executionId: 'e1', graphId: 'g', graphVersion: 1, trigger: 'manual', status: 'completed', outputs: {}, nodes: [], startedAt: 1, finishedAt: 10 });
    await store.recordRun({ executionId: 'e2', graphId: 'g', graphVersion: 1, trigger: 'manual', status: 'failed', outputs: {}, nodes: [], startedAt: 2, finishedAt: 20 });
    await store.recordRun({ executionId: 'e1', graphId: 'g', graphVersion: 1, trigger: 'manual', status: 'completed', outputs: { fixed: 1 }, nodes: [], startedAt: 1, finishedAt: 15 });

    const runs = await store.listRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0]?.executionId).toBe('e2');
    const e1 = runs.find((r) => r.executionId === 'e1');
    expect(e1?.outputs).toEqual({ fixed: 1 });
  });
});

describe('9.2 — P2 fix regression', () => {
  it('P2-10: chuỗi rỗng coerce sang number phải lỗi rõ, không thành 0', () => {
    expect(() =>
      coerceValueAgainstSchema({ type: 'object', properties: { n: { type: 'number' } } }, { n: '   ' }, 'x'),
    ).toThrow(/empty string/);
  });

  it('P2-9: llm_structured phát bản ĐÃ coerce theo schema pin', async () => {
    const registry = createDefaultBlockRegistry();
    const executor = new GraphExecutor(registry, {
      llmCall: async () => new AIMessage('{"count": "7"}'),
      nodeTimeoutMs: 2000,
    });
    const graph: GraphDefinition = {
      id: 'g_coerce',
      name: 'g_coerce',
      version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME, inputDefault: { value: 'go' } },
        { id: 'n1', blockName: 'llm_structured', inputDefault: { prompt: 'n', schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } } },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [{ source: 'n1', sourceOutput: 'output', sink: 'out', sinkInput: 'value' }],
    };
    const result = await executor.execute(graph, {});
    expect(result.status).toBe('completed');
    expect(result.outputs['out']).toEqual({ count: 7 }); // số, không phải "7"
  });
});

describe('9.2 vòng 2 — store quarantine', () => {
  it('graphs.json hỏng bị quarantine (.corrupt-<ts>) thay vì nuốt rỗng', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ghita-graphs-'));
    const store = await GraphLibraryStore.open(dir);
    await store.saveGraph({ id: 'gq', name: 'q', version: 1, nodes: [], links: [] });
    // Làm hỏng file
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'graphs.json'), '{không phải json', 'utf8');

    const reopened = await GraphLibraryStore.open(dir);
    const graphs = await reopened.listGraphs();
    expect(graphs).toHaveLength(0); // đọc rỗng an toàn
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(dir);
    expect(files.some((f) => f.startsWith('graphs.json.corrupt-'))).toBe(true); // bị cách ly
  });
});
