// Track S3 P3 — chat_chunk micro-batcher (16 chars / 10 ms) and the
// CommunicationServer broadcastStreamObject / broadcastChatChunk surface.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChatChunkBatcher,
  DEFAULT_CHAT_CHUNK_MAX_CHARS,
  DEFAULT_CHAT_CHUNK_MAX_DELAY_MS,
} from '../src/chat-chunk-batcher.js';
import { CommunicationServer } from '../src/server.js';

describe('ChatChunkBatcher — char bound', () => {
  it('flushes as soon as 16 characters are buffered', () => {
    const emitted: string[] = [];
    const batcher = new ChatChunkBatcher((text) => emitted.push(text));

    batcher.push('abcdefgh'); // 8 chars — still buffered
    expect(batcher.pending).toBe(8);
    expect(emitted).toEqual([]);

    batcher.push('ijklmnop'); // reaches 16 → flush
    expect(emitted).toEqual(['abcdefghijklmnop']);
    expect(batcher.pending).toBe(0);
    batcher.dispose();
  });

  it('oversized single pushes flush immediately', () => {
    const emitted: string[] = [];
    const batcher = new ChatChunkBatcher((text) => emitted.push(text));
    batcher.push('x'.repeat(40));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toHaveLength(40);
    batcher.dispose();
  });

  it('exposes the defaults 16 chars / 10 ms', () => {
    expect(DEFAULT_CHAT_CHUNK_MAX_CHARS).toBe(16);
    expect(DEFAULT_CHAT_CHUNK_MAX_DELAY_MS).toBe(10);
  });
});

describe('ChatChunkBatcher — timing bound', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes after 10 ms even below the char bound', () => {
    const emitted: string[] = [];
    const batcher = new ChatChunkBatcher((text) => emitted.push(text));

    batcher.push('short');
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(9);
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(emitted).toEqual(['short']);
    batcher.dispose();
  });

  it('coalesces multiple deltas into one frame within the window', () => {
    const emitted: string[] = [];
    const batcher = new ChatChunkBatcher((text) => emitted.push(text));

    batcher.push('He');
    batcher.push('ll');
    batcher.push('o!');
    expect(batcher.pending).toBe(6);
    vi.advanceTimersByTime(10);
    expect(emitted).toEqual(['Hello!']);
    batcher.dispose();
  });

  it('resets the window after each flush (no premature empty frames)', () => {
    const emitted: string[] = [];
    const batcher = new ChatChunkBatcher((text) => emitted.push(text));

    batcher.push('a');
    vi.advanceTimersByTime(10);
    expect(emitted).toEqual(['a']);

    vi.advanceTimersByTime(50);
    expect(emitted).toEqual(['a']); // no stray empty flushes

    batcher.push('b');
    vi.advanceTimersByTime(10);
    expect(emitted).toEqual(['a', 'b']);
    batcher.dispose();
  });

  it('flush() emits the remainder immediately and stops the timer', () => {
    const emitted: string[] = [];
    const batcher = new ChatChunkBatcher((text) => emitted.push(text));
    batcher.push('tail');
    batcher.flush();
    expect(emitted).toEqual(['tail']);
    vi.advanceTimersByTime(50);
    expect(emitted).toEqual(['tail']);
    batcher.dispose();
  });

  it('dispose drops the buffer without emitting', () => {
    const emitted: string[] = [];
    const batcher = new ChatChunkBatcher((text) => emitted.push(text));
    batcher.push('dropped');
    batcher.dispose();
    expect(batcher.pending).toBe(0);
    vi.advanceTimersByTime(50);
    expect(emitted).toEqual([]);
    batcher.push('after-dispose');
    expect(emitted).toEqual([]);
  });
});

