// Track 5 — Crew nâng cao (CrewAI patterns, MIT): RPM limit (5.1), memory
// tools (5.2), event bus (5.3), guardrail LLM (5.4).
import { describe, expect, it } from 'vitest';
import { Crew } from '../src/crew/crew.js';
import { RpmLimiter } from '../src/crew/rpm.js';
import { CrewEventBus } from '../src/crew/event-bus.js';
import { createMemoryTools } from '../src/crew/memory.js';
import type { CrewAgentSpec, CrewEvent, CrewTaskExecutor } from '../src/crew/types.js';

function collectEvents(): { events: CrewEvent[]; onEvent: (e: CrewEvent) => void } {
  const events: CrewEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

function timeoutTaskIds(events: CrewEvent[]): string[] {
  return events
    .filter((e): e is Extract<CrewEvent, { type: 'task_timeout' }> => e.type === 'task_timeout')
    .map((e) => e.taskId);
}

const coder: CrewAgentSpec = {
  id: 'a_coder',
  name: 'Grace',
  role: 'coder',
  goal: 'Write correct code.',
};

const okExecutor: CrewTaskExecutor = async () => 'done';

describe('5.1 — RpmLimiter', () => {
  it('cho qua dung maxPerMinute slot trong cung mot phut', async () => {
    let fakeNow = 0;
    const limiter = new RpmLimiter(3);
    await limiter.acquire(() => fakeNow);
    await limiter.acquire(() => fakeNow);
    await limiter.acquire(() => fakeNow);
    expect(limiter.used(() => fakeNow)).toBe(3);
  });

  it('het slot thi sleep toi moc cu nhat het han (dong ho gia)', async () => {
    let fakeNow = 0;
    const slept: number[] = [];
    const limiter = new RpmLimiter(1);
    await limiter.acquire(() => fakeNow);
    const p = limiter.acquire(
      () => fakeNow,
      async (ms) => {
        slept.push(ms);
        fakeNow += ms;
      },
    );
    await p;
    expect(slept.length).toBeGreaterThan(0);
    expect(slept[0]).toBeGreaterThan(50_000); // phai cho gan het phut
    expect(limiter.used(() => fakeNow)).toBe(1);
  });

  it('tu choi maxPerMinute khong hop le', () => {
    expect(() => new RpmLimiter(0)).toThrow();
    expect(() => new RpmLimiter(-1)).toThrow();
  });
});

describe('5.2 — memory tools', () => {
  it('crew_memorize/crew_recall boc CrewMemoryBridge', async () => {
    const stored: string[] = [];
    const memory = {
      recall: (q: string) => (q === 'stack' ? 'TypeScript' : null),
      remember: (content: string) => {
        stored.push(content);
      },
    };
    const tools = createMemoryTools(memory);
    expect(tools.map((t) => t.name)).toEqual(['crew_memorize', 'crew_recall']);
    const memorize = tools[0]!;
    const recall = tools[1]!;
    expect(await memorize.execute({ content: 'quyết định X' })).toContain('Remembered');
    expect(stored).toEqual(['quyết định X']);
    expect(await recall.execute({ query: 'stack' })).toBe('TypeScript');
    expect(await recall.execute({ query: 'missing' })).toBe('(none)');
  });

  it('crew co memory thi member nhan them 2 tool', async () => {
    const memory = { recall: () => null, remember: () => {} };
    const seenTools: string[][] = [];
    const executor: CrewTaskExecutor = async (req) => {
      seenTools.push(req.tools.map((t) => t.name));
      return 'ok';
    };
    const crew = new Crew({ memory })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'work' });
    await crew.kickoff({ executor });
    expect(seenTools[0]).toContain('crew_memorize');
    expect(seenTools[0]).toContain('crew_recall');
  });
});

describe('5.3 — CrewEventBus', () => {
  it('nhieu listener doc lap deu nhan event', () => {
    const bus = new CrewEventBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.on((e) => a.push(e.type));
    bus.on((e) => b.push(e.type));
    const ev = { type: 'crew_start', crewId: 'x', process: 'sequential', taskCount: 1, timestamp: 0 } as CrewEvent;
    bus.emit(ev);
    bus.emit(ev);
    expect(a).toEqual(['crew_start', 'crew_start']);
    expect(b).toEqual(['crew_start', 'crew_start']);
    expect(bus.count).toBe(2);
  });

  it('listener nem loi khong chet listener khac', () => {
    const bus = new CrewEventBus();
    const got: string[] = [];
    bus.on(() => {
      throw new Error('boom');
    });
    bus.on((e) => got.push(e.type));
    bus.emit({ type: 'task_start', taskId: 't', timestamp: 0 } as CrewEvent);
    expect(got).toEqual(['task_start']);
  });

  it('crew onEvent broken van chay du (bus nuot loi)', async () => {
    const crew = new Crew({
      onEvent: () => {
        throw new Error('broken UI');
      },
    })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'w' });
    const result = await crew.kickoff({ executor: okExecutor });
    expect(result.status).toBe('completed');
  });
});

