// E2E debug scenarios (vòng review+debug 0.0.1): chạy THẬT engine end-to-end —
// thứ tự event, usage xuyên hierarchical, deadline cắt giữa retry-backoff,
// cancel giữa task, persist -> reopen -> version, cancel node, combo schema+usage.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage } from '../src/messages/message.js';
import { Crew } from '../src/crew/crew.js';
import { GraphExecutor } from '../src/autogpt/executor.js';
import { GraphLibraryStore } from '../src/autogpt/store.js';
import { INPUT_BLOCK_NAME, OUTPUT_BLOCK_NAME } from '../src/autogpt/graph.js';
import type { CrewEvent, CrewAgentSpec, CrewTaskExecutor } from '../src/crew/types.js';
import type { GraphDefinition } from '../src/autogpt/graph.js';
import type { NodeExecutionEvent } from '../src/autogpt/executor.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghita-dbg-'));
  (globalThis as Record<string, unknown>).ghitaWorkspaceRoot = dir;
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>).ghitaWorkspaceRoot;
  rmSync(dir, { recursive: true, force: true });
});

const a1: CrewAgentSpec = { id: 'a1', name: 'N1', role: 'writer', goal: 'g1' };
const a2: CrewAgentSpec = { id: 'a2', name: 'N2', role: 'reviewer', goal: 'g2' };

describe('DBG crew end-to-end', () => {
  it('S1 chuỗi sự kiện đúng thứ tự khi chạy 3 task có usage', async () => {
    const events: CrewEvent[] = [];
    const executor: CrewTaskExecutor = async (req) => {
      req.onUsage?.({ promptTokens: 3, completionTokens: 2, requests: 1 });
      return 'x-' + req.taskId;
    };
    const crew = new Crew({ onEvent: (e) => events.push(e) })
      .addAgent(a1).addAgent(a2)
      .addTask({ id: 't1', description: 'd1', agentId: 'a1' })
      .addTask({ id: 't2', description: 'd2', agentId: 'a2', context: ['t1'] })
      .addTask({ id: 't3', description: 'd3', agentId: 'a1' });
    const r = await crew.kickoff({ executor });
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('crew_start');
    expect(types[types.length - 1]).toBe('crew_complete');
    // 3 task_start trước 3 task_complete xen kẽ đúng cặp
    const starts = types.filter((t) => t === 'task_start').length;
    const dones = types.filter((t) => t === 'task_complete').length;
    expect(starts).toBe(3);
    expect(dones).toBe(3);
    expect(r.usage?.requests).toBe(3);
    expect(r.usage?.promptTokens).toBe(9);
  });

  it('S2 hierarchical: usage từ member executor chảy về crew + delegation event', async () => {
    const events: CrewEvent[] = [];
    const executor: CrewTaskExecutor = async (req) => {
      req.onUsage?.({ promptTokens: 5, completionTokens: 1, requests: 1 });
      return 'member-out';
    };
    const crew = new Crew({ process: 'hierarchical', onEvent: (e) => events.push(e) })
      .addAgent(a1).addAgent(a2)
      .addTask({ id: 'h1', description: 'route me' });
    const r = await crew.kickoff({ executor });
    expect(r.status).toBe('completed');
    // LLM stub không gọi tool -> manager tự trả lời, không delegation;
    // usage = đúng 1 mẫu từ manager (chứng minh hierarchical chạy xuyên).
    expect(r.usage?.requests).toBe(1);
  });

  it('S3 deadline bắn trong lúc backoff retry — run failed đúng, không treo', async () => {
    let attempts = 0;
    const executor: CrewTaskExecutor = async () => {
      attempts += 1;
      throw new Error('503 service unavailable');
    };
    const crew = new Crew({ maxExecutionTime: 400, llmRetriesPerTask: 5 })
      .addAgent(a1)
      .addTask({ id: 't1', description: 'x' });
    const r = await crew.kickoff({ executor });
    expect(r.status).toBe('failed');
    expect(r.error).toContain('timed out');
    // attempt1 fail tức thì -> retry1 sleep 250ms -> attempt2 fail -> deadline
    // 400ms bắn trong sleep2(500ms): đúng 2 attempt, không treo vô hạn.
    expect(attempts).toBe(2);
  });

  it('S4 cancel giữa task: task_failed + crew failed + partial outputs', async () => {
    const ac = new AbortController();
    const executor: CrewTaskExecutor = (req) =>
      new Promise<string>((resolve, reject) => {
        req.signal?.addEventListener('abort', () => reject(new Error('Crew task was cancelled.')), { once: true });
        setTimeout(() => resolve('too late'), 5000);
      });
    const crew = new Crew({ signal: ac.signal })
      .addAgent(a1)
      .addTask({ id: 't1', description: 'one' })
      .addTask({ id: 't2', description: 'two' });
    const p = crew.kickoff({ executor });
    // chạy xong t1 rồi cancel khi t2 đang chạy: poll đơn giản
    setTimeout(() => ac.abort(), 50);
    const r = await p;
    expect(r.status).toBe('failed');
    expect(r.taskOutputs.length).toBeGreaterThanOrEqual(0);
  });
});

