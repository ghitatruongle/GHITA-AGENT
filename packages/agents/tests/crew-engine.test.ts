import { describe, expect, it, vi } from 'vitest';
import { AIMessage } from '../src/messages/message.js';
import { Crew } from '../src/crew/crew.js';
import { CrewPlanner } from '../src/crew/planner.js';
import {
  createReActCrewTaskExecutor,
  crewAgentSystemPrompt,
} from '../src/crew/executor.js';
import { createDelegationTools } from '../src/crew/delegation.js';
import type {
  CrewAgentSpec,
  CrewEvent,
  CrewExecutionRequest,
  CrewTaskExecutor,
} from '../src/crew/types.js';

const coder: CrewAgentSpec = {
  id: 'a_coder',
  name: 'Grace',
  role: 'coder',
  goal: 'Write correct code.',
  backstory: 'A senior engineer.',
};
const reviewer: CrewAgentSpec = {
  id: 'a_reviewer',
  name: 'Ada',
  role: 'reviewer',
  goal: 'Review code for defects.',
};

interface RecordedCall {
  agent: CrewAgentSpec;
  prompt: string;
  toolNames: string[];
}

function recordingExecutor(
  responder?: (req: CrewExecutionRequest) => string | Promise<string>,
): { executor: CrewTaskExecutor; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const executor: CrewTaskExecutor = async (req) => {
    calls.push({
      agent: req.agent,
      prompt: req.prompt,
      toolNames: req.tools.map((t) => t.name),
    });
    return responder ? await responder(req) : `output-of-${req.taskId}-by-${req.agent.name}`;
  };
  return { executor, calls };
}

function collectEvents(): CrewEvent[] {
  const events: CrewEvent[] = [];
  return events;
}

describe('Crew sequential process', () => {
  it('treats an empty context array as the default (all prior outputs)', async () => {
    const { executor, calls } = recordingExecutor();
    const crew = new Crew()
      .addAgent(coder)
      .addAgent(reviewer)
      .addTask({ id: 't1', description: 'One', agentId: 'a_coder' })
      .addTask({
        id: 't2',
        description: 'Two',
        agentId: 'a_reviewer',
        // UI-only runs ship `context: []` — it must NOT act as an explicit
        // empty allow-list or the reviewer would run blind.
        context: [],
      });

    await crew.kickoff({ executor });

    expect(calls[1]?.prompt).toContain('output-of-t1-by-Grace');
  });

  it('recalls shared memory into the task prompt', async () => {
    const recalled: string[] = [];
    const memory = {
      recall: (query: string) => {
        recalled.push(query);
        return 'Remembered: prefers TypeScript.';
      },
      remember: vi.fn(),
    };
    const { executor, calls } = recordingExecutor();
    const crew = new Crew({ memory })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'Use the stack I like.', agentId: 'a_coder' });

    const result = await crew.kickoff({ executor });

    expect(result.status).toBe('completed');
    expect(recalled).toEqual(['Use the stack I like.']);
    expect(calls[0]?.prompt).toContain('# Workspace memory');
    expect(calls[0]?.prompt).toContain('prefers TypeScript.');
    // Outputs are still written back.
    expect(memory.remember).toHaveBeenCalled();
  });

  it('runs tasks in order and feeds prior outputs as context', async () => {
    const { executor, calls } = recordingExecutor();
    const crew = new Crew({ process: 'sequential' })
      .addAgent(coder)
      .addAgent(reviewer)
      .addTask({ id: 't1', description: 'Build the widget.', agentId: 'a_coder' })
      .addTask({ id: 't2', description: 'Review the widget.', agentId: 'a_reviewer' });

    const result = await crew.kickoff({ executor });

    expect(result.status).toBe('completed');
    expect(result.output).toBe('output-of-t2-by-Ada');
    expect(result.taskOutputs).toHaveLength(2);
    expect(calls[0]?.agent.id).toBe('a_coder');
    // Default context: every prior task output is injected.
    expect(calls[1]?.prompt).toContain('output-of-t1-by-Grace');
    expect(calls[1]?.prompt).toContain('[t1 — Grace]');
  });

  it('restricts context to the explicit task.context list', async () => {
    const { executor, calls } = recordingExecutor();
    const crew = new Crew()
      .addAgent(coder)
      .addAgent(reviewer)
      .addTask({ id: 't1', description: 'One', agentId: 'a_coder' })
      .addTask({ id: 't2', description: 'Two', agentId: 'a_coder' })
      .addTask({
        id: 't3',
        description: 'Three',
        agentId: 'a_reviewer',
        context: ['t1'],
      });

    await crew.kickoff({ executor });

    expect(calls[2]?.prompt).toContain('output-of-t1-by-Grace');
    expect(calls[2]?.prompt).not.toContain('output-of-t2-by-Grace');
  });

  it('resolves members by role when agentId is a role name', async () => {
    const { executor, calls } = recordingExecutor();
    const crew = new Crew()
      .addAgent(coder)
      .addAgent(reviewer)
      .addTask({ id: 't1', description: 'Write it.', agentId: 'reviewer' });

    await crew.kickoff({ executor });

    expect(calls[0]?.agent.id).toBe('a_reviewer');
  });

  it('interpolates {key} placeholders from crew inputs', async () => {
    const { executor, calls } = recordingExecutor();
    const crew = new Crew()
      .addAgent(coder)
      .addTask({ id: 't1', description: 'Target file: {file}.', agentId: 'a_coder' });

    await crew.kickoff({ executor, inputs: { file: 'src/app.ts' } });

    expect(calls[0]?.prompt).toContain('Target file: src/app.ts.');
    expect(calls[0]?.prompt).toContain('"file": "src/app.ts"');
  });

  it('throws when a task cannot be resolved to a member', async () => {
    const crew = new Crew()
      .addAgent(coder)
      .addTask({ id: 't1', description: 'Orphan.', agentId: 'nobody' });

    await expect(crew.kickoff({ executor: recordingExecutor().executor })).rejects.toThrow(
      /cannot be resolved to a crew member/,
    );
  });

  it('emits a replayable event stream', async () => {
    const events = collectEvents();
    const { executor } = recordingExecutor();
    const crew = new Crew({ onEvent: (event) => events.push(event) })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'Do it.', agentId: 'a_coder' });

    const result = await crew.kickoff({ executor });

    expect(events.map((e) => e.type)).toEqual([
      'crew_start',
      'task_start',
      'task_complete',
      'crew_complete',
    ]);
    const complete = events.at(-1);
    expect(complete?.type === 'crew_complete' && complete.status).toBe('completed');
    expect(complete?.type === 'crew_complete' && complete.crewId).toBe(result.crewId);
  });
});

