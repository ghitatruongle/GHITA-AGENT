// GapTolerantSeqCursor — resume cursor chịu được event đến lệch thứ tự
// (design ported from OpenHands session-seq-cursor, MIT — clean-room TS).
//
// Cursor = seq cao nhất KHÔNG có lỗ hổng bên dưới (không phải max seq đã
// thấy!). Event đến sớm giữ trong `ahead`; khi lỗ được lấp thì drain. Lỗ
// lớn hơn MAX_AHEAD coi như event đó server đã bỏ vĩnh viễn → nhảy qua.

export const MAX_AHEAD = 1024;

export class GapTolerantSeqCursor {
  private confirmed = 0;
  private readonly ahead = new Map<number, unknown>();

  /** Event mới đến với seq S: trả về các event giờ đã liên tục (theo thứ tự). */
  observe(seq: number, value: unknown = null): unknown[] {
    if (seq <= this.confirmed) return []; // trùng/cũ: bỏ (dedup theo seq)
    if (seq > this.confirmed + MAX_AHEAD) {
      // P2 fix: release vùng liên tục CÓ SẴN trước khi jump — event đã nhận
      // trong ahead không bị mất im lặng, chỉ phần sau lỗ mới bị bỏ.
      const released: unknown[] = [];
      while (this.ahead.has(this.confirmed + 1)) {
        this.confirmed += 1;
        released.push(this.ahead.get(this.confirmed));
        this.ahead.delete(this.confirmed);
      }
      // Lỗ khổng lồ — server đã bỏ, nhảy tới seq này.
      this.confirmed = seq;
      this.ahead.clear();
      released.push(value);
      return released;
    }
    this.ahead.set(seq, value);
    const released: unknown[] = [];
    while (this.ahead.has(this.confirmed + 1)) {
      this.confirmed += 1;
      released.push(this.ahead.get(this.confirmed));
      this.ahead.delete(this.confirmed);
    }
    return released;
  }

  /** Baseline handshake: đã có sẵn count event (REST tail), cursor = count. */
  setBaseline(count: number): void {
    this.confirmed = Math.max(this.confirmed, count);
  }

  get current(): number {
    return this.confirmed;
  }

  get pending(): number {
    return this.ahead.size;
  }
}
