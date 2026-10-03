// v1.2.0-demo2 P3.4 (Điểm 2): vòng verify lint → test có trần.
//
// Nguồn ý tưởng: `refer_project/ai-tools/aider` (Apache-2.0) —
//   aider/coders/base_coder.py (auto_lint → auto_test, max_reflections = 3).
//
// Trước demo2, GHITA sửa file xong không kiểm tra gì — code hỏng vẫn được
// tính là xong. Điều mình giữ nguyên từ aider, và là phần quan trọng nhất:
//   Hết số lượt thử thì DỪNG LẠI HỎI NGƯỜI DÙNG, không tự đoán tiếp.
//
// Thứ tự lint → test là cố ý: lint rẻ và bắt lỗi cú pháp, chạy test khi đó
// là tốn thời gian vô ích.

export interface CheckResult {
  name: string;
  passed: boolean;
  /** Output của lệnh — đưa thẳng vào lượt tiếp theo để agent biết sửa gì. */
  output: string;
}

export interface VerifyCheck {
  name: string;
  run: () => Promise<CheckResult>;
}

export interface VerifyOptions {
  /** Các bước kiểm tra, chạy THEO THỨ TỰ và dừng ở bước đầu tiên fail. */
  checks: VerifyCheck[];
  /** Số lượt được phép thử lại trước khi hỏi người dùng. Mặc định 3 (như aider). */
  maxReflections?: number;
}

export type VerifyDecision = 'accept' | 'retry' | 'escalate';

export interface VerifyOutcome {
  decision: VerifyDecision;
  /** Có bước nào fail không. */
  failedCheck?: string;
  /** Lời nhắc đưa cho agent ở lượt kế tiếp. */
  reflectionMessage?: string;
  /** Khi escalate: điều cần hỏi người dùng. */
  escalationMessage?: string;
  /** Các bước đã chạy. */
  ran: string[];
}

const DEFAULT_MAX_REFLECTIONS = 3;

export class VerifyLoop {
  private reflections = 0;

  private readonly maxReflections: number;

  constructor(private readonly options: VerifyOptions) {
    this.maxReflections = options.maxReflections ?? DEFAULT_MAX_REFLECTIONS;
  }

  get reflectionsUsed(): number {
    return this.reflections;
  }

  /** Chạy một vòng kiểm tra. Không bao giờ ném. */
  async verify(): Promise<VerifyOutcome> {
    const ran: string[] = [];

    for (const check of this.options.checks) {
      ran.push(check.name);

      let result: CheckResult;
      try {
        result = await check.run();
      } catch (err) {
        // Lệnh tự sập KHÔNG được coi là pass — coi như fail với nguyên nhân.
        result = {
          name: check.name,
          passed: false,
          output: err instanceof Error ? err.message : String(err),
        };
      }

      if (result.passed) continue;

      return this.onFailure(result, ran);
    }

    return { decision: 'accept', ran };
  }

  private onFailure(result: CheckResult, ran: string[]): VerifyOutcome {
    this.reflections++;

    if (this.reflections > this.maxReflections) {
      return {
        decision: 'escalate',
        failedCheck: result.name,
        ran,
        escalationMessage:
          `Đã thử sửa ${this.reflections - 1} lượt nhưng bước "${result.name}" vẫn hỏng. ` +
          `Thay vì đoán tiếp, cần hỏi người dùng xem nên làm gì. ` +
          `Kết quả cuối:\n${result.output}`,
      };
    }

    return {
      decision: 'retry',
      failedCheck: result.name,
      ran,
      reflectionMessage:
        `Bước kiểm tra "${result.name}" chưa đạt. Sửa lại rồi thử, ` +
        `(đã dùng ${this.reflections}/${this.maxReflections} lượt thử lại).\n` +
        `Chi tiết:\n${result.output}`,
    };
  }
}
