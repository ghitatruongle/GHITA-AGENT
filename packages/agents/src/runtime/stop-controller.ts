// RunStopController — tách bạch HAI ngữ nghĩa ngừng (OpenHands
// conversation-mutation-utils pattern, MIT):
//   - interrupt: huỷ NGAY request đang bay (crew/workflow dừng tức thì);
//   - pauseAfterStep: nghỉ SAU khi lệnh hiện tại xong (không cắt giữa dòng).
export type StopKind = 'none' | 'interrupt' | 'pause-after-step';

export class RunStopController {
  private requested: StopKind = 'none';

  /** Người dùng bấm "Ngừng ngay". */
  requestInterrupt(): void {
    this.requested = 'interrupt';
  }

  /** Người dùng bấm "Nghỉ sau lệnh hiện tại". */
  requestPauseAfterStep(): void {
    if (this.requested === 'interrupt') return; // interrupt thắng pause
    this.requested = 'pause-after-step';
  }

  get kind(): StopKind {
    return this.requested;
  }

  get interrupted(): boolean {
    return this.requested === 'interrupt';
  }

  /**
   * Consumer gọi ĐẦU mỗi bước: true = phải dừng ngay (interrupt). Called
   * once — sau khi trả true, trạng thái được tiêu.
   */
  consumeInterrupt(): boolean {
    if (this.requested !== 'interrupt') return false;
    this.requested = 'none';
    return true;
  }

  /**
   * Consumer gọi CUỐI mỗi bước: true = hết lệnh này thì nghỉ.
   * pause chỉ ăn MỘT lần (đã nghỉ thì reset).
   */
  shouldPauseAfterStep(): boolean {
    if (this.requested !== 'pause-after-step') return false;
    this.requested = 'none';
    return true;
  }

  reset(): void {
    this.requested = 'none';
  }
}
