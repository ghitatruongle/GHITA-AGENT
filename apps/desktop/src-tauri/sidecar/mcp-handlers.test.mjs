// Track 6.3 — unit test socket -> mcp-handlers (node --test).
// Pattern nguồn: crew-handlers.test.mjs — socket stub + deps fake, KHÔNG cần
// @ghita/mcp thật (subsystem được inject) trừ test createMcpSubsystem dùng
// module giả mô phỏng API exports của @ghita/mcp.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpHandlers, createMcpSubsystem } from './mcp-handlers.mjs';

/** Socket giả: ghi lại emit + thu handler đã đăng ký (copy từ crew-handlers.test.mjs). */
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

/** Health store giả ghi lại mọi lần record/markFailure. */
function fakeHealthStore() {
  const calls = [];
  return {
    calls,
    record(name, result) {
      calls.push(['record', name, result]);
    },
    markFailure(name, error) {
      calls.push(['markFailure', name, error]);
    },
    get() {
      return { state: 'healthy', checkedAt: 123 };
    },
    summary() {
      return { healthy: 1, degraded: 0, checking: 0, unknown: 0 };
    },
  };
}

/** Subsystem giả: client + healthStore, đếm callTool. */
function fakeSubsystem(overrides = {}) {
  const toolCalls = [];
  const healthStore = fakeHealthStore();
  const client = {
    refreshTools: async () => [
      { name: 'demo_tool', description: 'demo', inputSchema: { type: 'object' } },
    ],
    callTool: async (name, args) => {
      toolCalls.push([name, args]);
      return { content: [{ type: 'text', text: `called ${name}` }], isError: false };
    },
    ...overrides,
  };
  return { registry: {}, client, healthStore, toolCalls };
}

function makeDeps(overrides = {}) {
  const subsystem = overrides.subsystem ?? fakeSubsystem();
  return {
    subsystem,
    getMcpSubsystem: async () => subsystem,
    getAuthorizedClient: () => ({ device: null, isDesktop: true, senderId: 'desktop' }),
    log: () => {},
    ...overrides,
    // overrides đứng sau để getMcpSubsystem/getAuthorizedClient có thể bị thay
    // hoàn toàn; nhưng subsystem fake vẫn giữ lại để test assert.
  };
}

function registerWith(deps) {
  const socket = fakeSocket();
  const register = createMcpHandlers(deps);
  register(socket);
  return socket;
}

function ackSink(store) {
  return (payload) => store.push(payload);
}

test('mcp_list_tools happy: ack {success, tools} + healthStore record healthy', async () => {
  const deps = makeDeps();
  const socket = registerWith(deps);
  const acked = [];
  await socket.handlers.get('mcp_list_tools')({}, ackSink(acked));

  const res = acked[0];
  assert.equal(res.success, true);
  assert.equal(res.tools.length, 1);
  assert.equal(res.tools[0].name, 'demo_tool');
  const rec = deps.subsystem.healthStore.calls.at(-1);
  assert.equal(rec[0], 'record');
  assert.equal(rec[2].state, 'healthy');
  assert.equal(rec[2].toolCount, 1);
  assert.ok(!socket.last('chat_error'));
});

test('mcp_list_tools chưa auth -> chat_error + ack fail, KHÔNG đụng client', async () => {
  let clientTouched = false;
  const subsystem = fakeSubsystem({
    refreshTools: async () => {
      clientTouched = true;
      return [];
    },
  });
  const socket = registerWith(makeDeps({ subsystem, getAuthorizedClient: () => null }));
  const acked = [];
  await socket.handlers.get('mcp_list_tools')({}, ackSink(acked));

  assert.equal(acked[0].success, false);
  assert.ok(acked[0].error.includes('Unauthorized'));
  const err = socket.last('chat_error');
  assert.ok(err && err.message.includes('Unauthorized'));
  assert.equal(clientTouched, false);
});

