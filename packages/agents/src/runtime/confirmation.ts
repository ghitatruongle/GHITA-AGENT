// ConfirmationGate — confirmation là TRẠNG THÁI đo được + quyết định
// idempotent (design ported from OpenHands confirmation flow, MIT).
//
// Nguyên tắc:
//   1. Chờ duyệt = một trạng thái visible (waiting_for_confirmation), không
//      phải biến cục bộ trong callback.
//   2. respond() là idempotent: bấm đôi / double-submit không gửi 2 lần.
//   3. "Ngừng ngay" (interrupt) và "nghỉ sau lệnh hiện tại" (pause) là 2
//      ngữ nghĩa tách bạch.

export type ConfirmationState = 'idle' | 'waiting' | 'resolved';

export interface PendingConfirmation {
  /** Id duy nhất của yêu cầu duyệt (event id) — chìa khóa idempotency. */
  eventId: string;
  nodeId?: string;
  prompt: string;
  requestedAt: number;
}

export class ConfirmationGate {
  private state: ConfirmationState = 'idle';
  private pending: PendingConfirmation | undefined;
  /** Event id đã từng respond — bấm lại không gửi lần 2. */
  private readonly responded = new Set<string>();
  /** Đếm số quyết định thực sự gửi ra (bằng chứng idempotency). */
  private submittedCount = 0;

  request(entry: { eventId: string; prompt: string; nodeId?: string }): boolean {
    if (this.state === 'waiting') return false; // không chồng yêu cầu
    // P2 fix: event replay của eventId ĐÃ trả lời không được tạo confirmation
    // zombie (waiting mãi vì respond() đã bị chặn vĩnh viễn).
    if (this.responded.has(entry.eventId)) return false;
    this.pending = { ...entry, requestedAt: Date.now() };
    this.state = 'waiting';
    return true;
  }

  get phase(): ConfirmationState {
    return this.state;
  }

  get current(): PendingConfirmation | undefined {
    return this.pending;
  }

  /**
   * Trả lời yêu cầu duyệt. Idempotent: event id đã respond thì bị từ chối
   * (trả false, không đếm, không đổi trạng thái). Trả true = quyết định
   * đã được gửi ra (lần đầu tiên).
   */
  respond(eventId: string, approved: boolean, onDecision: (approved: boolean) => void): boolean {
    if (this.state !== 'waiting' || this.pending?.eventId !== eventId) return false;
    if (this.responded.has(eventId)) return false;
    this.responded.add(eventId);
    this.submittedCount += 1;
    this.state = 'resolved';
    this.pending = undefined;
    onDecision(approved);
    return true;
  }

  /** Số quyết định đã thực sự gửi (để test idempotency). */
  get submissions(): number {
    return this.submittedCount;
  }

  /** Đặt lại cho run mới (giữ responded set — event id là duy nhất vĩnh viễn). */
  resetForNewRun(): void {
    this.state = 'idle';
    this.pending = undefined;
  }
}
