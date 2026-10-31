// Delegation-as-tools (CrewAI hierarchical pattern): the manager (or any
// member with allowDelegation) involves crewmates through ordinary ReAct
// tools. Each delegation runs the target member's full agent loop inline and
// returns its answer as the tool observation.

import type { ReActTool } from '../react/types.js';
import type { CrewAgentSpec, CrewEvent } from './types.js';

export interface DelegationToolInput {
  coworker: string;
  task: string;
  context?: string;
}

const delegationParams = {
  type: 'object',
  properties: {
    coworker: {
      type: 'string',
      description: 'Name or role of the crewmate to involve.',
    },
    task: {
      type: 'string',
      description: 'The task or question for the crewmate.',
    },
    context: {
      type: 'string',
      description: 'Background the crewmate needs (previous outputs, constraints).',
    },
  },
  required: ['coworker', 'task'],
} as const;

export interface CreateDelegationToolsInput {
  members: CrewAgentSpec[];
  /** Runs a crewmate's turn (the same executor the crew itself uses). */
  executeMemberTask: (agent: CrewAgentSpec, prompt: string) => Promise<string>;
  /** Current actor — delegating to yourself is rejected. */
  currentAgent?: CrewAgentSpec;
  /** Fired on every accepted delegation so the UI can stream it. */
  onDelegation?: (event: CrewEvent) => void;
  /** Max delegations accepted by these tools before they start refusing. */
  maxDelegations?: number;
  signal?: AbortSignal;
}

export interface DelegationToolsResult {
  tools: ReActTool[];
  /** Number of delegations actually accepted (for run metadata). */
  accepted: () => number;
}

function findCrewmate(
  members: CrewAgentSpec[],
  query: string,
): CrewAgentSpec | undefined {
  const needle = query.trim().toLowerCase();
  return (
    members.find((m) => m.name.toLowerCase() === needle) ??
    members.find((m) => m.id.toLowerCase() === needle) ??
    members.find((m) => m.role.toLowerCase() === needle)
  );
}

function roster(members: CrewAgentSpec[]): string {
  return members.map((m) => `- ${m.name} (${m.role})`).join('\n');
}

/**
 * Create the `delegate_work` and `ask_question` tools for one task execution.
 * Errors are returned as observation strings (never thrown) so the calling
 * ReAct loop can read the reason and self-correct.
 */
export function createDelegationTools(
  input: CreateDelegationToolsInput,
): DelegationToolsResult {
  const {
    members,
    executeMemberTask,
    currentAgent,
    onDelegation,
    maxDelegations = 8,
    signal,
  } = input;
  let used = 0;

  const runDelegation = async (
    kind: 'work' | 'question',
    raw: Record<string, unknown>,
  ): Promise<string> => {
    const coworker = typeof raw.coworker === 'string' ? raw.coworker : '';
    const task = typeof raw.task === 'string' ? raw.task : '';
    const context = typeof raw.context === 'string' ? raw.context : undefined;

    if (!coworker || !task) {
      return 'Error: both "coworker" and "task" are required.';
    }
    if (used >= maxDelegations) {
      return `Error: delegation limit (${maxDelegations}) reached for this task. Produce your final answer with what you have.`;
    }
    const target = findCrewmate(members, coworker);
    if (!target) {
      return `Error: no crewmate matches "${coworker}". Available crewmates:\n${roster(members)}`;
    }
    if (currentAgent && target.id === currentAgent.id) {
      return 'Error: you cannot delegate to yourself. Complete the work or ask a different crewmate.';
    }
    used += 1;
    onDelegation?.({
      type: 'delegation',
      fromAgentId: currentAgent?.id,
      toAgentId: target.id,
      kind,
      timestamp: Date.now(),
    });

    const header =
      kind === 'work'
        ? `Your teammate ${currentAgent?.name ?? 'the manager'} delegated the following task to you.`
        : `Your teammate ${currentAgent?.name ?? 'the manager'} asks you the following question.`;
    const prompt = [
      header,
      '',
      `# ${kind === 'work' ? 'Task' : 'Question'}`,
      task,
      ...(context ? ['', '# Context', context] : []),
    ].join('\n');

    try {
      return await executeMemberTask(target, prompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error: ${target.name} failed to respond: ${message}`;
    }
  };

  const tools: ReActTool[] = [
    {
      name: 'delegate_work',
      description:
        'Delegate a task to a specific crewmate. They run the task with their own tools and return the result.',
      parameters: delegationParams,
      execute: (raw) => {
        if (signal?.aborted) return Promise.resolve('Error: crew run was cancelled.');
        return runDelegation('work', raw);
      },
    },
    {
      name: 'ask_question',
      description:
        'Ask a crewmate a question or request guidance. They answer with their expertise.',
      parameters: delegationParams,
      execute: (raw) => {
        if (signal?.aborted) return Promise.resolve('Error: crew run was cancelled.');
        return runDelegation('question', raw);
      },
    },
  ];

  return { tools, accepted: () => used };
}