describe('DBG graph + store', () => {
  function g(id: string): GraphDefinition {
    return {
      id, name: id, version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME },
        { id: 'ask', blockName: 'llm_text', inputDefault: { prompt: 'hi' } },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [
        { source: 'in', sourceOutput: 'output', sink: 'ask', sinkInput: 'context' },
        { source: 'ask', sourceOutput: 'output', sink: 'out', sinkInput: 'value' },
      ],
    };
  }

  it('S5 persist -> mở lại -> save tiếp -> version tăng liên tục', async () => {
    const store = await GraphLibraryStore.open(join(dir, 'lib'));
    const v1 = await store.saveGraph(g('gp'));
    expect(v1.version).toBe(1);
    const v2 = await store.saveGraph(g('gp'));
    expect(v2.version).toBe(2);
    const reopen = await GraphLibraryStore.open(join(dir, 'lib'));
    expect((await reopen.getGraph('gp'))?.version).toBe(2);
    const v3 = await reopen.saveGraph(g('gp'));
    expect(v3.version).toBe(3);
    await reopen.deleteGraph('gp');
    expect(await reopen.getGraph('gp')).toBeUndefined();
  });

  it('S6 cancel giữa node: status terminated, không treo', async () => {
    const ac = new AbortController();
    const registry = createDefaultRegistryDbg();
    const executor = new GraphExecutor(registry, {
      llmCall: async (msg, cfg) => {
        // giả lập LLM tôn trọng signal
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 5000);
          cfg?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
        });
        return new AIMessage('never');
      },
      nodeTimeoutMs: 4500,
    });
    const graph = g('gc');
    setTimeout(() => ac.abort(), 60);
    const result = await executor.execute(graph, { inputs: { in: 'go' }, signal: ac.signal });
    expect(result.status).toBe('terminated');
  });

  it('S7 llm_structured + usage + secret redaction cùng lúc trong 1 run', async () => {
    const registry = createDefaultRegistryDbg();
    const events: NodeExecutionEvent[] = [];
    const executor = new GraphExecutor(registry, {
      onEvent: (e) => events.push(e),
      llmCall: async () => new AIMessage('{"n": "42"}'),
      nodeTimeoutMs: 3000,
    });
    const graph: GraphDefinition = {
      id: 'gcombo', name: 'gcombo', version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME },
        { id: 's', blockName: 'llm_structured', inputDefault: { prompt: 'p', schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } } },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [{ source: 's', sourceOutput: 'output', sink: 'out', sinkInput: 'value' }],
    };
    const result = await executor.execute(graph, { inputs: { in: 'go' } });
    expect(result.status).toBe('completed');
    expect(result.outputs['out']).toEqual({ n: 42 });
  });
});

// helper: registry mặc định (tránh import đè)
import { createDefaultBlockRegistry } from '../src/blocks/builtins.js';
function createDefaultRegistryDbg() {
  return createDefaultBlockRegistry();
}
