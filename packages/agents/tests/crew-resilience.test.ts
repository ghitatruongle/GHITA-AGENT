// Track 1 — Engine Crew tự giới hạn: deadline per task (1.1), retry LLM trần
// kép (1.2), validate kickoff (1.3), usage metrics (1.4). Pattern nguồn:
// CrewAI (MIT) + grok-build (Apache-2.0) — học pattern, tự viết lại.

import { describe, expect, it } from 'vitest';
import { AIMessage } from '../src/messages/message.js';
import { Crew, CrewTaskTimeoutError, isTransientLlmError } from '../src/crew/crew.js';
import { createReActCrewTaskExecutor, extractCrewUsageSample } from '../src/crew/executor.js';
import { GraphExecutor } from '../src/autogpt/executor.js';
import { createDefaultBlockRegistry } from '../src/blocks/builtins.js';
import { INPUT_BLOCK_NAME, OUTPUT_BLOCK_NAME } from '../src/autogpt/graph.js';
import type { GraphDefinition } from '../src/autogpt/graph.js';
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
};

function okExecutor(text = 'done'): CrewTaskExecutor {
  return async () => text;
}

function failingExecutor(message: string): CrewTaskExecutor {
  return async () => {
    throw new Error(message);
  };
}

function flakyExecutor(failTimes: number, message: string): CrewTaskExecutor {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls <= failTimes) throw new Error(message);
    return 'recovered';
  };
}

function collectEvents(): { events: CrewEvent[]; onEvent: (e: CrewEvent) => void } {
  const events: CrewEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

function timeoutTaskIds(events: CrewEvent[]): string[] {
  return events
    .filter((e): e is Extract<CrewEvent, { type: 'task_timeout' }> => e.type === 'task_timeout')
    .map((e) => e.taskId);
}

/** Executor treo cho tới khi signal abort. */
function hangingExecutor(): { executor: CrewTaskExecutor; aborted: () => boolean } {
  let aborted = false;
  const executor: CrewTaskExecutor = (req) =>
    new Promise<string>((resolve, reject) => {
      req.signal?.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(new Error('Crew task was cancelled.'));
        },
        { once: true },
      );
    });
  return { executor, aborted: () => aborted };
}

describe('Track 1.1 — task deadline', () => {
  it('fails a hung task with a timeout event and fails the run', async () => {
    const { executor, aborted } = hangingExecutor();
    const { events, onEvent } = collectEvents();
    const crew = new Crew({ maxExecutionTime: 60, onEvent })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'Hang forever.' });

    const result = await crew.kickoff({ executor });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('timed out');
    expect(aborted()).toBe(true);
    expect(timeoutTaskIds(events)).toEqual(['t1']);
    expect(events.filter((e) => e.type === 'task_failed')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'task_complete')).toHaveLength(0);
  });

  it('lets a task-level maxExecutionTime override the crew default', async () => {
    const { events, onEvent } = collectEvents();
    const { executor } = hangingExecutor();
    // Default 10s nhưng t1 có override 40ms → deadline của TASK thắng default.
    const crew = new Crew({ maxExecutionTime: 10_000, onEvent })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'Hangs.', maxExecutionTime: 40 });

    const result = await crew.kickoff({ executor });

    expect(result.status).toBe('failed');
    expect(timeoutTaskIds(events)).toEqual(['t1']);
    expect(result.duration).toBeLessThan(5_000); // không chờ default 10s
  });

  it('completes when the task finishes before the deadline', async () => {
    const crew = new Crew({ maxExecutionTime: 5_000 })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'Fast work.' });

    const result = await crew.kickoff({ executor: okExecutor('fast output') });

    expect(result.status).toBe('completed');
    expect(result.output).toBe('fast output');
  });

  it('error is a CrewTaskTimeoutError shape mentioning the deadline', async () => {
    const { executor } = hangingExecutor();
    const crew = new Crew({ maxExecutionTime: 40 })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'Hang.' });

    const result = await crew.kickoff({ executor });

    expect(result.error).toContain('timed out after 40ms');
    expect(new CrewTaskTimeoutError('t1', 40).message).toContain('timed out after 40ms');
  });
});