describe('Crew guardrails', () => {
  it('retries with the guardrail feedback, then accepts', async () => {
    const events: CrewEvent[] = [];
    const { executor, calls } = recordingExecutor(() => 'draft output');
    let attempt = 0;
    const crew = new Crew({ onEvent: (e) => events.push(e) })
      .addAgent(coder)
      .addTask({
        id: 't1',
        description: 'Produce a numbered list.',
        agentId: 'a_coder',
        guardrail: (_output) => {
          attempt += 1;
          return attempt === 1 ? 'Output must be a numbered list.' : true;
        },
      });

    const result = await crew.kickoff({ executor });

    expect(result.status).toBe('completed');
    expect(result.taskOutputs[0]?.retries).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain('Previous attempt (rejected by the guardrail)');
    expect(calls[1]?.prompt).toContain('Output must be a numbered list.');
    expect(events.some((e) => e.type === 'task_guardrail_retry')).toBe(true);
  });

  it('fails the crew when the guardrail never passes', async () => {
    const events: CrewEvent[] = [];
    const { executor } = recordingExecutor(() => 'still wrong');
    const crew = new Crew({ onEvent: (e) => events.push(e) })
      .addAgent(coder)
      .addTask({
        id: 't1',
        description: 'Produce a numbered list.',
        agentId: 'a_coder',
        maxRetries: 1,
        guardrail: () => 'not a list',
      });

    const result = await crew.kickoff({ executor });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/failed its guardrail after 2 attempt/);
    expect(events.some((e) => e.type === 'task_failed')).toBe(true);
    expect(events.filter((e) => e.type === 'crew_complete')[0]).toMatchObject({ status: 'failed' });
  });
});

