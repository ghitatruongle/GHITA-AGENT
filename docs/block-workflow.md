# Block Workflow Engine (AutoGPT-inspired graph execution)

> Attribution: the design is a **clean-room TypeScript port of AutoGPT's
> architecture** (https://github.com/AutoGPT/AutoGPT; `classic/` MIT,
> `autogpt_platform/` PolyForm Shield 1.0 — snapshot
> `refer_project/ai-core/autogpt` @ commit `e2316d0`, 2026-10-27). Only
> language-agnostic design ideas were ported; no Python code was copied and
> Ghita Agent is not a competing hosted service. `refer_project/` is
> research-only per `docs/plans/2026-08-30-v1.2.0-master-plan.md`.

## Where it lives

| Path | Contents |
|---|---|
| `packages/agents/src/blocks/types.ts` | `BlockDefinition` — stable UUID, typed JSON-Schema input pins, **per-output-pin schemas with a mandatory string `error` pin**, `run()` as an async generator yielding `(outputName, value)` (stream fan-out), self-describing `fixture` |
| `packages/agents/src/blocks/registry.ts` | `BlockRegistry` with load-time invariants (unique ids/names, `error: str` pin) + fixture smoke-testing (`runFixtureTests`) |
| `packages/agents/src/blocks/builtins.ts` | built-in library: `input`, `output` (graph boundary), `llm_text`, `llm_structured`, `condition`, `step_through_items` (fan-out), `delay`, `tool`, `human_in_the_loop`, `sub_graph`, `code_sandbox` |
| `packages/agents/src/autogpt/graph.ts` | `GraphNode`/`GraphLink`/`GraphDefinition`, graph validation + computed boundary schemas, `ExecutionStatus` + `VALID_STATUS_TRANSITIONS`, trigger taxonomy (`manual/api/schedule/webhook/subgraph`) |
| `packages/agents/src/autogpt/executor.ts` | `GraphExecutor` — the data-driven scheduler |
| `packages/agents/src/autogpt/goal-decomposer.ts` | `decomposeGoalWithLLM` (goal → verified DAG) + `decomposedGoalToGraph` (DAG → runnable graph) |

`DAGDecomposer` (older data-structure stub) remains exported and is now used
as the cycle verifier inside goal decomposition.

## The core engine idea (what makes it AutoGPT-shaped)

Scheduling is **data-driven, not topological**: a node runs the moment all of
its required input pins hold data.

1. Seed `input` nodes with `execute({ inputs })` values.
2. A node whose required pins are filled is enqueued; its block's
   async-generator `run` streams emissions.
3. Each emission is delivered along every matching link
   (`upsert_execution_input` semantics). Multiple string deliveries to one
   pin are joined; other pins overwrite. Sinks that become fully fed are
   enqueued — one output emission can trigger a downstream run each time
   (natural fan-out via `step_through_items`).
4. Nodes still missing data park in `waiting`. When the queue drains, the run
   is `completed` if it produced at least one output value (untaken
   conditional branches legitimately leave nodes waiting — AutoGPT
   COMPLETED semantics), otherwise `incomplete`: the graph is runnable but
   starved of seed data and can be resumed later with more inputs.
5. A block yielding its `error` pin fails the run fast; external abort
   returns `terminated`; per-node timeouts abort and fail.
6. Cycles (only reachable through `isStatic` links) are bounded by
   `maxRunsPerNode` (default 5).
7. `sub_graph` blocks run other graphs as nodes (`executeGraph` seam) —
   "agent within a workflow" recursion, as on the AutoGPT platform.

Not ported (this cycle): RabbitMQ/Redis deployment topology, APScheduler
persistence, webhook provisioning, OAuth credential store + leases, billing.
The trigger taxonomy and status-transition table are kept as the substrate
those features will attach to.

## Usage

```ts
import { createDefaultBlockRegistry, GraphExecutor, validateGraph } from '@ghita/agents';

const registry = createDefaultBlockRegistry();
const graph = { id: 'g1', name: 'demo', version: 1, nodes: [...], links: [...] };
const check = validateGraph(graph, registry);
if (!check.ok) throw new Error(check.errors.join('; '));

const executor = new GraphExecutor(registry, {
  llmCall,                       // ai-engine Orchestrator
  onEvent: (event) => stream(event), // per-node status for the UI
});
const result = await executor.execute(graph, { inputs: { in: 'goal' }, trigger: 'manual' });
// result.outputs, result.nodes (per-node status), result.status
```

## Runtime wiring

Sidecar socket handlers `workflow_run` / `workflow_cancel`
(`apps/desktop/src-tauri/sidecar/server.mjs`) validate the graph, reuse the
shared workspace toolset + LLM call, bridge `human_in_the_loop` blocks to a
`workflow_human_input_required` / `workflow_human_input_response` round trip
(180s timeout), and stream `workflow_event` / `workflow_done`. The Workflow
view's visual canvas compiles to a `GraphDefinition` and colorizes nodes from
the event stream (`useWorkflowRun`). Command/tool nodes respect the same
diff-review and command approval gates as `agent_run` (permission mode
`custom`); approvals appear in the chat panel.

Tests: `packages/agents/tests/block-engine.test.ts`.
