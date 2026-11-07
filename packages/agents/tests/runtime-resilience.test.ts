// Track 4 — Chạy bền (OpenHands patterns, MIT — clean-room TS): event log
// bền vững (4.1), cursor chịu gap (4.2), handshake tail+afterSeq (4.3),
// delta batcher theo frame (4.4), reconnect backoff + grace (4.5),
// confirmation idempotent (4.6).
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunEventLog } from '../src/runtime/event-log.js';
import { GapTolerantSeqCursor, MAX_AHEAD } from '../src/runtime/cursor.js';
import { StreamingDeltaBatcher } from '../src/runtime/delta-batcher.js';
import { ReconnectPolicy } from '../src/runtime/reconnect.js';
import { ConfirmationGate } from '../src/runtime/confirmation.js';

describe('4.1/4.3 — RunEventLog', () => {
  it('append gán id+seq tăng dần và load lại được (dedup theo id)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ghita-log-'));
    const log = new RunEventLog({ dir });
    const e1 = await log.append('run1', 'task_start', { t: 1 });
    const e2 = await log.append('run1', 'task_complete', { t: 2 });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e1.id).not.toBe(e2.id);

    const loaded = await log.load('run1');
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.type).toBe('task_start');
  });

  it('restart: load() sau khi mở lại (dedup) rồi append tiếp seq không lùi', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ghita-log-'));
    const first = new RunEventLog({ dir });
    await first.append('run2', 'a', {});
    await first.append('run2', 'b', {});

    const reopened = new RunEventLog({ dir });
    const loaded = await reopened.load('run2');
    expect(loaded).toHaveLength(2);
    const e3 = await reopened.append('run2', 'c', {});
    expect(e3.seq).toBe(3);
    const again = await reopened.load('run2');
    expect(again).toHaveLength(3);
    const ids = again.map((e) => e.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('tail(n) + afterSeq(s) là handshake resume', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ghita-log-'));
    const log = new RunEventLog({ dir });
    for (let i = 0; i < 5; i++) await log.append('run3', 'e' + i, { i });
    const tail = await log.tail('run3', 2);
    expect(tail.map((e) => e.type)).toEqual(['e3', 'e4']);
    const after = await log.afterSeq('run3', 3);
    expect(after.map((e) => e.seq)).toEqual([4, 5]);
  });

  it('dòng JSONL hỏng giữa chừng không làm chết log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ghita-log-'));
    const log = new RunEventLog({ dir });
    await log.append('run4', 'good1', {});
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(dir, 'run4.jsonl'), '{"id":"x","seq":' + '\n', 'utf8');
    await log.append('run4', 'good2', {});
    const loaded = await log.load('run4');
    expect(loaded.map((e) => e.type).sort()).toEqual(['good1', 'good2']);
  });
});

describe('4.2 — GapTolerantSeqCursor', () => {
  it('event lệch thứ tự được giữ, lấp đầy lỗ thì drain đúng thứ tự', () => {
    const cursor = new GapTolerantSeqCursor();
    expect(cursor.observe(2, 'two')).toEqual([]);
    expect(cursor.observe(1, 'one')).toEqual(['one', 'two']);
    expect(cursor.current).toBe(2);
    expect(cursor.pending).toBe(0);
  });

  it('gap vượt MAX_AHEAD thì nhảy qua (server đã bỏ event)', () => {
    const cursor = new GapTolerantSeqCursor();
    expect(cursor.observe(MAX_AHEAD + 5, 'far')).toEqual(['far']);
    expect(cursor.current).toBe(MAX_AHEAD + 5);
  });

  it('baseline handshake: cursor = count sau REST tail', () => {
    const cursor = new GapTolerantSeqCursor();
    cursor.setBaseline(5);
    expect(cursor.current).toBe(5);
    expect(cursor.observe(6, 'six')).toEqual(['six']);
  });
});