describe('Crew hierarchical process', () => {
  it('delegates via tools and integrates member output', async () => {
    const events: CrewEvent[] = [];
    const { executor, calls } = recordingExecutor(async (req) => {
      if (req.agent.role === 'manager') {
        const delegate = req.tools.find((t) => t.name === 'delegate_work');
        expect(delegate).toBeDefined();
        const memberResult = await delegate!.execute({
          coworker: 'coder',
          task: 'Write the module.',
          context: 'TypeScript only.',
        });
        return `INTEGRATED: ${memberResult}`;
      }
      return `${req.agent.name} did the work (prompt mentions TypeScript only: ${req.prompt.includes('TypeScript only.')})`;
    });

    const crew = new Crew({
      process: 'hierarchical',
      onEvent: (e) => events.push(e),
    })
      .addAgent(coder)
      .addAgent(reviewer)
      .addTask({ id: 't1', description: 'Ship the feature.', expectedOutput: 'Merged code.' });

    const result = await crew.kickoff({ executor });

    expect(result.status).toBe('completed');
    expect(result.output).toContain('INTEGRATED:');
    expect(result.output).toContain('Grace did the work');
    expect(result.taskOutputs[0]?.delegations).toBe(1);
    expect(events.some((e) => e.type === 'delegation')).toBe(true);
    // The manager's prompt lists the roster and the expected output.
    const managerCall = calls.find((c) => c.agent.role === 'manager');
    expect(managerCall?.prompt).toContain('Grace (coder)');
    expect(managerCall?.prompt).toContain('Merged code.');
    // Members run without delegation tools (fixed recursion depth).
    const memberCall = calls.find((c) => c.agent.role === 'coder');
    expect(memberCall?.toolNames).toEqual([]);
  });
});

describe('Delegation tools', () => {
  const members = [coder, reviewer];

  it('rejects unknown crewmates with the roster', async () => {
    const { tools } = createDelegationTools({
      members,
      executeMemberTask: async () => 'never',
    });
    const observation = await tools[0]!.execute({ coworker: 'ghost', task: 'hi' });
    expect(observation).toMatch(/no crewmate matches "ghost"/);
    expect(observation).toContain('Grace (coder)');
    expect(observation).toContain('Ada (reviewer)');
  });

  it('rejects self-delegation', async () => {
    const { tools } = createDelegationTools({
      members,
      currentAgent: coder,
      executeMemberTask: async () => 'never',
    });
    const observation = await tools[0]!.execute({ coworker: 'Grace', task: 'hi' });
    expect(observation).toMatch(/cannot delegate to yourself/);
  });

  it('stops accepting delegations past the budget', async () => {
    const { tools } = createDelegationTools({
      members,
      maxDelegations: 1,
      executeMemberTask: async () => 'done',
    });
    await tools[0]!.execute({ coworker: 'Ada', task: 'one' });
    const second = await tools[1]!.execute({ coworker: 'Ada', task: 'two' });
    expect(second).toMatch(/delegation limit \(1\) reached/);
  });

  it('emits a delegation event per accepted call', async () => {
    const onDelegation = vi.fn();
    const { tools } = createDelegationTools({
      members,
      currentAgent: coder,
      onDelegation,
      executeMemberTask: async () => 'answer',
    });
    await tools[1]!.execute({ coworker: 'Ada', task: 'what?' });
    expect(onDelegation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'delegation', toAgentId: 'a_reviewer', kind: 'question' }),
    );
  });
});

describe('Crew cancellation', () => {
  it('keeps completed task outputs and reports cancellation', async () => {
    const controller = new AbortController();
    const { executor } = recordingExecutor(() => {
      controller.abort();
      return 'first done';
    });
    const crew = new Crew({ signal: controller.signal })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'First.', agentId: 'a_coder' })
      .addTask({ id: 't2', description: 'Second.', agentId: 'a_coder' });

    const result = await crew.kickoff({ executor });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/cancelled/);
    expect(result.taskOutputs.map((o) => o.taskId)).toEqual(['t1']);
    expect(result.output).toBe('first done');
  });

  it('stops the ReAct loop promptly when the signal aborts mid-run', async () => {
    // The lightweight ReAct path does not poll config.signal; the executor
    // must enforce cancellation through the wrapped llmCall instead.
    const controller = new AbortController();
    const executor = createReActCrewTaskExecutor({
      llmCall: async () => {
        controller.abort();
        return new AIMessage('should never be used');
      },
    });
    await expect(
      executor({
        crewId: 'crew_x',
        taskId: 't1',
        agent: coder,
        prompt: 'Start working.',
        tools: [],
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
  });
});

describe('Crew task failure events', () => {
  it('emits task_failed when the executor throws unexpectedly', async () => {
    const events: CrewEvent[] = [];
    const executor: CrewTaskExecutor = async () => {
      throw new Error('provider exploded');
    };
    const crew = new Crew({ onEvent: (e) => events.push(e) })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'Doomed task.', agentId: 'a_coder' });

    const result = await crew.kickoff({ executor });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('provider exploded');
    expect(events.some((e) => e.type === 'task_start')).toBe(true);
    expect(events.some((e) => e.type === 'task_failed')).toBe(true);
    // Exactly one task_failed — guardrail exhaustion must not double-emit.
    expect(events.filter((e) => e.type === 'task_failed')).toHaveLength(1);
  });

  it('does not double-emit task_failed when a guardrail exhausts', async () => {
    const events: CrewEvent[] = [];
    const { executor } = recordingExecutor(() => 'bad output');
    const crew = new Crew({ onEvent: (e) => events.push(e) })
      .addAgent(coder)
      .addTask({
        id: 't1',
        description: 'Never passes.',
        agentId: 'a_coder',
        maxRetries: 0,
        guardrail: () => 'nope',
      });

    const result = await crew.kickoff({ executor });

    expect(result.status).toBe('failed');
    expect(events.filter((e) => e.type === 'task_failed')).toHaveLength(1);
  });
});

