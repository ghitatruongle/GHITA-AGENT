// StreamingDeltaBatcher — streaming token theo "slot" (design ported from
// OpenHands streaming-delta-batcher, MIT — clean-room TS): token stream
// KHÔNG tạo event durable; slot tạm mở khi item bắt đầu, delta gom lại,
// commit tối đa 1 lần mỗi frame render; item kết thúc thì chốt/hủy slot.
//
// Quy tắc bắt buộc (OpenHands): flush() TRƯỚC khi phát bất kỳ event nào
// khác — text stream không được "vượt đèn đỏ" bởi message sau nó.

export interface DeltaSlot {
  itemId: string;
  text: string;
  startedAt: number;
}

export class StreamingDeltaBatcher {
  private readonly slots = new Map<string, DeltaSlot>();
  private readonly onCommit: (slot: DeltaSlot) => void;
  private frameMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scheduled = false;

  constructor(onCommit: (slot: DeltaSlot) => void, frameMs = 16) {
    this.onCommit = onCommit;
    this.frameMs = frameMs;
  }

  /** item_started: mở slot tạm cho item (text stream bắt đầu). */
  openSlot(itemId: string): void {
    this.slots.set(itemId, { itemId, text: '', startedAt: Date.now() });
  }

  /** delta: gom text vào slot (slot phải đã mở; bỏ qua nếu chưa). */
  pushDelta(itemId: string, chunk: string): void {
    const slot = this.slots.get(itemId);
    if (!slot) return;
    slot.text += chunk;
    this.scheduleFlush();
  }

  /** item chốt: flush ngay slot này (durable event thay thế slot tạm). */
  closeSlot(itemId: string): string {
    const slot = this.slots.get(itemId);
    if (!slot) return '';
    this.slots.delete(itemId);
    if (slot.text.length > 0) this.onCommit(slot);
    return slot.text;
  }


  /** item hủy giữa chừng: bỏ slot tạm, KHÔNG commit text dở. */
  abortSlot(itemId: string): void {
    this.slots.delete(itemId);
  }

  /** Flush mọi slot đang hóng: dùng trước khi phát event khác (flush-first). */
  flushAll(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.scheduled = false;
    }
    for (const slot of [...this.slots.values()]) {
      this.slots.delete(slot.itemId);
      if (slot.text.length > 0) this.onCommit(slot);
    }
  }

  /** Hủy frame timer (unmount). Text đang hóng bị commit luôn. */
  dispose(): void {
    this.flushAll();
  }

  /** Schedule commit ≤ 1 lần mỗi frame render. */
  private scheduleFlush(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.scheduled = false;
      for (const slot of [...this.slots.values()]) {
        if (slot.text.length > 0) {
          this.onCommit(slot);
          // Slot giữ nguyên để delta kế tiếp tiếp tục cộng dồn; consumer
          // quyết định hiển thị delta-incremental qua chính text đã commit.
          slot.text = '';
        }
      }
    }, this.frameMs);
  }
}
