// RunEventLog — durable event log for agent runs (design ported from
// OpenHands conversation event log, MIT — clean-room TS reimplementation).
//
// Ba nguyên tắc (OpenHands):
//   1. Event bền vững có `id` (uuid) + `seq` tăng dần trong run.
//   2. Dedup theo id khi đọc lại — restart không nhân đôi event.
//   3. tail() + afterSeq() là handshake resume: REST-tail + cursor baseline.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Event đã định danh: id ổn định + seq đơn điệu trong run. */
export interface SequencedEvent<T = unknown> {
  id: string;
  seq: number;
  type: string;
  payload: T;
  timestamp: number;
}

export interface RunEventLogOptions {
  /** Thư mục chứa <runId>.jsonl; tự tạo. */
  dir: string;
}

/**
 * JSONL event log per run. Mọi mutation serialize trên một promise chain
 * để nhiều consumer ghi đồng thời không xé file.
 */
export class RunEventLog {
  private readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();
  private seqCounter = 0;
  private readonly seenIds = new Set<string>();

  constructor(options: RunEventLogOptions) {
    this.dir = options.dir;
  }

  private filePath(runId: string): string {
    return path.join(this.dir, `${runId.replace(/[^a-zA-Z0-9_-]/g, '_')  }.jsonl`);
  }

  /** Nạp log cũ của run (dedup theo id) trước khi ghi thêm. */
  async load(runId: string): Promise<SequencedEvent[]> {
    let raw = '';
    try {
      raw = await fs.readFile(this.filePath(runId), 'utf8');
    } catch {
      return [];
    }
    const events: SequencedEvent[] = [];
    const seen = new Set<string>();
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as SequencedEvent;
        if (!parsed || typeof parsed.seq !== 'number' || typeof parsed.id !== 'string') continue;
        if (seen.has(parsed.id)) continue; // dedup theo id
        seen.add(parsed.id);
        if (parsed.seq > this.seqCounter) this.seqCounter = parsed.seq;
        events.push(parsed);
      } catch {
        // Dòng hỏng (ghi đứt giữa chừng) — bỏ, không làm chết cả log.
      }
    }
    for (const id of seen) this.seenIds.add(id);
    return events;
  }

  /** Serialize mutations (append + tail đọc khi ghi). */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // P1 fix: chain PHẢI reassign — nếu không mọi task chạy song song từ
    // cùng Promise.resolve() và read-modify-write bị race.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Ghi thêm event: gán id+seq, append JSONL (trả về event đã định danh). */
  async append(runId: string, type: string, payload: unknown): Promise<SequencedEvent> {
    return this.enqueue(async () => {
      this.seqCounter += 1;
      const event: SequencedEvent = {
        id: randomUUID(),
        seq: this.seqCounter,
        type,
        payload,
        timestamp: Date.now(),
      };
      if (this.seenIds.has(event.id)) return event;
      this.seenIds.add(event.id);
      await fs.appendFile(this.filePath(runId), `${JSON.stringify(event)  }\n`, 'utf8');
      return event;
    });
  }

  /** tail(n): n event cuối (REST-tail equivalent cho handshake resume). */
  tail(runId: string, count: number): Promise<SequencedEvent[]> {
    return this.enqueue(async () => {
      const all = await this.readAll(runId);
      return all.slice(Math.max(0, all.length - count));
    });
  }

  /** events sau afterSeq (mảnh cuối của handshake: WS resume after_seq). */
  async afterSeq(runId: string, afterSeq: number): Promise<SequencedEvent[]> {
    const all = await this.readAll(runId);
    return all.filter((e) => e.seq > afterSeq);
  }

  private async readAll(runId: string): Promise<SequencedEvent[]> {
    // P1 fix: parse TỪNG DÒNG với skip dòng hỏng — 1 dòng đứt giữa chừng
    // (crash khi ghi) không được phép làm handshake resume trả rỗng im lặng.
    let raw = '';
    try {
      raw = await fs.readFile(this.filePath(runId), 'utf8');
    } catch {
      return [];
    }
    const events: SequencedEvent[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        events.push(JSON.parse(line) as SequencedEvent);
      } catch {
        // Dòng hỏng — bỏ, không chết cả log.
      }
    }
    return events;
  }
}