describe('Crew hierarchical validation', () => {
  it('runs without any resolvable member assignment (manager owns routing)', async () => {
    const { executor, calls } = recordingExecutor((req) =>
      req.agent.role === 'manager' ? 'manager final answer' : 'member answer',
    );
    const crew = new Crew({ process: 'hierarchical' })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'Ship it.', agentId: 'does-not-exist' });

    const result = await crew.kickoff({ executor });

    expect(result.status).toBe('completed');
    expect(result.output).toBe('manager final answer');
    expect(calls[0]?.agent.role).toBe('manager');
  });
});

describe('CrewPlanner', () => {
  it('prepends the plan to each task prompt', async () => {
    const planner = new CrewPlanner(async () =>
      '```json\n[{"taskId": "t1", "plan": "1. Read the file. 2. Edit it."}]\n```',
    );
    const events: CrewEvent[] = [];
    const { executor, calls } = recordingExecutor();
    const crew = new Crew({ planning: true, planner, onEvent: (e) => events.push(e) })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'Change something.', agentId: 'a_coder' });

    await crew.kickoff({ executor });

    expect(events.some((e) => e.type === 'plan_created')).toBe(true);
    expect(calls[0]?.prompt).toContain('# Plan');
    expect(calls[0]?.prompt).toContain('2. Edit it.');
  });

  it('degrades to no plan on a malformed answer', async () => {
    const planner = new CrewPlanner(async () => 'I cannot produce JSON right now.');
    const events: CrewEvent[] = [];
    const { executor, calls } = recordingExecutor();
    const crew = new Crew({ planning: true, planner, onEvent: (e) => events.push(e) })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'Change something.', agentId: 'a_coder' });

    const result = await crew.kickoff({ executor });

    expect(result.status).toBe('completed');
    expect(events.some((e) => e.type === 'plan_created')).toBe(false);
    expect(calls[0]?.prompt).not.toContain('# Plan');
  });

  it('drops plan steps for unknown task ids', async () => {
    const planner = new CrewPlanner(async () =>
      '[{"taskId": "ghost", "plan": "x"}, {"taskId": "t1", "plan": "real"}]',
    );
    const steps = await planner.plan([coder], [{ id: 't1', description: 'd', agentId: 'a_coder' }], {});
    expect(steps).toEqual([{ taskId: 't1', plan: 'real' }]);
  });
});

describe('ReAct crew executor', () => {
  it('compiles the identity triplet into the system prompt', () => {
    const prompt = crewAgentSystemPrompt({
      id: 'a',
      name: 'Grace',
      role: 'coder',
      goal: 'Write correct code.',
      backstory: 'A senior engineer.',
    });
    expect(prompt).toContain('You are Grace, the coder');
    expect(prompt).toContain('Write correct code.');
    expect(prompt).toContain('A senior engineer.');
  });

  it('runs the ReAct loop and returns the final answer', async () => {
    const executor = createReActCrewTaskExecutor({
      llmCall: async () => new AIMessage('final answer'),
    });
    const output = await executor({
      crewId: 'crew_x',
      taskId: 't1',
      agent: coder,
      prompt: 'Say the final answer.',
      tools: [],
    });
    expect(output).toBe('final answer');
  });
});
