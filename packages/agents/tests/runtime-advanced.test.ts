// Track 7.4 + 8.1 — doom-loop gate và stop controller.
import { describe, expect, it } from 'vitest';
import { DoomLoopGate } from '../src/runtime/doom-loop.js';
import { RunStopController } from '../src/runtime/stop-controller.js';

describe('7.4 — DoomLoopGate', () => {
  it('run-length dưới ngưỡng -> ok', () => {
    const gate = new DoomLoopGate(3);
    expect(gate.observe('read_file', '{"p":"a.ts"}').verdict).toBe('ok');
    expect(gate.observe('read_file', '{"p":"a.ts"}').verdict).toBe('ok');
    expect(gate.observe('read_file', '{"p":"a.ts"}').runLength).toBe(3);
  });

  it('đạt ngưỡng -> nudge MỘT lần, lặp tiếp -> stop', () => {
    const gate = new DoomLoopGate(3);
    gate.observe('grep', '{"q":"x"}');
    gate.observe('grep', '{"q":"x"}');
    expect(gate.observe('grep', '{"q":"x"}').verdict).toBe('nudge');
    expect(gate.observe('grep', '{"q":"x"}').verdict).toBe('stop');
  });

  it('đổi tham số là reset run-length', () => {
    const gate = new DoomLoopGate(3);
    gate.observe('grep', '{"q":"x"}');
    gate.observe('grep', '{"q":"x"}');
    const r = gate.observe('grep', '{"q":"y"}');
    expect(r.verdict).toBe('ok');
    expect(r.runLength).toBe(1);
  });

  it('threshold < 2 bị từ chối', () => {
    expect(() => new DoomLoopGate(1)).toThrow();
  });
});

describe('8.1 — RunStopController', () => {
  it('interrupt: consume một lần rồi hết', () => {
    const c = new RunStopController();
    c.requestInterrupt();
    expect(c.interrupted).toBe(true);
    expect(c.consumeInterrupt()).toBe(true);
    expect(c.consumeInterrupt()).toBe(false);
    expect(c.kind).toBe('none');
  });

  it('pause-after-step: nghỉ đúng một lần sau bước hiện tại', () => {
    const c = new RunStopController();
    c.requestPauseAfterStep();
    expect(c.shouldPauseAfterStep()).toBe(true);
    expect(c.shouldPauseAfterStep()).toBe(false);
  });

  it('interrupt thắng pause', () => {
    const c = new RunStopController();
    c.requestPauseAfterStep();
    c.requestInterrupt();
    expect(c.interrupted).toBe(true);
  });
});
