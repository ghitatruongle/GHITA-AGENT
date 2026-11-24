// Track S3 P3 — micro-batcher for Socket.IO mobile `chat_chunk` deltas.
//
// Token-by-token emission over Socket.IO costs one frame per token and keeps
// the mobile parser hot. This batcher coalesces deltas and flushes when
// either bound trips first: 16 characters OR 10 ms since the first buffered
// character. Clean-room implementation (pattern only).

export interface ChatChunkBatcherOptions {
  /** Flush as soon as the buffer holds this many characters (default 16). */
  maxChars?: number;
  /** Flush at most this many ms after the first buffered char (default 10). */
  maxDelayMs?: number;
}

export const DEFAULT_CHAT_CHUNK_MAX_CHARS = 16;
export const DEFAULT_CHAT_CHUNK_MAX_DELAY_MS = 10;

export class ChatChunkBatcher {
  private buffer = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxChars: number;
  private readonly maxDelayMs: number;
  private disposed = false;

  constructor(
    private readonly emit: (text: string) => void,
    options: ChatChunkBatcherOptions = {},
  ) {
    this.maxChars = Math.max(1, options.maxChars ?? DEFAULT_CHAT_CHUNK_MAX_CHARS);
    this.maxDelayMs = Math.max(0, options.maxDelayMs ?? DEFAULT_CHAT_CHUNK_MAX_DELAY_MS);
  }

  /** Characters currently waiting to be flushed. */
  get pending(): number {
    return this.buffer.length;
  }

  /** Buffer a delta; flushes synchronously when the char bound is reached. */
  push(text: string): void {
    if (this.disposed || !text) return;
    if (!this.buffer) {
      // First buffered char starts the delay window.
      if (this.maxDelayMs > 0) {
        this.timer = setTimeout(() => this.flush(), this.maxDelayMs);
      }
    }
    this.buffer += text;
    if (this.buffer.length >= this.maxChars) {
      this.flush();
    }
  }

  /** Emit whatever is buffered now (safe to call repeatedly). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buffer || this.disposed) return;
    const text = this.buffer;
    this.buffer = '';
    try {
      this.emit(text);
    } catch (err) {
      console.warn('[ChatChunkBatcher] emit failed:', err);
    }
  }

  /** Drop the buffer and stop the timer — no pending emission afterward. */
  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = '';
  }
}