describe('CommunicationServer — chat_chunk micro-batch surface', () => {
  interface FakeEmit {
    (event: string, payload: unknown): void;
  }

  function makeServerWithFakeIo(
    maxChars?: number,
    maxDelayMs?: number,
  ): {
    server: CommunicationServer;
    emitted: Array<[string, unknown]>;
  } {
    const server = new CommunicationServer({
      port: 0,
      ...(maxChars !== undefined || maxDelayMs !== undefined
        ? { chatChunkBatch: { maxChars, maxDelayMs } }
        : {}),
    });
    const emitted: Array<[string, unknown]> = [];
    const fakeIo = {
      to: (_room: string) => ({
        emit: ((event: string, payload: unknown) => {
          emitted.push([event, payload]);
        }) as FakeEmit,
      }),
      disconnectSockets: () => {},
      close: () => {},
    };
    (server as unknown as { io: unknown }).io = fakeIo;
    return { server, emitted };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('broadcastChatChunk batches sub-16-char deltas into one 10ms frame', () => {
    const { server, emitted } = makeServerWithFakeIo();
    server.broadcastChatChunk('He');
    server.broadcastChatChunk('llo');
    expect(emitted).toEqual([]);

    vi.advanceTimersByTime(10);
    expect(emitted).toEqual([['chat_chunk', { text: 'Hello', timestamp: expect.any(Number) }]]);
    server.stop();
  });

  it('broadcastStreamObject routes text deltas through the batcher and structural events immediately', () => {
    const { server, emitted } = makeServerWithFakeIo();

    server.broadcastStreamObject({ type: 'text-delta', text: 'delta-' });
    expect(emitted).toEqual([]); // still buffered

    // A structural event flushes the queued text first to preserve ordering.
    server.broadcastStreamObject({ type: 'reasoning', text: 'thinking' });
    expect(emitted).toEqual([
      ['chat_chunk', { text: 'delta-', timestamp: expect.any(Number) }],
      ['chat_chunk', { type: 'reasoning', text: 'thinking', timestamp: expect.any(Number) }],
    ]);

    server.broadcastStreamObject({
      type: 'tool-call',
      text: '',
      toolCalls: [{ name: 'choose', arguments: {} }],
    });
    expect(emitted).toHaveLength(3);
    expect(emitted[2]?.[1]).toMatchObject({ type: 'tool-call' });

    server.flushChatChunks(); // nothing pending — no duplicates
    expect(emitted.filter(([event]) => event === 'chat_chunk')).toHaveLength(3);
    server.stop();
  });

  it('chunks missing a type default to text-delta batching', () => {
    const { server, emitted } = makeServerWithFakeIo();
    server.broadcastStreamObject({ text: 'legacy' });
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(10);
    expect(emitted).toEqual([['chat_chunk', { text: 'legacy', timestamp: expect.any(Number) }]]);
    server.stop();
  });

  it('flushes a terminal text-delta immediately (done:true never lags past chat_done)', () => {
    const { server, emitted } = makeServerWithFakeIo();
    server.broadcastStreamObject({ type: 'text-delta', text: 'midd' });
    expect(emitted).toEqual([]); // non-terminal delta stays batched

    // Terminal delta: flushed synchronously (coalesced with the buffered
    // 'midd') so it lands BEFORE a chat_done the caller emits right after
    // broadcastStreamObject.
    server.broadcastStreamObject({ type: 'text-delta', text: 'le fin', done: true });
    expect(emitted).toEqual([
      ['chat_chunk', { text: 'middle fin', timestamp: expect.any(Number) }],
    ]);
    vi.advanceTimersByTime(50);
    expect(emitted).toHaveLength(1); // no duplicate flush, no stray timer frame
    server.stop();
  });

  it('honors custom batch bounds from ServerConfig.chatChunkBatch', () => {
    const { server, emitted } = makeServerWithFakeIo(4, 5);
    server.broadcastChatChunk('abc');
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(5);
    expect(emitted).toEqual([['chat_chunk', { text: 'abc', timestamp: expect.any(Number) }]]);

    // 4-char bound flushes instantly.
    server.broadcastChatChunk('wxyz');
    expect(emitted.filter(([, p]) => (p as { text: string }).text === 'wxyz')).toHaveLength(1);
    server.stop();
  });
});
