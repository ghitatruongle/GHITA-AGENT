// (H2) crew-handlers — nối socket -> engine mới (Crew + GraphExecutor).
//
// Trước H2: UI phát crew_run/workflow_run vào khoảng trống (sidecar không có
// handler) => nút Chạy crew trong app cài là CHẾT im lặng. Module này là
// cầu nối thiếu, deps-injected để test được bằng node --test.
//
// Contract UI (useCrewRun / useWorkflowRun):
//   crew_run {process, planning, agents, tasks, inputs, permissionMode}
//     -> crew_event {runId, event}  ·  crew_done {runId, status, output, error}
//     -> chat_error {message} khi từ chối
//   crew_cancel (không runId — cancel run đang chạy của socket này)
//   workflow_run {graph, inputs, permissionMode}
//     -> workflow_event {runId, event} · workflow_done {runId, status, outputs, error}
//     -> workflow_human_input_required {runId, ticket, nodeId, prompt}
//        UI trả lời: workflow_human_input_response {ticket, answer}
//   workflow_cancel

import { randomUUID } from 'node:crypto';

const MAX_TASKS = 50;
const MAX_AGENTS = 20;
const MAX_NODES = 100;

function crewRunId() {
  return 'crew_' + Date.now().toString(36) + '_' + randomUUID().slice(0, 8);
}

function workflowRunId() {
  return 'wf_' + Date.now().toString(36) + '_' + randomUUID().slice(0, 8);
}

/** Map BaseMessage[] (engine) -> chat format orchestrator.chat nhận. */
function mapMessagesToChat(messages) {
  return messages.map((msg) => {
    const role = msg.role;
    if (role === 'tool') {
      return { role: 'tool', toolCallId: msg.toolCallId, content: msg.getText() };
    }
    if (role === 'assistant') {
      const base = { role: 'assistant', content: msg.getText() };
      const tcs = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
      if (tcs.length > 0) {
        base.toolCalls = tcs.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments ?? {} }));
      }
      return base;
    }
    if (role === 'system') return { role: 'system', content: msg.getText() };
    return { role: 'user', content: msg.getText() };
  });
}

/**
 * llmCall cho Crew engine: BaseMessage[] -> orchestrator -> AIMessage.
 * Chịu cancel qua config.signal (race) — tương tự acquireRpm.
 */