describe('4.4 — StreamingDeltaBatcher', () => {
  it('gom delta va commit toi da 1 lan moi frame', async () => {
    const commits: string[] = [];
    const batcher = new StreamingDeltaBatcher((slot) => commits.push(slot.text), 10);
    batcher.openSlot('item1');
    batcher.pushDelta('item1', 'Hel');
    batcher.pushDelta('item1', 'lo');
    await new Promise((r) => setTimeout(r, 40));
    expect(commits).toEqual(['Hello']);
  });

  it('closeSlot chot ngay, abortSlot bo slot khong commit', () => {
    const commits: string[] = [];
    const batcher = new StreamingDeltaBatcher((slot) => commits.push(slot.text), 10);
    batcher.openSlot('a');
    batcher.pushDelta('a', 'keep');
    expect(batcher.closeSlot('a')).toBe('keep');
    batcher.openSlot('b');
    batcher.pushDelta('b', 'trash');
    batcher.abortSlot('b');
    expect(batcher.closeSlot('b')).toBe('');
    expect(commits).toEqual(['keep']);
  });

  it('flushAll truoc event khac: khong vuot den do', () => {
    const commits: string[] = [];
    const batcher = new StreamingDeltaBatcher((slot) => commits.push(slot.text), 50);
    batcher.openSlot('s');
    batcher.pushDelta('s', 'partial');
    batcher.flushAll();
    expect(commits).toEqual(['partial']);
  });
});

describe('4.5 — ReconnectPolicy', () => {
  it('backoff tang dan va cap 30s, co jitter', () => {
    const p = new ReconnectPolicy();
    const d1 = p.nextDelay();
    expect(d1.delayMs).toBeGreaterThanOrEqual(250);
    expect(d1.delayMs).toBeLessThanOrEqual(1150);
    for (let i = 0; i < 12; i++) p.nextDelay();
    expect(p.nextDelay().delayMs).toBeLessThanOrEqual(34_500);
    expect(p.nextDelay().delayMs).toBeGreaterThanOrEqual(25_500);
  });

  it('grace period 3 pha: silent -> reconnecting -> retryable', () => {
    const p = new ReconnectPolicy();
    p.markFailure(1000);
    expect(p.gracePhase(1000)).toBe('silent');
    expect(p.gracePhase(31_000)).toBe('reconnecting');
    expect(p.gracePhase(61_000)).toBe('retryable');
    p.clearFailure();
    expect(p.gracePhase(61_000)).toBe('silent');
  });
});

describe('4.6 — ConfirmationGate idempotent', () => {
  it('bam doi khong gui 2 lan', () => {
    const gate = new ConfirmationGate();
    const decisions: boolean[] = [];
    expect(gate.request({ eventId: 'e1', prompt: 'approve?' })).toBe(true);
    expect(gate.phase).toBe('waiting');
    expect(gate.respond('e1', true, (a) => decisions.push(a))).toBe(true);
    expect(gate.respond('e1', true, (a) => decisions.push(a))).toBe(false);
    expect(gate.respond('e1', false, (a) => decisions.push(a))).toBe(false);
    expect(decisions).toEqual([true]);
    expect(gate.submissions).toBe(1);
  });

  it('khong cho phep request chong khi dang waiting', () => {
    const gate = new ConfirmationGate();
    expect(gate.request({ eventId: 'e1', prompt: 'a' })).toBe(true);
    expect(gate.request({ eventId: 'e2', prompt: 'b' })).toBe(false);
    expect(gate.current?.eventId).toBe('e1');
  });

  it('respond sai eventId bi tu choi', () => {
    const gate = new ConfirmationGate();
    gate.request({ eventId: 'e1', prompt: 'a' });
    expect(gate.respond('wrong', true, () => {})).toBe(false);
    expect(gate.phase).toBe('waiting');
  });
});