test('mcp_list_tools subsystem dựng lỗi -> chat_error + ack fail rõ ràng', async () => {
  const socket = registerWith(
    makeDeps({ getMcpSubsystem: async () => { throw new Error('mcp module missing'); } }),
  );
  const acked = [];
  await socket.handlers.get('mcp_list_tools')({}, ackSink(acked));
  assert.equal(acked[0].success, false);
  assert.ok(acked[0].error.includes('mcp module missing'));
  const err = socket.last('chat_error');
  assert.ok(err && err.message.includes('MCP list tools failed'));
});

test('mcp_call_tool happy: args truyền nguyên vẹn + health record', async () => {
  const deps = makeDeps();
  const socket = registerWith(deps);
  const acked = [];
  await socket.handlers.get('mcp_call_tool')(
    { name: 'demo_tool', args: { pattern: 'abc', limit: 5 } },
    ackSink(acked),
  );

  assert.equal(deps.subsystem.toolCalls.length, 1);
  assert.deepEqual(deps.subsystem.toolCalls[0], ['demo_tool', { pattern: 'abc', limit: 5 }]);
  const res = acked[0];
  assert.equal(res.success, true);
  assert.equal(res.name, 'demo_tool');
  assert.equal(res.result.isError, false);
  assert.equal(res.result.content[0].text, 'called demo_tool');
  const rec = deps.subsystem.healthStore.calls.at(-1);
  assert.equal(rec[0], 'record');
  assert.equal(rec[2].state, 'healthy');
});

test('mcp_call_tool result isError:true được pass qua nguyên vẹn (vẫn success ở tầng handler)', async () => {
  const subsystem = fakeSubsystem({
    callTool: async () => ({
      content: [{ type: 'text', text: 'denied by policy: nope' }],
      isError: true,
    }),
  });
  const socket = registerWith(makeDeps({ subsystem }));
  const acked = [];
  await socket.handlers.get('mcp_call_tool')({ name: 'demo_tool', args: {} }, ackSink(acked));
  assert.equal(acked[0].success, true);
  assert.equal(acked[0].result.isError, true);
  assert.ok(acked[0].result.content[0].text.includes('denied by policy'));
});

test('mcp_call_tool tool name sai -> chat_error + ack fail, không gọi tool', async () => {
  const deps = makeDeps();
  const socket = registerWith(deps);
  for (const badName of ['', '   ', 42, 'bad;name', 'x'.repeat(201)]) {
    const acked = [];
    await socket.handlers.get('mcp_call_tool')({ name: badName, args: {} }, ackSink(acked));
    assert.equal(acked[0].success, false, `name ${JSON.stringify(badName)} phải bị từ chối`);
    assert.ok(acked[0].error.includes('Invalid MCP tool name'));
    assert.ok(socket.last('chat_error'));
  }
  assert.equal(deps.subsystem.toolCalls.length, 0);
});

test('mcp_call_tool args không phải object / không serialize được -> từ chối', async () => {
  const deps = makeDeps();
  const socket = registerWith(deps);
  const acked1 = [];
  await socket.handlers.get('mcp_call_tool')({ name: 'demo_tool', args: [1, 2] }, ackSink(acked1));
  assert.ok(acked1[0].error.includes('must be a JSON object'));

  const acked2 = [];
  const cyclic = {};
  cyclic.self = cyclic;
  await socket.handlers.get('mcp_call_tool')({ name: 'demo_tool', args: cyclic }, ackSink(acked2));
  assert.ok(acked2[0].error.includes('not JSON-serializable'));

  assert.equal(deps.subsystem.toolCalls.length, 0);
});

test('mcp_call_tool tool ném lỗi -> ack fail + healthStore.markFailure + chat_error', async () => {
  const subsystem = fakeSubsystem({
    callTool: async () => {
      throw new Error('transport dead');
    },
  });
  const socket = registerWith(makeDeps({ subsystem }));
  const acked = [];
  await socket.handlers.get('mcp_call_tool')({ name: 'demo_tool', args: {} }, ackSink(acked));

  assert.equal(acked[0].success, false);
  assert.ok(acked[0].error.includes('transport dead'));
  const rec = subsystem.healthStore.calls.at(-1);
  assert.equal(rec[0], 'markFailure');
  assert.ok(rec[2].includes('transport dead'));
  const err = socket.last('chat_error');
  assert.ok(err && err.message.includes('MCP tool "demo_tool" failed'));
});

