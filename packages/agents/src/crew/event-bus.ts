// CrewEventBus — event bus nội bộ nhiều listener (CrewAI events/event_bus
// pattern, MIT — clean-room TS): UI + telemetry + log gắn listener độc lập;
// lỗi của một listener không bao giờ làm chết run hay listener khác.

import type { CrewEvent } from './types.js';

type Listener = (event: CrewEvent) => void;

export class CrewEventBus {
  private readonly listeners = new Map<number, Listener>();
  private nextId = 1;

  /** Đăng ký listener; trả về hàm unsubscribe. */
  on(listener: Listener): () => void {
    const id = this.nextId++;
    this.listeners.set(id, listener);
    return () => {
      this.listeners.delete(id);
    };
  }

  /** Phát event tới mọi listener; lỗi từng listener được nuốt riêng. */
  emit(event: CrewEvent): void {
    for (const listener of [...this.listeners.values()]) {
      try {
        listener(event);
      } catch {
        // Lỗi một listener không làm chết run hay các listener khác.
      }
    }
  }

  get count(): number {
    return this.listeners.size;
  }
}
