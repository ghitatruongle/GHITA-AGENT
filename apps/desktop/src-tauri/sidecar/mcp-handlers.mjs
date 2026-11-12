// =============================================================================
// Track 6.3 — mcp-handlers: nối socket -> MCP subsystem (packages/mcp).
// =============================================================================
// Nguồn pattern: apps/desktop/src-tauri/sidecar/crew-handlers.mjs (hotfix H2) —
// deps-injected factory `createXxxHandlers(deps)` trả về `register(socket)`,
// auth check ngang cấp qua getAuthorizedClient() (null = từ chối), lỗi emit
// `chat_error` thay vì crash sidecar, test được bằng node --test với socket
// stub (crew-handlers.test.mjs).
//
// CHANGELOG-mini (Track 6.3):
//   - Trước 6.3: UI phát mcp_list_tools / mcp_call_tool / mcp_health vào
//     khoảng trống — sidecar không có handler, phần MCP Tools của app cài
//     chết im lặng (đúng tình huống crew_run trước H2).
//   - 6.3: sidecar giữ một MCP server registry IN-PROCESS (GhitaMCPServer —
//     packages/mcp/src/server.ts, "minimal tool registry with deny-default
//     guard hooks") + một MCPClient nói với registry qua createLinkedPair()
//     (in-memory transport — "embedded pair mode" của inmemory.ts). UI list /
//     call tool qua socket, health báo theo McpHealthStore (health.ts).
//
// Contract UI (useMcp):
//   mcp_list_tools {}
//     -> ack {success, tools:[{name, description, inputSchema}]}
//        (client không truyền ack -> emit 'mcp_tools_result' cùng payload)
//   mcp_call_tool {name, args}
//     -> ack {success, name, result:{content:[{type:'text',text}], isError}}
//        (không ack -> emit 'mcp_call_tool_result')
//   mcp_health {}
//     -> ack {success, registry, registryReady, health, summary}
//        (không ack -> emit 'mcp_health_result'). Health probe KHÔNG bao giờ
//        fail handler: subsystem chết là một KẾT QUẢ 'degraded', đúng tinh
//        thần McpHealthStore ("biết là chết" khác "chưa biết").
//   Mọi từ chối auth / lỗi validate / lỗi subsystem cũng emit 'chat_error'
//   {message} — style crew-handlers, để UI chat panel nhận được lý do.
// =============================================================================

const MCP_REGISTRY_NAME = 'ghita-sidecar';
const MAX_TOOL_NAME_LENGTH = 200;
// Mirror cap của sync_api_config (1 MB) — args JSON lớn hơn bị từ chối trước
// khi chạm tới registry.
const MAX_ARGS_JSON_CHARS = 1_000_000;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:@-]+$/;
// Trần server-side cho một lần gọi tool. UI có timeout 60s phía client; nếu
// không có trần này ở sidecar, tool treo (index workspace khổng lồ...) giữ
// promise pending vĩnh viễn — gọi nhiều lần chất đống memory.
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/** Promise.race với timer — timer luôn clear để không giữ event loop. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isPlainJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Dựng MCP subsystem: GhitaMCPServer (registry) + MCPClient nối qua một cặp
 * in-memory transport + McpHealthStore.
 *
 * deps:
 *   loadMcp     () => Promise<@ghita/mcp module>   (lazy loader từ server.mjs)
 *   getHostTools () => ToolDefinition[]            (host tools đưa vào registry;
 *                lỗi schema của MỘT tool chỉ làm skip tool đó, không kill subsystem)
 *   log         (msg) => void
 *
 * Trả về: { registry, client, healthStore }
 */