test('mcp_call_tool subsystem dựng lỗi -> ack fail, markFailure bị bỏ qua an toàn', async () => {
  const socket = registerWith(
    makeDeps({ getMcpSubsystem: async () => { throw new Error('pair failed'); } }),
  );
  const acked = [];
  await socket.handlers.get('mcp_call_tool')({ name: 'demo_tool', args: {} }, ackSink(acked));
  assert.equal(acked[0].success, false);
  assert.ok(acked[0].error.includes('pair failed'));
  assert.ok(socket.last('chat_error'));
});

test('mcp_health happy: registryReady true + health healthy + summary', async () => {
  const deps = makeDeps();
  const socket = registerWith(deps);
  const acked = [];
  await socket.handlers.get('mcp_health')({}, ackSink(acked));

  const res = acked[0];
  assert.equal(res.success, true);
  assert.equal(res.registryReady, true);
  assert.equal(res.health.state, 'healthy');
  assert.deepEqual(res.summary, { healthy: 1, degraded: 0, checking: 0, unknown: 0 });
  assert.equal(res.registry, 'ghita-sidecar');
});

test('mcp_health subsystem chết vẫn OK: registryReady false + health degraded (không crash handler)', async () => {
  const socket = registerWith(
    makeDeps({ getMcpSubsystem: async () => { throw new Error('loadMcp exploded'); } }),
  );
  const acked = [];
  await socket.handlers.get('mcp_health')({}, ackSink(acked));

  const res = acked[0];
  assert.equal(res.success, true, 'health probe thất bại vẫn là một health result');
  assert.equal(res.registryReady, false);
  assert.equal(res.health.state, 'degraded');
  assert.ok(res.health.error.includes('loadMcp exploded'));
  assert.ok(!socket.last('chat_error'), 'health KHÔNG emit chat_error');
});

test('mcp_health chưa auth -> chat_error + ack fail', async () => {
  const socket = registerWith(makeDeps({ getAuthorizedClient: () => null }));
  const acked = [];
  await socket.handlers.get('mcp_health')({}, ackSink(acked));
  assert.equal(acked[0].success, false);
  assert.ok(acked[0].error.includes('Unauthorized'));
  assert.ok(socket.last('chat_error'));
});

test('không có ack callback -> fallback emit event riêng (style list_skills)', async () => {
  const deps = makeDeps();
  const socket = registerWith(deps);
  await socket.handlers.get('mcp_list_tools')({}, 'not-a-function');
  assert.equal(socket.last('mcp_tools_result').success, true);

  await socket.handlers.get('mcp_call_tool')({ name: 'demo_tool', args: {} }, undefined);
  assert.equal(socket.last('mcp_call_tool_result').success, true);

  await socket.handlers.get('mcp_health')({}, undefined);
  assert.equal(socket.last('mcp_health_result').success, true);
});