describe('Track 1.2 — retry LLM trần kép', () => {
  it('retries a transient failure then succeeds, recording llmRetries', async () => {
    const { events, onEvent } = collectEvents();
    const crew = new Crew({ onEvent })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'Flaky upstream.' });

    const result = await crew.kickoff({ executor: flakyExecutor(2, 'LLM rate limit exceeded (429)') });

    expect(result.status).toBe('completed');
    expect(result.output).toBe('recovered');
    expect(result.taskOutputs[0]?.llmRetries).toBe(2);
    expect(events.filter((e) => e.type === 'task_llm_retry')).toHaveLength(2);
  });

  it('does NOT retry non-transient errors', async () => {
    const { events, onEvent } = collectEvents();
    const crew = new Crew({ onEvent })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'Broken tool.' });

    const result = await crew.kickoff({ executor: failingExecutor('Invalid tool call syntax') });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Invalid tool call syntax');
    expect(events.filter((e) => e.type === 'task_llm_retry')).toHaveLength(0);
  });
  it('stops at the per-task cap (default 3) and fails the task', async () => {
    const { events, onEvent } = collectEvents();
    const crew = new Crew({ onEvent })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'Always flaky.' });

    const result = await crew.kickoff({ executor: failingExecutor('503 service unavailable') });

    expect(result.status).toBe('failed');
    expect(events.filter((e) => e.type === 'task_llm_retry')).toHaveLength(3);
    expect(result.taskOutputs).toHaveLength(0);
  });

  it('run-level cap is NOT reset between tasks', async () => {
    const { events, onEvent } = collectEvents();
    const crew = new Crew({ onEvent, llmRetriesPerTask: 2, llmRetriesPerRun: 3 })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'Flaky but recovers at cap.' })
      .addTask({ id: 't2', description: 'Always flaky.' });

    // t1 thành công sau khi đốt 2 lượt retry (đúng trần per-task 2); t2 chỉ
    // còn đúng 1 lượt trước khi trần run (3) cạn — chứng tỏ run-cap không reset.
    const flakyT1 = flakyExecutor(2, 'ECONNRESET while streaming');
    const result = await crew.kickoff({
      executor: (req) =>
        req.taskId === 't1' ? flakyT1(req) : failingExecutor('ECONNRESET while streaming')(req),
    });

    expect(result.status).toBe('failed');
    expect(events.filter((e) => e.type === 'task_llm_retry')).toHaveLength(3);
    expect(result.taskOutputs).toHaveLength(1);
  });
});

describe('Track 1.3 — validate kickoff', () => {
  it('rejects a manager that is also a crew member', async () => {
    const manager: CrewAgentSpec = { id: 'a_coder', name: 'Grace', role: 'manager', goal: 'Route.' };
    const crew = new Crew({ process: 'hierarchical', manager })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'Work.' });

    await expect(crew.kickoff({ executor: okExecutor() })).rejects.toThrow(/must not also be added as a crew member/);
  });

  it('rejects a hierarchical crew with no crewmates', async () => {
    const crew = new Crew({ process: 'hierarchical' }).addTask({ id: 't1', description: 'Work.' });

    await expect(crew.kickoff({ executor: okExecutor() })).rejects.toThrow(/nobody to delegate to/);
  });

  it('rejects a context reference to an unknown task', async () => {
    const crew = new Crew()
      .addAgent(coder)
      .addTask({ id: 't1', description: 'One.' })
      .addTask({ id: 't2', description: 'Two.', context: ['t_missing'] });

    await expect(crew.kickoff({ executor: okExecutor() })).rejects.toThrow(/references unknown task "t_missing"/);
  });

  it('rejects a context reference to a future task', async () => {
    const crew = new Crew()
      .addAgent(coder)
      .addTask({ id: 't1', description: 'One.', context: ['t2'] })
      .addTask({ id: 't2', description: 'Two.' });

    await expect(crew.kickoff({ executor: okExecutor() })).rejects.toThrow(/references future task "t2"/);
  });

  it('accepts prior-task context references (happy path)', async () => {
    const crew = new Crew()
      .addAgent(coder)
      .addTask({ id: 't1', description: 'One.' })
      .addTask({ id: 't2', description: 'Two.', context: ['t1'] });

    const result = await crew.kickoff({ executor: okExecutor() });

    expect(result.status).toBe('completed');
  });
});

