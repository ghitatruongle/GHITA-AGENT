# Crew Orchestration (CrewAI-inspired multi-agent engine)

> Attribution: the design is a **clean-room TypeScript port of CrewAI's
> architecture** (https://github.com/crewAIInc/crewAI, MIT License,
> snapshot `refer_project/ai-framework/crewai` @ commit `3adab28`, 2026-10-27).
> No Python source was copied; concepts were re-expressed with the existing
> Ghita Agent primitives. `refer_project/` is research-only per
> `docs/plans/2026-08-30-v1.2.0-master-plan.md`.

## Where it lives

`packages/agents/src/crew/` — exported from `@ghita/agents`:

| File | Contents |
|---|---|
| `types.ts` | `CrewAgentSpec` (role/goal/backstory identity triplet), `CrewTask` (description + expectedOutput + context edges + guardrail), `CrewProcess`, replayable `CrewEvent`, `CrewResult`, `CrewTaskExecutor`, `CrewMemoryBridge` |
| `executor.ts` | `createReActCrewTaskExecutor` — default executor compiling the identity triplet into a ReAct system prompt and running a fresh `ReActAgent` per turn |
| `delegation.ts` | `delegate_work` / `ask_question` tools (delegation-as-tools) |
| `planner.ts` | `CrewPlanner` — best-effort pre-flight plan per task; `llmCallToPlanner` adapter |
| `memory.ts` | `createAgentMemoryBridge` — adapts `@ghita/memory`'s `AgentMemory` |
| `crew.ts` | `Crew` — sequential & hierarchical processes |

`CrewAIOrchestrator` (the older planning-only stub) remains exported and is
superseded by `Crew`; its role-matching idea lives on in `Crew`'s task→agent
resolution (exact id first, then role, then round-robin).

## What was ported (and what was not)

Ported from CrewAI's architecture:

- **Identity triplet** → system prompt (`role`, `goal`, `backstory`).
- **Context-linked tasks**: `task.context` lists upstream task ids whose
  outputs feed the prompt; default = all previous outputs (CrewAI semantics).
- **Two processes over one loop**: `sequential` (ordered tasks) and
  `hierarchical` (a manager solves each task by delegating through tools).
- **Delegation-as-tools**: `delegate_work`/`ask_question` are ordinary ReAct
  tools that run the target member's full loop inline; members never receive
  delegation tools, which keeps recursion depth fixed (CrewAI runs them
  inline as well).
- **Best-effort planning**: one LLM call producing a typed plan per task,
  prepended to prompts; malformed answers degrade to "no plan", never a
  failed kickoff.
- **Guardrails with retry**: per-task output validation with a bounded retry
  loop that feeds the rejection reason back to the member.
- **Shared crew memory**: recall before each task, remember after (via
  `@ghita/memory`).
- **Replayable events**: `crew_start → task_start → task_complete /
  task_failed / delegation / task_guardrail_retry → crew_complete`, consumed
  by the desktop UI (`useCrewRun`).

Not ported (deliberate, for this cycle): Python decorators/metaclasses,
pydantic output contracts (JSON Schema strings are used instead), LiteLLM
routing (replaced by ai-engine's `Orchestrator`), async task parallelism
(sequential dispatch only — see TODO in `crew.ts`), training/replay CLI.

## Usage

```ts
import { Crew, createReActCrewTaskExecutor } from '@ghita/agents';

const executor = createReActCrewTaskExecutor({ llmCall }); // llmCall from ai-engine Orchestrator
const crew = new Crew({ process: 'hierarchical', planning: true, planner, onEvent })
  .addAgent({ id: 'coder', name: 'Grace', role: 'coder', goal: 'Write correct code.' })
  .addAgent({ id: 'reviewer', name: 'Ada', role: 'reviewer', goal: 'Review for defects.' })
  .addTask({ id: 't1', description: 'Build {feature}.', agentId: 'coder' })
  .addTask({ id: 't2', description: 'Review the result.', agentId: 'reviewer' });

const result = await crew.kickoff({ executor, inputs: { feature: 'login page' } });
// result.output = last task's output; result.taskOutputs = per-task records
```

`{key}` placeholders in task descriptions are interpolated from
`kickoff({ inputs })`. Cancellation: pass `signal` in the `Crew` config; the
run fails with "Crew run was cancelled." keeping completed task outputs.

## Runtime wiring

The desktop sidecar exposes `crew_run` / `crew_cancel` socket handlers
(`apps/desktop/src-tauri/sidecar/server.mjs`) that assemble the same
workspace toolset as `agent_run` (diff-review gate, code-graph, memory,
skills), apply the `PolicyEngine` deny-default guard, and stream `crew_event`
/ `crew_done` to the UI. The Agents view renders a crew runner
(`components/crew/CrewRunner.tsx`) on top of `useCrewRun`.

Tests: `packages/agents/tests/crew-engine.test.ts`. Headless example:
`examples/crew-workflow/run.mjs`.