describe('9.2 — P1/P2 fix regression', () => {
  it('P1-7: 2 saveGraph/append đồng thời không race (chain serialize)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ghita-log-'));
    const log = new RunEventLog({ dir });
    const [a, b, c] = await Promise.all([
      log.append('race', 'a', {}),
      log.append('race', 'b', {}),
      log.append('race', 'c', {}),
    ]);
    expect([a.seq, b.seq, c.seq].sort((x, y) => x - y)).toEqual([1, 2, 3]);
    const loaded = await log.load('race');
    expect(loaded).toHaveLength(3);
  });

  it('P2-12: request lại eventId đã respond -> bị từ chối (không zombie)', () => {
    const gate = new ConfirmationGate();
    gate.request({ eventId: 'e1', prompt: 'a' });
    gate.respond('e1', true, () => {});
    gate.resetForNewRun();
    expect(gate.request({ eventId: 'e1', prompt: 'a lại' })).toBe(false);
    expect(gate.phase).toBe('idle');
  });

  it('P2-13: gap-jump release vùng liên tục trước khi bỏ phần sau lỗ', () => {
    const cursor = new GapTolerantSeqCursor();
    expect(cursor.observe(1, 'one')).toEqual(['one']);
    expect(cursor.observe(2, 'two')).toEqual(['two']);
    expect(cursor.observe(4, 'four')).toEqual([]); // chờ 3
    // 4 > MAX_AHEAD: 3 không bao giờ tới — release những gì liên tục (đã hết),
    // jump qua lỗ 3, event 4 bị bỏ (server đã ngắt).
    const released = cursor.observe(MAX_AHEAD + 4, 'far');
    expect(released).toEqual(['far']);
    expect(cursor.current).toBe(MAX_AHEAD + 4);
  });
});

describe('R4 debug — stress cursor, log đa instance, batcher cadence, reconnect bound', () => {
  it('F1: cursor stress — 50 event xáo trộn ngẫu nhiên, release đúng 1 lần đúng thứ tự', () => {
    const cursor = new GapTolerantSeqCursor();
    const order: number[] = [];
    const shuffled = Array.from({ length: 50 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
    for (const seq of shuffled) {
      for (const v of cursor.observe(seq, seq)) {
        if (typeof v === 'number') order.push(v);
      }
    }
    expect(order).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(cursor.pending).toBe(0);
  });

  it('F2: log instance A ghi, instance B đọc thấy đúng (không cần reload A)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ghita-log-r4-'));
    const a = new RunEventLog({ dir });
    const b = new RunEventLog({ dir });
    for (let i = 0; i < 5; i++) await a.append('shared', 'e' + i, { i });
    const seen = await b.load('shared');
    expect(seen).toHaveLength(5);
    const tail = await b.tail('shared', 2);
    expect(tail.map((e) => e.type)).toEqual(['e3', 'e4']);
  });

  it('F3: batcher nhiều slot xen kẽ — mỗi slot commit riêng, dispose xả sạch', async () => {
    const commits: Array<{ id: string; text: string }> = [];
    const batcher = new StreamingDeltaBatcher((slot) => commits.push({ id: slot.itemId, text: slot.text }), 8);
    batcher.openSlot('s1');
    batcher.openSlot('s2');
    batcher.pushDelta('s1', 'A');
    batcher.pushDelta('s2', 'X');
    batcher.pushDelta('s1', 'B');
    batcher.pushDelta('s2', 'Y');
    await new Promise((r) => setTimeout(r, 30));
    const s1 = commits.filter((c) => c.id === 's1').map((c) => c.text).join('');
    const s2 = commits.filter((c) => c.id === 's2').map((c) => c.text).join('');
    expect(s1).toBe('AB');
    expect(s2).toBe('XY');
    batcher.openSlot('s3');
    batcher.pushDelta('s3', 'partial-discard');
    batcher.dispose();
    // dispose đã xả s3 (flush-all semantics)
    expect(commits.some((c) => c.id === 's3')).toBe(true);
  });

  it('F4: reconnect 20 lần liên tiếp — delay luôn trong biên, không âm không vô hạn', () => {
    const p = new ReconnectPolicy();
    for (let i = 0; i < 20; i++) {
      const d = p.nextDelay();
      expect(d.delayMs).toBeGreaterThanOrEqual(250);
      expect(d.delayMs).toBeLessThanOrEqual(34_500);
      expect(Number.isFinite(d.delayMs)).toBe(true);
    }
    expect(p.attempt).toBe(20);
    p.reset();
    expect(p.attempt).toBe(0);
  });
});