test('createMcpSubsystem: pair nối đúng chiều, tool lỗi bị skip, healthStore lấy từ module', async () => {
  const registered = [];
  const connected = [];

  class FakeRegistry {
    constructor(config) {
      this.config = config;
      this.tools = [];
    }
    registerTool(def) {
      if (def.name === 'bad name!') throw new Error('bad tool name');
      this.tools.push(def.name);
      registered.push(def.name);
    }
    async connect(transport) {
      connected.push(['server', transport]);
    }
    async close() {}
  }
  class FakeClient {
    constructor(name, config) {
      this.name = name;
      this.config = config;
      this.connected = false;
    }
    async connect() {
      this.connected = true;
      connected.push(['client', this.name]);
    }
    async refreshTools() {
      return [];
    }
    async callTool() {
      return { content: [], isError: false };
    }
    async close() {}
  }
  const logs = [];
  const fakeMcpModule = {
    MCP_VERSION: '9.9.9',
    createMCPServer: (config) => new FakeRegistry(config),
    createMCPClient: (name, config) => new FakeClient(name, config),
    createLinkedPair: () => [{ id: 'client-side' }, { id: 'server-side' }],
    McpHealthStore: class {
      constructor() {
        this.kind = 'fake-store';
      }
    },
  };

  const subsystem = await createMcpSubsystem({
    loadMcp: async () => fakeMcpModule,
    getHostTools: () => [
      { name: 'good_tool', description: 'g', inputSchema: { type: 'object' } },
      { name: 'bad name!', description: 'b', inputSchema: { type: 'object' } },
    ],
    log: (msg) => logs.push(msg),
  });

  // Cặp transport nối đúng chiều: client nhận chân đầu tiên, server nhận chân thứ hai.
  assert.equal(subsystem.client.name, 'ghita-sidecar-ui');
  assert.equal(subsystem.client.config.transport.id, 'client-side');
  assert.equal(subsystem.client.connected, true);
  assert.deepEqual(connected, [
    ['server', { id: 'server-side' }],
    ['client', 'ghita-sidecar-ui'],
  ]);

  // Tool lỗi chỉ bị skip, tool tốt vẫn vào registry.
  assert.deepEqual(registered, ['good_tool']);
  assert.ok(logs.some((msg) => msg.includes('skipped host tool')));
  assert.ok(logs.some((msg) => msg.includes('1/2 host tool(s) registered')));

  // healthStore tới từ module @ghita/mcp (inject), không phải tự chế.
  assert.equal(subsystem.healthStore.kind, 'fake-store');

  // version registry lấy từ MCP_VERSION của module.
  assert.equal(subsystem.registry.config.version, '9.9.9');
  assert.equal(subsystem.registry.config.name, 'ghita-sidecar');
});

test('createMcpSubsystem: module thiếu exports -> lỗi rõ ràng (không crash mơ hồ)', async () => {
  await assert.rejects(
    createMcpSubsystem({ loadMcp: async () => ({}) }),
    /missing expected exports/,
  );
});

// --- Review fixes 2026-11-09 ---

test('mcp_call_tool: tool treo -> timeout server-side trả lỗi (không giữ promise vĩnh viễn)', async () => {
  const socket = fakeSocket();
  const ackResults = [];
  const neverResolves = new Promise(() => {});
  const subsystem = fakeSubsystem({
    callTool: () => neverResolves,
  });
  const deps = makeDeps({ subsystem, callTimeoutMs: 50 });
  const register = createMcpHandlers(deps);
  register(socket);
  const handler = socket.handlers.get('mcp_call_tool');
  await handler({ name: 'demo_tool', args: {} }, (payload) => ackResults.push(payload));
  const ack = ackResults[0] ?? socket.last('mcp_call_tool_result');
  assert.equal(ack.success, false);
  assert.match(ack.error, /timed out after 50ms/);
  // markFailure được ghi để health phản ánh đúng nguyên nhân.
  assert.ok(subsystem.healthStore.calls.some((c) => c[0] === 'markFailure'));
});

test('respond: ack callback ném lỗi -> kết quả vẫn đi ra qua fallback event', async () => {
  const socket = fakeSocket();
  const subsystem = fakeSubsystem();
  const deps = makeDeps({ subsystem });
  const register = createMcpHandlers(deps);
  register(socket);
  const handler = socket.handlers.get('mcp_list_tools');
  await handler({}, () => {
    throw new Error('client vanished');
  });
  // Ack ném lỗi nhưng payload không mất: fallback event mang kết quả.
  const fallback = socket.last('mcp_tools_result');
  assert.ok(fallback, 'fallback event phải được emit khi ack throw');
  assert.equal(fallback.success, true);
  assert.ok(Array.isArray(fallback.tools));
});