function buildCrewLlmCall({ engine, orchestratorChat, provider, model, tools }) {
  const AIMessage = engine.AIMessage;
  const toolsForChat = (tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  return async (messages, config) => {
    const chatMessages = mapMessagesToChat(messages);
    const signal = config?.signal;
    const call = orchestratorChat(chatMessages, { provider, model, tools: toolsForChat });
    // KHÔNG early-return khi thiếu signal — orchestrator trả về raw object
    // {content, toolCalls, usage}; MỌI đường đều phải map thành AIMessage.
    // Cancel: race với signal (khi có); không signal thì gọi thẳng.
    const res =
      signal === undefined
        ? await call
        : await Promise.race([
            call,
            new Promise((_, reject) => {
              if (signal.aborted) {
                reject(new Error('Crew task was cancelled.'));
                return;
              }
              signal.addEventListener(
                'abort',
                () => reject(new Error('Crew task was cancelled.')),
                { once: true },
              );
            }),
          ]);
    const toolCalls = (res.toolCalls ?? []).map((tc) => ({
      ...tc,
      id: tc.id || 'call_' + randomUUID().slice(0, 10),
    }));
    return new AIMessage(res.content ?? '', {
      toolCalls,
      metadata: { usage: res.usage },
    });
  };
}

/**
 * Tạo bộ handler crew/workflow cho MỘT socket connection.
 * deps:
 *   loadEngine        () => Promise<@ghita/agents module>
 *   orchestratorChat  (chatMessages, {provider, model, tools}) => {content, toolCalls, usage}
 *   getAuthorizedClient (options?) => {device, isDesktop,...} | null (đã emit error)
 *   getWorkspaceRoot  () => string | undefined
 *   log               (msg) => void
 */
export function createCrewWorkflowHandlers(deps) {
  const { loadEngine, orchestratorChat, getAuthorizedClient, getWorkspaceRoot, log } = deps;

  return function register(socket) {
    let activeCrew = null; // { runId, controller }
    let activeWorkflow = null; // { runId, controller }
    const inputTickets = new Map(); // ticket -> resolve(answer)

    socket.on('crew_run', async (data) => {
      if (!getAuthorizedClient()) {
        socket.emit('chat_error', { message: 'Unauthorized: pair the device before running a crew.' });
        return;
      }
      if (activeCrew) {
        socket.emit('chat_error', { message: `Another crew run is already active (${activeCrew.runId}).` });
        return;
      }
      const runId = crewRunId();
      const controller = new AbortController();
      activeCrew = { runId, controller };

      const agentsSpecs = Array.isArray(data?.agents) ? data.agents.slice(0, MAX_AGENTS) : [];
      const tasksSpecs = Array.isArray(data?.tasks) ? data.tasks.slice(0, MAX_TASKS) : [];
      if (agentsSpecs.length === 0 || tasksSpecs.length === 0) {
        socket.emit('chat_error', { message: 'crew_run requires at least one agent and one task.' });
        activeCrew = null;
        return;
      }

      try {
        const engine = await loadEngine();
        const process_ = data?.process === 'hierarchical' ? 'hierarchical' : 'sequential';
        const permissionMode = data?.permissionMode === 'auto' ? 'auto' : 'custom';
        globalThis.agentPermissionMode = permissionMode;
        const llmCall = buildCrewLlmCall({
          engine,
          orchestratorChat,
          provider: typeof data?.provider === 'string' ? data.provider : undefined,
          model: typeof data?.model === 'string' ? data.model : undefined,
        });

        const crewConfig = {
          id: runId,
          process: process_,
          maxExecutionTime: typeof data?.maxExecutionTime === 'number' ? data.maxExecutionTime : 600_000,
          signal: controller.signal,
          onEvent: (event) => {
            try {
              socket.emit('crew_event', { runId, event });
            } catch {
              // listener hỏng không được phép làm chết run
            }
          },
        };
        if (data?.planning === true) {
          crewConfig.planning = true;
          crewConfig.planner = new engine.CrewPlanner({ llm: engine.llmCallToPlanner(llmCall) });
        }

        const crew = new engine.Crew(crewConfig);
        for (const a of agentsSpecs) {
          crew.addAgent({
            id: String(a?.id ?? '').slice(0, 100),
            name: String(a?.name ?? 'Member').slice(0, 100),
            role: String(a?.role ?? 'member').slice(0, 200),
            goal: String(a?.goal ?? '').slice(0, 2000),
            ...(typeof a?.backstory === 'string' && a.backstory.length > 0
              ? { backstory: String(a.backstory).slice(0, 4000) }
              : {}),
            ...(a?.allowDelegation === true ? { allowDelegation: true } : {}),
          });
        }
        for (const t of tasksSpecs) {
          crew.addTask({
            id: String(t?.id ?? '').slice(0, 100),
            description: String(t?.description ?? '').slice(0, 20_000),
            ...(typeof t?.expectedOutput === 'string' ? { expectedOutput: String(t.expectedOutput).slice(0, 4000) } : {}),
            ...(typeof t?.agentId === 'string' ? { agentId: String(t.agentId).slice(0, 100) } : {}),
            ...(Array.isArray(t?.context) ? { context: t.context.map((c) => String(c).slice(0, 100)) } : {}),
          });
        }

        log(`[crew] run ${runId} (${process_}, ${agentsSpecs.length} agents, ${tasksSpecs.length} tasks)`);
        // llmCall là lớp LLM; executor = ReAct executor bọc llmCall (đúng
        // contract CrewExecutionRequest của engine).
        const executor = engine.createReActCrewTaskExecutor({ llmCall });
        const result = await crew.kickoff({ inputs: data?.inputs ?? {}, executor });
        socket.emit('crew_done', {
          runId,
          status: result.status,
          output: result.output,
          ...(result.error !== undefined ? { error: result.error } : {}),
        });
        log(`[crew] run ${runId} -> ${result.status}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        socket.emit('chat_error', { message: 'Crew run failed to start: ' + message });
        log(`[crew] run ${runId} error: ${message}`);
      } finally {
        activeCrew = null;
      }
    });

    socket.on('crew_cancel', () => {
      if (activeCrew) {
        log(`[crew] cancel ${activeCrew.runId}`);
        activeCrew.controller.abort();
      }
    });

    socket.on('workflow_run', async (data) => {
      if (!getAuthorizedClient()) {
        socket.emit('chat_error', { message: 'Unauthorized: pair the device before running a workflow.' });
        return;
      }
      if (activeWorkflow) {
        socket.emit('chat_error', { message: `Another workflow run is already active (${activeWorkflow.runId}).` });
        return;
      }
      const graph = data?.graph;
      if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
        socket.emit('chat_error', { message: 'workflow_run requires a graph {nodes, links}.' });
        return;
      }
      const runId = workflowRunId();
      const controller = new AbortController();
      activeWorkflow = { runId, controller };

      try {
        const engine = await loadEngine();
        const registry = engine.createDefaultBlockRegistry();
        const store = await engine.GraphLibraryStore.open(
          (getWorkspaceRoot() ?? process.cwd()) + '/.ghita/graph-library',
        );
        // Persist graph (version tự tăng khi cùng draft version) — run sau
        // restart vẫn đọc lại được thư viện graph.
        try {
          await store.saveGraph({
            id: String(graph.id ?? runId).slice(0, 100),
            name: String(graph.name ?? 'workflow').slice(0, 200),
            version: Number.isFinite(graph.version) ? Number(graph.version) : 1,
            nodes: graph.nodes,
            links: graph.links,
          });
        } catch {
          // persist best-effort — chạy vẫn tiếp tục nếu đĩa lỗi
        }

        const llmCall = buildCrewLlmCall({
          engine,
          orchestratorChat,
          provider: typeof data?.provider === 'string' ? data.provider : undefined,
          model: typeof data?.model === 'string' ? data.model : undefined,
        });
        const executor = new engine.GraphExecutor(registry, {
          llmCall,
          onEvent: (event) => {
            try {
              socket.emit('workflow_event', { runId, event });
            } catch {
              // best-effort
            }
          },
          nodeTimeoutMs: typeof data?.nodeTimeoutMs === 'number' ? data.nodeTimeoutMs : 120_000,
          signal: controller.signal,
          requestHumanInput: (request) =>
            new Promise((resolve, reject) => {
              const ticket = 't_' + randomUUID().slice(0, 12);
              inputTickets.set(ticket, { resolve, reject });
              socket.emit('workflow_human_input_required', {
                runId,
                ticket,
                nodeId: request.nodeId,
                prompt: request.prompt,
              });
            }),
        });

        log(`[workflow] run ${runId} (${graph.name ?? graph.id})`);
        const result = await executor.execute(graph, { inputs: data?.inputs ?? {}, signal: controller.signal });
        socket.emit('workflow_done', {
          runId,
          status: result.status === 'completed' ? 'completed' : result.status,
          outputs: result.outputs,
          ...(result.error !== undefined ? { error: result.error } : {}),
        });
        log(`[workflow] run ${runId} -> ${result.status}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        socket.emit('workflow_done', { runId, status: 'failed', outputs: {}, error: message });
        log(`[workflow] run ${runId} error: ${message}`);
      } finally {
        for (const ticket of inputTickets.keys()) inputTickets.delete(ticket);
        activeWorkflow = null;
      }
    });

    socket.on('workflow_cancel', () => {
      if (activeWorkflow) {
        log(`[workflow] cancel ${activeWorkflow.runId}`);
        activeWorkflow.controller.abort();
        for (const [, pending] of inputTickets) pending.reject(new Error('Workflow was cancelled.'));
        inputTickets.clear();
      }
    });

    socket.on('workflow_human_input_response', ({ ticket, answer }) => {
      const pending = typeof ticket === 'string' ? inputTickets.get(ticket) : undefined;
      if (!pending) return;
      inputTickets.delete(ticket);
      pending.resolve(String(answer ?? ''));
    });
  };
}
