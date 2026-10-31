// Goal decomposition (AutoGPT-style): turn a natural-language goal into a
// dependency-ordered task DAG with one LLM call, optionally materialized as
// a block GraphDefinition of chained `llm_text` nodes.

import type { DAGTaskNode } from './dag-decomposer.js';
import type { GraphDefinition, GraphLink, GraphNode } from './graph.js';

/** Text-in/text-out LLM seam (same as CrewPlanner's). */
export type DecomposerLLM = (prompt: string) => Promise<string>;

export interface DecomposedGoal {
  title: string;
  nodes: DAGTaskNode[];
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/```\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Throws with a readable message when the LLM answer cannot be trusted. */
export async function decomposeGoalWithLLM(
  goal: string,
  llm: DecomposerLLM,
): Promise<DecomposedGoal> {
  const prompt = [
    'Decompose the following goal into a minimal set of concrete tasks with dependencies.',
    '',
    `# Goal`,
    goal,
    '',
    'Rules:',
    '- 2 to 8 tasks, each independently executable by an AI agent.',
    '- `id` is a short slug; `dependencies` lists ids that must finish first.',
    '- No cycles; the graph must be a DAG.',
    '',
    'Respond ONLY with JSON like:',
    '{"title": "<short goal title>", "tasks": [{"id": "slug", "title": "...", "description": "...", "dependencies": ["other-slug"]}]}',
  ].join('\n');

  const answer = await llm(prompt);
  const parsed = extractJson(answer) as
    | { title?: unknown; tasks?: unknown }
    | undefined;
  const tasks = Array.isArray(parsed?.tasks) ? (parsed?.tasks as unknown[]) : [];
  if (tasks.length === 0) {
    throw new Error('Goal decomposition failed: the LLM response contained no tasks.');
  }

  const tasksById = new Map<string, Record<string, unknown>>();
  for (const raw of tasks) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'] : undefined;
    // Collect ALL ids first so forward references stay valid; cycles are
    // rejected afterwards by the DAG verifier below.
    if (id && !tasksById.has(id)) tasksById.set(id, record);
  }
  if (tasksById.size === 0) {
    throw new Error('Goal decomposition failed: no valid tasks in the LLM response.');
  }

  const nodes: DAGTaskNode[] = [...tasksById.entries()].map(([id, record]) => ({
    id,
    title: typeof record['title'] === 'string' ? record['title'] : id,
    description: typeof record['description'] === 'string' ? record['description'] : '',
    dependencies: Array.isArray(record['dependencies'])
      ? (record['dependencies'] as unknown[]).filter(
          (dep): dep is string => typeof dep === 'string' && tasksById.has(dep),
        )
      : [],
    status: 'pending',
  }));

  // Reject cycles (including a cycle hidden behind a healthy root task):
  // repeatedly complete tasks whose dependencies are done; anything left
  // over is unreachable, i.e. cyclic.
  assertAcyclic(nodes);

  return {
    title: typeof parsed?.title === 'string' && parsed.title ? parsed.title : goal.slice(0, 80),
    nodes,
  };
}

/** Throws when the dependency graph contains a cycle (Kahn's algorithm). */
function assertAcyclic(nodes: DAGTaskNode[]): void {
  const remaining = new Map(nodes.map((n) => [n.id, n.dependencies.slice()]));
  const done = new Set<string>();
  let progress = true;
  while (remaining.size > 0 && progress) {
    progress = false;
    for (const [id, deps] of remaining) {
      if (deps.every((dep) => done.has(dep))) {
        done.add(id);
        remaining.delete(id);
        progress = true;
      }
    }
  }
  if (remaining.size > 0) {
    throw new Error(
      `Goal decomposition failed: the task graph contains a cycle involving: ${[...remaining.keys()].join(', ')}.`,
    );
  }
}

/** Stable topological order (dependencies before dependents). */
function topologicallySort(nodes: DAGTaskNode[]): DAGTaskNode[] {
  const sorted: DAGTaskNode[] = [];
  const done = new Set<string>();
  const pending = [...nodes];
  while (pending.length > 0) {
    const idx = pending.findIndex((n) => n.dependencies.every((dep) => done.has(dep)));
    if (idx === -1) return nodes; // cyclic — rejected by assertAcyclic first
    const node = pending.splice(idx, 1)[0];
    if (!node) return nodes; // unreachable: idx came from findIndex over pending
    sorted.push(node);
    done.add(node.id);
  }
  return sorted;
}

/**
 * Materialize a decomposed DAG as a runnable block graph: the goal enters
 * through an `input` node, each task becomes an `llm_text` node (dependency
 * outputs delivered into its `context` pin), a summarizer merges all task
 * outputs, and an `output` node exposes the final result.
 */
export function decomposedGoalToGraph(
  decomposition: DecomposedGoal,
  graphId: string,
): GraphDefinition {
  // The executor runs its initial ready queue in nodes-array order and every
  // task's required `prompt` pin is satisfied by its default, so an unsorted
  // array would let a dependent execute before its dependency. Topo-sort so
  // array order == dependency order.
  const orderedTasks = topologicallySort(decomposition.nodes);
  const nodes: GraphNode[] = [
    {
      id: 'goal_input',
      blockName: 'input',
      inputDefault: { value: decomposition.title },
      metadata: { role: 'goal' },
    },
    ...orderedTasks.map((task) => ({
      id: `task_${task.id}`,
      blockName: 'llm_text',
      inputDefault: {
        prompt: `${task.title}\n\n${task.description}`,
        system: 'You are one specialist step in a larger plan. Complete exactly your step.',
      },
      metadata: { taskId: task.id },
    })),
    {
      id: 'final_output',
      blockName: 'llm_text',
      inputDefault: {
        prompt:
          'Summarize the completed plan below for the user: what was produced, key results, and any remaining risks.',
        system: 'You are the reporting step of a completed plan.',
      },
      metadata: { taskId: '__final__' },
    },
    { id: 'result', blockName: 'output', metadata: { role: 'result' } },
  ];

  const links: GraphLink[] = [];
  for (const task of decomposition.nodes) {
    // Every task's output flows to the summarizer's context (string
    // deliveries to one pin are joined by the executor).
    links.push({
      source: `task_${task.id}`,
      sourceOutput: 'output',
      sink: 'final_output',
      sinkInput: 'context',
    });
    // Direct dependency outputs flow into the task's own context pin.
    for (const depId of task.dependencies) {
      links.push({
        source: `task_${depId}`,
        sourceOutput: 'output',
        sink: `task_${task.id}`,
        sinkInput: 'context',
      });
    }
    // Root tasks receive the goal itself as their starting context.
    if (task.dependencies.length === 0) {
      links.push({
        source: 'goal_input',
        sourceOutput: 'output',
        sink: `task_${task.id}`,
        sinkInput: 'context',
      });
    }
  }
  links.push({ source: 'final_output', sourceOutput: 'output', sink: 'result', sinkInput: 'value' });

  return {
    id: graphId,
    name: decomposition.title,
    version: 1,
    nodes,
    links,
  };
}