export async function createMcpSubsystem({ loadMcp, getHostTools, log = () => {} } = {}) {
  const mcp = await loadMcp();
  if (
    !mcp ||
    typeof mcp.createMCPServer !== 'function' ||
    typeof mcp.createMCPClient !== 'function' ||
    typeof mcp.createLinkedPair !== 'function' ||
    typeof mcp.McpHealthStore !== 'function'
  ) {
    throw new Error(
      '@ghita/mcp module is missing expected exports (createMCPServer / createMCPClient / createLinkedPair / McpHealthStore).',
    );
  }

  const hostTools = typeof getHostTools === 'function' ? getHostTools() : [];
  const registry = mcp.createMCPServer({
    name: MCP_REGISTRY_NAME,
    version: typeof mcp.MCP_VERSION === 'string' ? mcp.MCP_VERSION : '1.1.0',
  });
  // createMCPServer(config.tools) không try/catch từng tool — một tool sai
  // schema/name sẽ giết cả subsystem. Register thủ công từng cái để chỉ skip
  // tool lỗi.
  let registeredCount = 0;
  for (const tool of Array.isArray(hostTools) ? hostTools : []) {
    try {
      registry.registerTool(tool);
      registeredCount++;
    } catch (err) {
      log(`[mcp] skipped host tool "${tool?.name ?? 'unnamed'}": ${errorText(err)}`);
    }
  }

  const [clientTransport, serverTransport] = mcp.createLinkedPair();
  const client = mcp.createMCPClient(`${MCP_REGISTRY_NAME}-ui`, {
    kind: 'in-memory',
    transport: clientTransport,
  });
  await registry.connect(serverTransport);
  await client.connect();
  const healthStore = new mcp.McpHealthStore();

  log(`[mcp] subsystem ready (${registeredCount}/${hostTools.length} host tool(s) registered)`);
  return { registry, client, healthStore };
}

/**
 * Tạo bộ handler mcp_* cho MỘT socket connection (mirror createCrewWorkflowHandlers).
 * deps:
 *   getMcpSubsystem    () => Promise<{registry, client, healthStore}>  (singleton ở server.mjs)
 *   getAuthorizedClient(options?) => client | null  (đã emit error event khi null)
 *   log                (msg) => void
 */
