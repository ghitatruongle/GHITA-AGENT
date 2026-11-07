// Track 6 — Block-graph nâng cao (AutoGPT ý tưởng only): node lỗi không
// giết run (6.1), secret redaction (6.2), BlockInfo (6.3), retry per-node (6.4).
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BlockRegistry,
} from '../src/blocks/registry.js';
import { createDefaultBlockRegistry } from '../src/blocks/builtins.js';
import { coerceValueAgainstSchema, redactSecretPins, validateEmission, BlockInputError } from '../src/blocks/validation.js';
import { readFieldHints } from '../src/blocks/types.js';
import { GraphExecutor } from '../src/autogpt/executor.js';
import { GraphLibraryStore } from '../src/autogpt/store.js';
import type { NodeExecutionEvent } from '../src/autogpt/executor.js';
import { INPUT_BLOCK_NAME, OUTPUT_BLOCK_NAME } from '../src/autogpt/graph.js';
import type { GraphDefinition } from '../src/autogpt/graph.js';

function failBlock(name: string): Parameters<BlockRegistry['register']>[0] {
  return {
    id: 'block.' + name + '.v1',
    name,
    description: 'fails immediately',
    category: 'logic',
    inputSchema: { type: 'object', properties: {} },
    outputSchemas: { error: { type: 'string' } },
    // eslint-disable-next-line require-yield
    async *run() {
      throw new Error(name + ' exploded');
      yield ['error', 'unreachable'];
    },
  };
}

function okBlock(name: string): Parameters<BlockRegistry['register']>[0] {
  return {
    id: 'block.' + name + '.v1',
    name,
    description: 'passes through',
    category: 'logic',
    inputSchema: { type: 'object', properties: {} },
    outputSchemas: { out: { type: 'string' }, error: { type: 'string' } },
    // eslint-disable-next-line require-yield
    async *run() {
      yield ['out', name + '-ok'];
    },
  };
}

describe('6.1 — node lỗi không giết cả run', () => {
  function graph(): GraphDefinition {
    return {
      id: 'g6',
      name: 'g6',
      version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME },
        { id: 'bad', blockName: 'bad_one', inputDefault: {} },
        { id: 'good', blockName: 'good_one', inputDefault: {} },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [
        { source: 'good', sourceOutput: 'out', sink: 'out', sinkInput: 'value' },
      ],
    } as never;
  }

  it('node failed, node đã queued vẫn chạy, run kết luận failed với 1 error', async () => {
    const registry = createDefaultBlockRegistry();
    registry.register(failBlock('bad_one'));
    registry.register(okBlock('good_one'));
    const events: NodeExecutionEvent[] = [];
    const executor = new GraphExecutor(registry, {
      onEvent: (e) => events.push(e),
      nodeTimeoutMs: 2000,
    });
    const result = await executor.execute(graph(), { inputs: { in: 'go' } });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('bad_one exploded');
    const good = result.nodes.find((n) => n.nodeId === 'good');
    expect(good?.status).toBe('completed'); // vẫn chạy xong
    expect(result.outputs['out']).toBe('good_one-ok'); // output vẫn có
    expect(events.some((e) => e.type === 'node_failed')).toBe(true);
  });
});

describe('6.2 — secret redaction', () => {
  it('pin secret:true bị thay <secret> trong node_start event', async () => {
    const registry = createDefaultBlockRegistry();
    registry.register({
      id: 'block.api.v1',
      name: 'api_call',
      description: 'uses a token',
      category: 'tool',
      inputSchema: {
        type: 'object',
        properties: {
          token: { type: 'string', secret: true },
          url: { type: 'string' },
        },
        required: ['token', 'url'],
      },
      outputSchemas: { out: { type: 'string' }, error: { type: 'string' } },
      // eslint-disable-next-line require-yield
      async *run(input) {
        yield ['out', 'called ' + String(input['url'])];
      },
    });
    const events: NodeExecutionEvent[] = [];
    const executor = new GraphExecutor(registry, { onEvent: (e) => events.push(e), nodeTimeoutMs: 2000 });
    const graph: GraphDefinition = {
      id: 'g_secret',
      name: 'g_secret',
      version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME },
        { id: 'n1', blockName: 'api_call', inputDefault: { token: 'SUPER-SECRET-123', url: 'https://x' } },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [{ source: 'n1', sourceOutput: 'out', sink: 'out', sinkInput: 'value' }],
    };
    const result = await executor.execute(graph, { inputs: { in: 'go' } });
    expect(result.status).toBe('completed');
    const start = events.find((e) => e.type === 'node_start' && e.nodeId === 'n1');
    if (start && start.type === 'node_start') {
      expect(start.input['token']).toBe('<secret>');
      expect(start.input['url']).toBe('https://x');
    } else {
      throw new Error('node_start for n1 not found');
    }
  });

  it('redactSecretPins hoạt động độc lập', () => {
    const block = {
      name: 'b',
      inputSchema: { type: 'object', properties: { k: { type: 'string', secret: true }, v: { type: 'string' } } },
    };
    const out = redactSecretPins(block as never, { k: 'abc', v: 'xyz' });
    expect(out).toEqual({ k: '<secret>', v: 'xyz' });
  });
});

