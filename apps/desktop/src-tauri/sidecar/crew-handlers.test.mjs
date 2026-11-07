// H2.5 — integration test socket -> crew-handlers -> engine (node --test).
// Engine THẬT (@ghita/agents), chỉ fake orchestratorChat (LLM) + socket.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCrewWorkflowHandlers } from './crew-handlers.mjs';

/** Socket giả: ghi lại emit + thu handler đã đăng ký. */
function fakeSocket() {
  const emitted = [];
  const handlers = new Map();
  return {
    emitted,
    handlers,
    emit(event, payload) {
      emitted.push([event, payload]);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    /** Sự kiện cuối cùng theo tên. */
    last(name) {
      for (let i = emitted.length - 1; i >= 0; i--) {
        if (emitted[i][0] === name) return emitted[i][1];
      }
      return undefined;
    },
    all(name) {
      return emitted.filter((e) => e[0] === name).map((e) => e[1]);
    },
  };
}

function makeDeps(overrides = {}) {
  return {
    loadEngine: () => import('@ghita/agents'),
    orchestratorChat: async () => ({ content: 'ok', toolCalls: [], usage: undefined }),
    getAuthorizedClient: () => ({ device: null, isDesktop: true, senderId: 'desktop' }),
    getWorkspaceRoot: () => undefined,
    log: () => {},
    ...overrides,
  };
}

function registerWith(deps) {
  const socket = fakeSocket();
  const register = createCrewWorkflowHandlers(deps);
  register(socket);
  return socket;
}

test('crew_run happy path: đủ event đúng thứ tự + crew_done completed', async () => {
  const socket = registerWith(makeDeps());
  await socket.handlers.get('crew_run')({
    process: 'sequential',
    agents: [{ id: 'a1', name: 'N1', role: 'writer', goal: 'g' }],
    tasks: [
      { id: 't1', description: 'd1', agentId: 'a1' },
      { id: 't2', description: 'd2', agentId: 'a1' },
    ],
    inputs: {},
  });

  const done = socket.last('crew_done');
  assert.equal(done.status, 'completed');
  assert.equal(done.output, 'ok'); // orchestratorChat trả 'ok' cho cả 2 task
  const types = socket.all('crew_event').map((p) => p.event.type);
  assert.equal(types[0], 'crew_start');
  assert.equal(types.at(-1), 'crew_complete');
  assert.equal(types.filter((t) => t === 'task_start').length, 2);
  assert.equal(types.filter((t) => t === 'task_complete').length, 2);
});

test('crew_run chưa auth -> chat_error, không engine chạy', async () => {
  const socket = registerWith(makeDeps({ getAuthorizedClient: () => null }));
  await socket.handlers.get('crew_run')({
    agents: [{ id: 'a1', name: 'N', role: 'r', goal: 'g' }],
    tasks: [{ id: 't1', description: 'd' }],
  });
  const err = socket.last('chat_error');
  assert.ok(err, 'phải có chat_error');
  assert.ok(!socket.last('crew_done'), 'không được có crew_done');
});

test('crew_run thiếu agents/tasks -> chat_error rõ ràng', async () => {
  const socket = registerWith(makeDeps());
  await socket.handlers.get('crew_run')({ agents: [], tasks: [] });
  const err = socket.last('chat_error');
  assert.ok(err && err.message.includes('requires at least one agent and one task'));
  assert.ok(!socket.last('crew_done'));
});

test('crew_run khi đang có run -> chat_error từ chối run kép', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const socket = registerWith(
    makeDeps({
      orchestratorChat: async () => {
        await gate;
        return { content: 'slow', toolCalls: [] };
      },
    }),
  );
  const payload = {
    agents: [{ id: 'a1', name: 'N', role: 'r', goal: 'g' }],
    tasks: [{ id: 't1', description: 'd' }],
  };
  const first = socket.handlers.get('crew_run')(payload);
  await new Promise((r) => setTimeout(r, 30)); // cho run đầu vào trạng thái active
  await socket.handlers.get('crew_run')(payload);
  release();
  await first;
  const errs = socket.all('chat_error');
  assert.ok(errs.some((e) => e.message.includes('Another crew run is already active')));
});

