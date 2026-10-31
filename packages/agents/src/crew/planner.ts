// CrewPlanner (CrewAI pattern): an optional pre-flight LLM call that produces
// a short execution plan per task, prepended to each task's prompt. Planning
// is best-effort — a malformed model answer yields an empty plan, never a
// failed kickoff.

import { HumanMessage } from '../messages/message.js';
import type { BaseMessage } from '../messages/message.js';
import type { CrewAgentSpec, CrewPlanStep, CrewTask } from './types.js';

/** Simple text-in/text-out LLM seam for the planner. */
export type PlannerLLM = (prompt: string) => Promise<string>;

/**
 * Adapt the ReAct-style `llmCall` to the planner's text seam. The planner
 * never needs tools, so a bare single-message call is enough.
 */
export function llmCallToPlanner(
  llmCall: (messages: BaseMessage[]) => Promise<BaseMessage>,
): PlannerLLM {
  return async (prompt: string) => {
    const response = await llmCall([new HumanMessage(prompt)]);
    return response.getText();
  };
}

function extractJsonArray(text: string): unknown {
  const fenced = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/```\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function normalizePlanSteps(raw: unknown, validTaskIds: Set<string>): CrewPlanStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: CrewPlanStep[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const taskId = typeof record.taskId === 'string' ? record.taskId : typeof record.task_id === 'string' ? record.task_id : undefined;
    const plan = typeof record.plan === 'string' ? record.plan : undefined;
    if (!taskId || !plan || !validTaskIds.has(taskId)) continue;
    steps.push({ taskId, plan });
  }
  return steps;
}

export class CrewPlanner {
  constructor(private readonly llm: PlannerLLM) {}

  /**
   * Produce one plan step per task. Steps for unknown task IDs are dropped;
   * tasks without a plan run unplanned (their prompt simply has no plan block).
   */
  async plan(
    agents: CrewAgentSpec[],
    tasks: CrewTask[],
    inputs: Record<string, unknown>,
  ): Promise<CrewPlanStep[]> {
    if (tasks.length === 0) return [];
    const validTaskIds = new Set(tasks.map((t) => t.id));

    const crewDescription = agents
      .map((a) => `- ${a.name} (${a.role}): ${a.goal}`)
      .join('\n');
    const taskList = tasks
      .map((t) => {
        const agent = agents.find((a) => a.id === t.agentId);
        return [
          `- Task "${t.id}"${agent ? ` (assigned to ${agent.name})` : ''}:`,
          `  description: ${t.description}`,
          t.expectedOutput ? `  expected output: ${t.expectedOutput}` : undefined,
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n');

    const prompt = [
      'You are the planning stage of a multi-agent crew. Before the crew runs,',
      'produce a concrete execution plan for every task below.',
      '',
      '# Crew members',
      crewDescription,
      '',
      '# Tasks (in execution order)',
      taskList,
      ...(Object.keys(inputs).length > 0
        ? ['', '# Crew inputs', JSON.stringify(inputs, null, 2)]
        : []),
      '',
      'Respond ONLY with a JSON array like:',
      '[{"taskId": "<task id>", "plan": "<concise step-by-step plan for this task>"}]',
    ].join('\n');

    try {
      const answer = await this.llm(prompt);
      return normalizePlanSteps(extractJsonArray(answer), validTaskIds);
    } catch {
      return [];
    }
  }
}