export function createMcpHandlers(deps) {
  const { getMcpSubsystem, getAuthorizedClient, log = () => {}, callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS } = deps ?? {};

  return function register(socket) {
    const MCP_DENY_MESSAGE = 'Unauthorized: pair the device before using MCP tools.';

    /** Trả kết quả qua ack nếu client truyền callback, ngược lại emit event
     * riêng (style list_skills của server.mjs). Ack hỏng vẫn emit fallback —
     * không làm rơi kết quả, không crash sidecar. */
    const respond = (ack, fallbackEvent, payload) => {
      if (typeof ack === 'function') {
        try {
          ack(payload);
        } catch {
          // ack callback ném lỗi (client biến mất giữa chừng...) — fallback
          // đảm bảo kết quả vẫn có đường ra.
          socket.emit(fallbackEvent, payload);
        }
      } else {
        socket.emit(fallbackEvent, payload);
      }
    };

    const deny = (ack, fallbackEvent) => {
      socket.emit('chat_error', { message: MCP_DENY_MESSAGE });
      respond(ack, fallbackEvent, { success: false, error: MCP_DENY_MESSAGE });
    };

    socket.on('mcp_list_tools', async (data, ack) => {
      if (!getAuthorizedClient()) {
        deny(ack, 'mcp_tools_result');
        return;
      }
      try {
        const subsystem = await getMcpSubsystem();
        const started = Date.now();
        const tools = await subsystem.client.refreshTools();
        const toolList = Array.isArray(tools) ? tools : [];
        subsystem.healthStore?.record(MCP_REGISTRY_NAME, {
          state: 'healthy',
          latencyMs: Date.now() - started,
          toolCount: toolList.length,
        });
        log(`[mcp] list_tools -> ${toolList.length} tool(s)`);
        respond(ack, 'mcp_tools_result', { success: true, tools: toolList });
      } catch (err) {
        const message = errorText(err);
        log(`[mcp] list_tools error: ${message}`);
        socket.emit('chat_error', { message: `MCP list tools failed: ${message}` });
        respond(ack, 'mcp_tools_result', { success: false, error: message });
      }
    });

    socket.on('mcp_call_tool', async (data, ack) => {
      if (!getAuthorizedClient()) {
        deny(ack, 'mcp_call_tool_result');
        return;
      }

      const name = typeof data?.name === 'string' ? data.name.trim() : '';
      if (
        !name ||
        name.length > MAX_TOOL_NAME_LENGTH ||
        !TOOL_NAME_PATTERN.test(name)
      ) {
        const message =
          `Invalid MCP tool name (allowed: letters, digits, "_", ".", ":", "@", "-" — max ${MAX_TOOL_NAME_LENGTH} chars).`;
        socket.emit('chat_error', { message });
        respond(ack, 'mcp_call_tool_result', { success: false, name, error: message });
        return;
      }

      const rawArgs = data?.args ?? {};
      if (!isPlainJsonObject(rawArgs)) {
        const message =
          'MCP tool arguments must be a JSON object (got ' +
          (Array.isArray(rawArgs) ? 'array' : typeof rawArgs) +
          ').';
        socket.emit('chat_error', { message });
        respond(ack, 'mcp_call_tool_result', { success: false, name, error: message });
        return;
      }

      let argsJson;
      try {
        argsJson = JSON.stringify(rawArgs);
      } catch {
        const message = 'MCP tool arguments are not JSON-serializable.';
        socket.emit('chat_error', { message });
        respond(ack, 'mcp_call_tool_result', { success: false, name, error: message });
        return;
      }
      if (argsJson.length > MAX_ARGS_JSON_CHARS) {
        const message = `MCP tool arguments too large (${argsJson.length} chars, max ${MAX_ARGS_JSON_CHARS}).`;
        socket.emit('chat_error', { message });
        respond(ack, 'mcp_call_tool_result', { success: false, name, error: message });
        return;
      }

      let subsystem = null;
      try {
        subsystem = await getMcpSubsystem();
        const started = Date.now();
        // Trần thời gian server-side: tool treo phải trả lỗi để handler không
        // giữ promise pending vĩnh viễn (UI tự có timeout 60s phía client).
        const result = await withTimeout(
          subsystem.client.callTool(name, rawArgs),
          callTimeoutMs,
          `MCP tool "${name}"`,
        );
        subsystem.healthStore?.record(MCP_REGISTRY_NAME, {
          state: 'healthy',
          latencyMs: Date.now() - started,
        });
        log(`[mcp] call_tool ${name} -> isError=${result?.isError === true}`);
        respond(ack, 'mcp_call_tool_result', {
          success: true,
          name,
          result: {
            content: Array.isArray(result?.content) ? result.content : [],
            isError: result?.isError === true,
          },
        });
      } catch (err) {
        const message = errorText(err);
        log(`[mcp] call_tool ${name} error: ${message}`);
        // subsystem null = getMcpSubsystem tự lỗi (loadMcp/pair/connect) —
        // markFailure chỉ khi healthStore tồn tại.
        try {
          subsystem?.healthStore?.markFailure(MCP_REGISTRY_NAME, message);
        } catch {
          // health bookkeeping không được phép che mất lỗi gốc
        }
        socket.emit('chat_error', { message: `MCP tool "${name}" failed: ${message}` });
        respond(ack, 'mcp_call_tool_result', { success: false, name, error: message });
      }
    });

    socket.on('mcp_health', async (data, ack) => {
      if (!getAuthorizedClient()) {
        deny(ack, 'mcp_health_result');
        return;
      }
      try {
        const subsystem = await getMcpSubsystem();
        const started = Date.now();
        const tools = await subsystem.client.refreshTools();
        const latencyMs = Date.now() - started;
        subsystem.healthStore?.record(MCP_REGISTRY_NAME, {
          state: 'healthy',
          latencyMs,
          toolCount: Array.isArray(tools) ? tools.length : 0,
        });
        respond(ack, 'mcp_health_result', {
          success: true,
          registry: MCP_REGISTRY_NAME,
          registryReady: true,
          health:
            subsystem.healthStore?.get(MCP_REGISTRY_NAME) ?? {
              state: 'healthy',
              checkedAt: Date.now(),
              latencyMs,
            },
          summary: subsystem.healthStore?.summary?.() ?? null,
        });
      } catch (err) {
        const message = errorText(err);
        log(`[mcp] health probe degraded: ${message}`);
        // Probe thất bại vẫn là một health result hợp lệ — không emit
        // chat_error, không fail handler.
        respond(ack, 'mcp_health_result', {
          success: true,
          registry: MCP_REGISTRY_NAME,
          registryReady: false,
          health: { state: 'degraded', checkedAt: Date.now(), error: message },
          summary: null,
        });
      }
    });
  };
}

// Tên theo kế hoạch v0.0.1 Track 6.3 (registerMcpHandlers) và tên theo pattern
// crew-handlers (createMcpHandlers — mirror createCrewWorkflowHandlers) là
// CÙNG MỘT factory.
export { createMcpHandlers as registerMcpHandlers };