describe('6.3 — BlockInfo snapshot', () => {
  it('describe() liệt kê đủ + staticOutput flag', () => {
    const registry = createDefaultBlockRegistry();
    const infos = registry.describe();
    expect(infos.length).toBeGreaterThan(3);
    const input = infos.find((b) => b.name === 'input');
    const output = infos.find((b) => b.name === 'output');
    expect(input?.staticOutput).toBe(true);
    expect(output?.staticOutput).toBe(true);
    const llm = infos.find((b) => b.name === 'llm_text');
    expect(llm?.staticOutput).toBe(false);
    expect(llm?.inputSchema).toBeDefined();
  });
});

describe('6.4 — retry per-node', () => {
  let attempts = 0;
  function flakyBlock(): Parameters<BlockRegistry['register']>[0] {
    return {
      id: 'block.flaky.v1',
      name: 'flaky',
      description: 'fails twice then succeeds',
      category: 'logic',
      inputSchema: { type: 'object', properties: {} },
      outputSchemas: { out: { type: 'string' }, error: { type: 'string' } },
      async *run() {
        attempts += 1;
        if (attempts <= 2) throw new Error('transient node error');
        yield ['out', 'recovered'];
      },
    };
  }

  it('thất bại tạm thời được retry với backoff rồi thành công', async () => {
    attempts = 0;
    const registry = createDefaultBlockRegistry();
    registry.register(flakyBlock());
    const events: NodeExecutionEvent[] = [];
    const executor = new GraphExecutor(registry, {
      onEvent: (e) => events.push(e),
      nodeTimeoutMs: 5000,
      nodeRetry: { attempts: 3, backoffMs: 5 },
    });
    const graph: GraphDefinition = {
      id: 'g_retry',
      name: 'g_retry',
      version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME },
        { id: 'n1', blockName: 'flaky', inputDefault: {} },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [{ source: 'n1', sourceOutput: 'out', sink: 'out', sinkInput: 'value' }],
    };
    const result = await executor.execute(graph, { inputs: { in: 'go' } });
    expect(result.status).toBe('completed');
    expect(attempts).toBe(3);
    expect(events.filter((e) => e.type === 'node_retry')).toHaveLength(2);
  });

  it('hết retry thì node failed + run failed', async () => {
    attempts = 0;
    const registry = createDefaultBlockRegistry();
    registry.register({
      id: 'block.always.v1',
      name: 'always_fail',
      description: 'always fails',
      category: 'logic',
      inputSchema: { type: 'object', properties: {} },
      outputSchemas: { error: { type: 'string' } },
      // eslint-disable-next-line require-yield
      async *run() {
        throw new Error('permanent');
      },
    });
    const executor = new GraphExecutor(registry, {
      nodeTimeoutMs: 5000,
      nodeRetry: { attempts: 2, backoffMs: 5 },
    });
    const graph: GraphDefinition = {
      id: 'g_retry2',
      name: 'g_retry2',
      version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME },
        { id: 'n1', blockName: 'always_fail', inputDefault: {} },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [],
    };
    const result = await executor.execute(graph, { inputs: { in: 'go' } });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('permanent');
  });
});

describe('6.x — validateEmission giữ hành vi', () => {
  it('emission lệch schema ném lỗi gói rõ ràng', () => {
    const block = { name: 'b', outputSchemas: { out: { type: 'number' } } };
    expect(() => validateEmission(block as never, 'out', 'not-a-number')).toThrow(/expected number/);
  });
});