test('crew_cancel: run đang treo bị hủy -> crew_done failed kèm cancel', async () => {
  const socket = registerWith(
    makeDeps({
      orchestratorChat: async (msgs, cfg) => {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 10_000);
          cfg?.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('Crew task was cancelled.'));
          }, { once: true });
        });
        return { content: 'never', toolCalls: [] };
      },
    }),
  );
  const runPromise = socket.handlers.get('crew_run')({
    agents: [{ id: 'a1', name: 'N', role: 'r', goal: 'g' }],
    tasks: [{ id: 't1', description: 'd' }],
  });
  await new Promise((r) => setTimeout(r, 50));
  socket.handlers.get('crew_cancel')();
  await runPromise;
  const done = socket.last('crew_done');
  assert.equal(done.status, 'failed');
  assert.ok(
    done.error.toLowerCase().includes('cancel'),
    'lỗi phải nói tới cancel, nhận: ' + done.error,
  );
});

test('workflow_run happy: llm_text graph -> workflow_done completed + outputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghita-wf-'));
  await mkdir(join(root, '.ghita', 'graph-library'), { recursive: true });
  const socket = registerWith(makeDeps({ getWorkspaceRoot: () => root }));
  await socket.handlers.get('workflow_run')({
    graph: {
      id: 'g_wf',
      name: 'wf-test',
      version: 1,
      nodes: [
        { id: 'in', blockName: 'input' },
        { id: 'ask', blockName: 'llm_text', inputDefault: { prompt: 'hi' } },
        { id: 'out', blockName: 'output' },
      ],
      links: [
        { source: 'in', sourceOutput: 'output', sink: 'ask', sinkInput: 'context' },
        { source: 'ask', sourceOutput: 'output', sink: 'out', sinkInput: 'value' },
      ],
    },
    inputs: { in: 'go' },
  });
  const done = socket.last('workflow_done');
  assert.equal(done.status, 'completed');
  assert.ok(Object.keys(done.outputs).includes('out'));
  assert.equal(socket.all('workflow_event').length > 0, true);
  assert.ok(done.outputs['out']);
});

test('workflow_run graph sai block -> workflow_done failed kèm lỗi rõ', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghita-wf-'));
  const socket = registerWith(makeDeps({ getWorkspaceRoot: () => root }));
  await socket.handlers.get('workflow_run')({
    graph: {
      id: 'g_bad',
      name: 'bad',
      version: 1,
      nodes: [{ id: 'in', blockName: 'input' }],
      links: [],
    },
    inputs: {},
  });
  const done = socket.last('workflow_done');
  assert.equal(done.status, 'failed');
  assert.ok(done.error && done.error.length > 0);
});

test('workflow_human_input_response giải ticket -> node human tiếp tục', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghita-wf-'));
  const socket = registerWith(makeDeps({ getWorkspaceRoot: () => root }));
  const runPromise = socket.handlers.get('workflow_run')({
    graph: {
      id: 'g_human',
      name: 'human',
      version: 1,
      nodes: [
        { id: 'in', blockName: 'input', inputDefault: { value: 'go' } },
        { id: 'h', blockName: 'human_in_the_loop', inputDefault: { prompt: 'Trả lời?' } },
        { id: 'out', blockName: 'output' },
      ],
      links: [
        { source: 'in', sourceOutput: 'output', sink: 'h', sinkInput: 'prompt' },
        { source: 'h', sourceOutput: 'output', sink: 'out', sinkInput: 'value' },
      ],
    },
    inputs: {},
  });
  await new Promise((r) => setTimeout(r, 120));
  const req = socket.last('workflow_human_input_required');
  assert.ok(req && req.ticket, 'phải có ticket');
  socket.handlers.get('workflow_human_input_response')({ ticket: req.ticket, answer: '42' });
  await runPromise;
  const done = socket.last('workflow_done');
  assert.equal(done.status, 'completed');
  assert.equal(done.outputs['out'], '42');
});