describe('5.4 — guardrail mo ta (LLM judge)', () => {
  it('guardrail string qua llmJudge: retry theo feedback roi pass', async () => {
    const prompts: string[] = [];
    let calls = 0;
    const crew = new Crew({
      llmJudge: async (description, output) => {
        prompts.push(description + '|' + output);
        calls += 1;
        return calls === 1 ? 'thiếu số' : true;
      },
    })
      .addAgent(coder)
      .addTask({
        id: 't1',
        description: 'Viết số liệu',
        guardrail: 'Output phải chứa một con số cụ thể',
      });

    const result = await crew.kickoff({ executor: async () => 'báo cáo' });

    expect(result.status).toBe('completed');
    expect(calls).toBe(2);
    expect(result.taskOutputs[0]?.retries).toBe(1);
  });

  it('thieu llmJudge khi guardrail string -> kickoff tu choi truoc khi chay', async () => {
    const crew = new Crew()
      .addAgent(coder)
      .addTask({ id: 't1', description: 'x', guardrail: 'phải có số' });
    await expect(crew.kickoff({ executor: okExecutor })).rejects.toThrow(/llmJudge is not set/);
  });
});


describe('R1 fix regression (vòng 3)', () => {
  it('judge chậm vượt deadline -> task_timeout (judge nằm trong deadline)', async () => {
    const { events, onEvent } = collectEvents();
    const crew = new Crew({
      maxExecutionTime: 80,
      onEvent,
      llmJudge: async () => {
        await new Promise((r) => setTimeout(r, 400));
        return true;
      },
    })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'x', guardrail: 'phải có số' });

    const result = await crew.kickoff({ executor: okExecutor });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('timed out');
    expect(timeoutTaskIds(events)).toEqual(['t1']);
  });

  it('hai kickoff đồng thời: state per-run, run failed giữ outputs CỦA MÌNH', async () => {
    const slowExecutor: CrewTaskExecutor = async (req) => {
      await new Promise((r) => setTimeout(r, req.taskId === 't1' ? 120 : 20));
      return 'SLOW-' + req.taskId;
    };
    const fastExecutor: CrewTaskExecutor = async (req) => {
      await new Promise((r) => setTimeout(r, 5));
      if (req.taskId === 't2') throw new Error('fast boom');
      return 'FAST-' + req.taskId;
    };
    const crew = new Crew()
      .addAgent(coder)
      .addTask({ id: 't1', description: 'one' })
      .addTask({ id: 't2', description: 'two' });

    const [slow, fast] = await Promise.all([
      crew.kickoff({ executor: slowExecutor }),
      crew.kickoff({ executor: fastExecutor }),
    ]);

    // Run fast failed ở t2 nhưng vẫn giữ output t1 CỦA NÓ (không nhiễm SLOW).
    expect(fast.status).toBe('failed');
    expect(fast.taskOutputs.map((o) => o.output)).toEqual(['FAST-t1']);
    expect(slow.status).toBe('completed');
    expect(slow.taskOutputs.map((o) => o.output)).toEqual(['SLOW-t1', 'SLOW-t2']);
  });

  it('memory.remember async reject -> không unhandledRejection, run vẫn completed', async () => {
    const rejections: unknown[] = [];
    const handler = (err: unknown): void => {
      rejections.push(err);
    };
    process.on('unhandledRejection', handler);
    try {
      const memory = {
        recall: () => null,
        remember: async () => {
          throw new Error('db down');
        },
      };
      const crew = new Crew({ memory })
        .addAgent(coder)
        .addTask({ id: 't1', description: 'w' });
      const result = await crew.kickoff({ executor: okExecutor });
      expect(result.status).toBe('completed');
      await new Promise((r) => setTimeout(r, 20));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  it('memory.recall ném sync -> run không chết vì best-effort', async () => {
    const memory = {
      recall: () => {
        throw new Error('recall boom');
      },
      remember: () => {},
    };
    const crew = new Crew({ memory })
      .addAgent(coder)
      .addTask({ id: 't1', description: 'w' });
    const result = await crew.kickoff({ executor: okExecutor });
    expect(result.status).toBe('completed');
  });
});