describe('Track 1.4 — usage metrics', () => {
  it('aggregates per-task and per-run usage from onUsage samples', async () => {
    const { events, onEvent } = collectEvents();
    let calls = 0;
    const executor: CrewTaskExecutor = async (req) => {
      calls += 1;
      req.onUsage?.({ promptTokens: 10, completionTokens: 5, cachedTokens: 2, requests: 1 });
      return `out-${calls}`;
    };
    const crew = new Crew({ onEvent })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'One.' })
      .addTask({ id: 't2', description: 'Two.' });

    const result = await crew.kickoff({ executor });

    expect(result.status).toBe('completed');
    expect(result.usage).toEqual({ promptTokens: 20, completionTokens: 10, cachedTokens: 4, requests: 2 });
    expect(result.taskOutputs[0]?.usage).toEqual({ promptTokens: 10, completionTokens: 5, cachedTokens: 2, requests: 1 });
    const complete = events.find((e) => e.type === 'crew_complete');
    const usage = complete && complete.type === 'crew_complete' ? complete.usage : undefined;
    expect(usage).toEqual({ promptTokens: 20, completionTokens: 10, cachedTokens: 4, requests: 2 });
  });

  it('reports run usage even when the run fails mid-task', async () => {
    const executor: CrewTaskExecutor = async (req) => {
      req.onUsage?.({ promptTokens: 7, completionTokens: 3, requests: 1 });
      throw new Error('non-transient: syntax error');
    };
    const crew = new Crew().addAgent(coder).addTask({ id: 't1', description: 'Boom.' });

    const result = await crew.kickoff({ executor });

    expect(result.status).toBe('failed');
    expect(result.usage).toEqual({ promptTokens: 7, completionTokens: 3, cachedTokens: 0, requests: 1 });
  });
});

describe('extractCrewUsageSample', () => {
  it('reads split tokens + cached from metadata', () => {
    const sample = extractCrewUsageSample(
      new AIMessage('hi', { metadata: { promptTokens: 10, completionTokens: 5, cachedTokens: 2 } }),
    );
    expect(sample).toEqual({ promptTokens: 10, completionTokens: 5, cachedTokens: 2, requests: 1 });
  });

  it('falls back to tokenCount total only', () => {
    const sample = extractCrewUsageSample(new AIMessage('hi', { metadata: { tokenCount: 7 } }));
    expect(sample).toEqual({ promptTokens: 0, completionTokens: 0, requests: 1 });
  });

  it('returns undefined when no usage fields exist', () => {
    expect(extractCrewUsageSample(new AIMessage('hi'))).toBeUndefined();
  });
});

describe('ReAct executor usage wiring', () => {
  it('flows llmCall metadata to onUsage through the default executor', async () => {
    const executor = createReActCrewTaskExecutor({
      llmCall: async () =>
        new AIMessage('final answer', { metadata: { promptTokens: 11, completionTokens: 4 } }),
    });
    const seen: unknown[] = [];
    const request: CrewExecutionRequest = {
      crewId: 'crew_x',
      taskId: 't1',
      agent: coder,
      prompt: 'Say the final answer.',
      tools: [],
      onUsage: (sample) => seen.push(sample),
    };
    const output = await executor(request);
    expect(output).toBe('final answer');
    expect(seen).toEqual([{ promptTokens: 11, completionTokens: 4, requests: 1 }]);
  });
});