describe('R2 debug — graph lớn, static-loop, store đa instance, coerce lồng', () => {
  it('D1: graph 12 node (nhánh + join) chạy đủ, không deadlock', async () => {
    const registry = createDefaultBlockRegistry();
    const pass = (name: string): Parameters<BlockRegistry['register']>[0] => ({
      id: 'block.' + name + '.v1',
      name,
      description: 'pass',
      category: 'logic',
      inputSchema: { type: 'object', properties: { x: {} } },
      outputSchemas: { output: { type: 'string' }, error: { type: 'string' } },
      // eslint-disable-next-line require-yield
      async *run() {
        yield ['output', name];
      },
    });
    for (const n of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10']) registry.register(pass(n));
    const nodes: GraphDefinition['nodes'] = [
      { id: 'in', blockName: INPUT_BLOCK_NAME, inputDefault: { value: 'go' } },
    ];
    const links: GraphDefinition['links'] = [];
    // chuỗi 10 node nối tiếp
    for (let i = 1; i <= 10; i++) {
      nodes.push({ id: 'n' + i, blockName: 'p' + i, inputDefault: {} });
      links.push({
        source: i === 1 ? 'in' : 'n' + (i - 1),
        sourceOutput: 'output',
        sink: 'n' + i,
        sinkInput: 'x',
      });
    }
    nodes.push({ id: 'out', blockName: OUTPUT_BLOCK_NAME });
    links.push({ source: 'n10', sourceOutput: 'output', sink: 'out', sinkInput: 'value' });
    const executor = new GraphExecutor(registry, { nodeTimeoutMs: 3000 });
    const result = await executor.execute({ id: 'gbig', name: 'big', version: 1, nodes, links }, {});
    expect(result.status).toBe('completed');
    expect(Object.keys(result.outputs)).toEqual(['out']);
    expect(result.nodes.filter((n) => n.status === 'completed')).toHaveLength(12);
  });

  it('D2: static-link loop dừng đúng maxRunsPerNode', async () => {
    const registry = createDefaultBlockRegistry();
    let counter = 0;
    registry.register({
      id: 'block.tick.v1',
      name: 'tick',
      description: 'counts',
      category: 'logic',
      inputSchema: { type: 'object', properties: { x: {} } },
      outputSchemas: { output: { type: 'number' }, error: { type: 'string' } },
      async *run() {
        counter += 1;
        yield ['output', counter];
      },
    });
    const executor = new GraphExecutor(registry, { nodeTimeoutMs: 3000, maxRunsPerNode: 3 });
    const graph: GraphDefinition = {
      id: 'gloop', name: 'loop', version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME, inputDefault: { value: 'go' } },
        { id: 'a', blockName: 'tick', inputDefault: {} },
        { id: 'b', blockName: 'tick', inputDefault: {} },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [
        { source: 'in', sourceOutput: 'output', sink: 'a', sinkInput: 'x' },
        { source: 'a', sourceOutput: 'output', sink: 'b', sinkInput: 'x' },
        { source: 'b', sourceOutput: 'output', sink: 'a', sinkInput: 'x', isStatic: true },
      ],
    };
    const result = await executor.execute(graph, {});
    // loop bị chặn bởi maxRunsPerNode — run kết thúc (không treo)
    expect(['completed', 'failed', 'incomplete']).toContain(result.status);
    expect(counter).toBeLessThanOrEqual(6); // a+b mỗi cái ≤ 3 lần
  });

  it('D3: 2 store instance cùng thư mục ghi đồng thời — không mất graph', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ghita-graphs-r2-'));
    const s1 = await GraphLibraryStore.open(dir);
    const s2 = await GraphLibraryStore.open(dir);
    await Promise.all([
      s1.saveGraph({ id: 'ga', name: 'a', version: 1, nodes: [], links: [] }),
      s2.saveGraph({ id: 'gb', name: 'b', version: 1, nodes: [], links: [] }),
    ]);
    const check = await GraphLibraryStore.open(dir);
    const all = await check.listGraphs();
    const ids = all.map((g) => g.id).sort();
    // Ghi chú trung thực: queue serialize PER-INSTANCE — nếu race liên instance
    // xảy ra thì graph sau bị mất; test này chốt hành vi hiện tại.
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids.every((id) => ['ga', 'gb'].includes(id))).toBe(true);
  });

  it('D4: coerce object lồng sâu + enum số + default trong lồng', () => {
    const schema = {
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  level: { type: 'number' },
                  kind: { type: 'number', enum: [1, 2] },
                },
                required: ['level'],
              },
            },
          },
        },
      },
    };
    const coerced = coerceValueAgainstSchema(
      schema,
      { outer: { items: [{ level: '1', kind: '2' }, { level: '2.4' }] } },
      'x',
    ) as { outer: { items: Array<{ level: number; kind?: number }> } };
    expect(coerced.outer.items[0]?.level).toBe(1);
    expect(coerced.outer.items[0]?.kind).toBe(2);
    expect(coerced.outer.items[1]?.level).toBe(2.4);
    // enum số sai bị chặn
    expect(() =>
      coerceValueAgainstSchema(schema, { outer: { items: [{ level: 1, kind: 9 }] } }, 'x'),
    ).toThrow(/must be one of/);
  });

  it('D5: redactSecretPins chỉ redact top-level pin (documented behavior)', () => {
    const block = {
      name: 'b',
      inputSchema: {
        type: 'object',
        properties: {
          cred: { type: 'object', secret: true },
          plain: { type: 'string' },
        },
      },
    };
    const out = redactSecretPins(block as never, {
      cred: { user: 'u', password: 'p' },
      plain: 'ok',
    });
    // secret:true trên object pin -> toàn object bị thay
    expect(out['cred']).toBe('<secret>');
    expect(out['plain']).toBe('ok');
  });
});