describe('isTransientLlmError', () => {
  it.each([
    'LLM rate limit exceeded (429)',
    'Provider is overloaded',
    'request timed out',
    'fetch failed',
    '503 service unavailable',
    'socket hang up',
    'ECONNRESET while streaming',
  ])('classifies %s as transient', (message) => {
    expect(isTransientLlmError(message)).toBe(true);
  });

  it.each(['Invalid tool call syntax', 'Policy guard denied', 'api key invalid'])(
    'classifies %s as non-transient',
    (message) => {
      expect(isTransientLlmError(message)).toBe(false);
    },
  );
});

describe('9.2 vòng 2 — regression các fix', () => {
  it('judge LLM ném exception -> task_failed terminal (không treo running)', async () => {
    const { events, onEvent } = collectEvents();
    const crew = new Crew({
      onEvent,
      llmJudge: async () => {
        throw new Error('judge network down');
      },
    })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'x', guardrail: 'phải có số' });

    const result = await crew.kickoff({ executor: okExecutor() });

    expect(result.status).toBe('failed');
    const failEvent = events.find((e) => e.type === 'task_failed');
    expect(failEvent && 'error' in failEvent ? failEvent.error : '').toContain('Guardrail judge failed');
    expect(events.filter((e) => e.type === 'task_failed')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'task_complete')).toHaveLength(0);
  });

  it('guardrail revision chia sẻ MỘT deadline của task (không re-arm đầy đủ)', async () => {
    // Guardrail luôn chê -> revise vô hạn. Deadline 120ms tổng: nếu mỗi
    // attempt re-arm đầy đủ, tổng sẽ ~nhiều trăm ms; chia sẻ thì đúng ~120ms.
    const crew = new Crew({ maxExecutionTime: 120 })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'x', guardrail: () => 'chưa đạt' });

    const result = await crew.kickoff({
      executor: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return 'bản nháp';
      },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('timed out');
    // Deadline chia sẻ: 30ms/attempt × (1 + 2 guardrail retries) = 90ms < 120ms
    // -> cạn deadline trước khi vượt trần guardrail retries (2). Nếu re-arm
    // đầy đủ thì sẽ thấy 3 attempt xong mới timeout (~đúng 120ms+) — hard to
    // time; mốc quan trọng là run FAILED vì deadline, không phải guardrail.
    expect(result.error).not.toContain('guardrail after');
  });

  it('node đã emit rồi mới fail thì KHÔNG retry (nhân đôi dữ liệu)', async () => {
    const { events, onEvent } = collectEvents();
    let calls = 0;
    const registry = createDefaultBlockRegistry();
    registry.register({
      id: 'block.emitfail.v1',
      name: 'emit_then_fail',
      description: 'emits then throws',
      category: 'logic',
      inputSchema: { type: 'object', properties: {} },
      outputSchemas: { out: { type: 'string' }, error: { type: 'string' } },
      async *run() {
        calls += 1;
        yield ['out', 'chuỗi-' + String(calls)];
        throw new Error('fail after emit');
      },
    });
    const executor = new GraphExecutor(registry, {
      onEvent,
      nodeTimeoutMs: 5000,
      nodeRetry: { attempts: 3, backoffMs: 5 },
    });
    const graph: GraphDefinition = {
      id: 'g_emitfail',
      name: 'g_emitfail',
      version: 1,
      nodes: [
        { id: 'in', blockName: INPUT_BLOCK_NAME, inputDefault: { value: 'go' } },
        { id: 'n1', blockName: 'emit_then_fail', inputDefault: {} },
        { id: 'out', blockName: OUTPUT_BLOCK_NAME },
      ],
      links: [{ source: 'n1', sourceOutput: 'out', sink: 'out', sinkInput: 'value' }],
    };
    const result = await executor.execute(graph, { inputs: { in: 'go' } });
    expect(result.status).toBe('failed');
    expect(calls).toBe(1); // KHÔNG retry
    expect(events.filter((e) => e.type === 'node_retry')).toHaveLength(0);
  });
});
