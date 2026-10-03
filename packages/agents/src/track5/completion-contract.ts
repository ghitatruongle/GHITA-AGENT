// v1.2.0-demo2 P3.5 (Điểm 9 + 10): hợp đồng hoàn thành có bằng chứng, và
// bắt buộc subagent nộp bản kê file đã đọc.
//
// Nguồn ý tưởng: `refer_project/ai-core/claude-code` — PROPRIETARY.
// Chỉ học ý tưởng kiến trúc, TỰ VIẾT LẠI hoàn toàn, không sao chép văn bản.
//
// Vấn đề GHITA trước demo2: agent tự tuyên bố "xong" mà không kèm bằng chứng,
// và subagent đọc file xong không để lại danh sách — nên agent chính hành
// động theo trí nhớ mù, sửa nhầm file. Hai điểm này chặn đúng hai lỗi đó.

/** Bằng chứng bắt buộc kèm khi agent tuyên bố hoàn thành. */
export interface TaskDoneEvidence {
  /** Lệnh kiểm tra đã chạy, ví dụ `pnpm test`. */
  command?: string;
  /** Mã thoát (0 = pass). */
  exitCode?: number;
  /** Các file đã thay đổi. */
  changedFiles?: string[];
  /** Mô tả ngắn đã làm gì. */
  summary?: string;
}

export interface TaskDoneSignal {
  /** Agent tự tin làm xong. */
  done: boolean;
  evidence: TaskDoneEvidence;
}

const TASK_DONE_RE = /<task-done(?:\s[^>]*)?>([\s\S]*?)<\/task-done>/;

/**
 * Bỏ dấu để so khớp tiếng Việt không cần liệt kê mọi biến thể.
 * Riêng `đ` là chữ riêng, không phải dấu phủ — NFD không tách được, nên phải
 * thay tay (Đã → da, không phải đa).
 */
function deaccent(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/**
 * Lời tuyên bố "xong" trần, cả tiếng Việt lẫn tiếng Anh.
 * So trên bản đã bỏ dấu: "Đã hoàn thành", "Xong rồi", "Hoàn tất" rơi vào cùng
 * một nhóm thay vì phải liệt kê từng biến thể có dấu.
 */
const FALSE_DONE_HINTS = [
  /^(da\s+)?(xong|hoan thanh|hoan tat|hoan xong)(\s+roi)?\s*[.!]?$/,
  /^(done|finished|complete|completed)\s*[.!]?$/,
];

/**
 * Bóc tín hiệu `<task-done>` ra khỏi câu trả lời của agent.
 *
 * Bền vững với lỗi hay gặp:
 *   • agent dán nguyên khối XML vào giữa văn bản
 *   • thuộc tính viết bằng chữ hoa (`<TASK-DONE>`)
 *   • dùng dấu gạch chéo ngược trong PowerShell
 */
export function parseTaskDone(text: string): TaskDoneSignal | null {
  const re = new RegExp(TASK_DONE_RE.source, 'gi');
  const m = re.exec(text);
  if (!m) return null;

  const body = (m[1] ?? '').trim();
  if (!body) return { done: true, evidence: {} };

  // JSON nằm trong thẻ là dạng phổ biến nhất; không parse được thì coi như
  // lời tuyên bố trần — KHÔNG tự bịa bằng chứng.
  const evidence: TaskDoneEvidence = {};
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.command === 'string') evidence.command = parsed.command;
    if (typeof parsed.exitCode === 'number') evidence.exitCode = parsed.exitCode;
    if (Array.isArray(parsed.changedFiles)) {
      evidence.changedFiles = parsed.changedFiles.filter((f): f is string => typeof f === 'string');
    }
    if (typeof parsed.summary === 'string') evidence.summary = parsed.summary;
    return { done: true, evidence };
  } catch {
    evidence.summary = body;
    return { done: true, evidence };
  }
}

/**
 * Lời tuyên bố xong KHÔNG kèm bằng chứng — tức là "tự suy" rồi.
 *
 * Bỏ ký tự trang trí ở đầu (emoji, bullet) trước khi so: agent hay viết
 * "🎉 Xong!" hoặc "✅ Hoàn thành", và đó vẫn là lời tuyên bố xong trần.
 */
export function detectFalseDone(text: string): boolean {
  if (parseTaskDone(text)) return false;
  const normalized = deaccent(text.trim().replace(/^[^\p{L}\p{N}]+/u, ''));
  return FALSE_DONE_HINTS.some((re) => re.test(normalized));
}

/**
 * Cổng chặn: agent được phép kết thúc lượt chạy chỉ khi tuyên bố xong KÈM
 * bằng chứng, hoặc khi đã hết số lượt cho phép.
 */
export class CompletionGate {
  private reflections = 0;

  constructor(
    private readonly maxReflections = 3,
    private readonly requireEvidence = true,
  ) {}

  get reflectionsUsed(): number {
    return this.reflections;
  }

  /**
   * Quyết định một lượt chạy. Trả `accept` khi được kết thúc, `reflect` khi
   * cần bắt agent làm lại kèm lý do, `escalate` khi hết lượt.
   */
  evaluate(text: string): {
    decision: 'accept' | 'reflect' | 'escalate';
    signal: TaskDoneSignal | null;
    reason?: string;
  } {
    const signal = parseTaskDone(text);
    if (signal) {
      // exitCode KHÁC 0 là bằng chứng kiểm tra THẤT BẠI — không được tính như
      // "đã chạy lệnh" để chấp nhận xong, nếu không gate tự đánh mất mục đích
      // của chính nó ngay với kiểu gian lận phổ biến nhất: nộp lệnh vừa fail.
      const hasEvidence =
        !this.requireEvidence ||
        signal.evidence.exitCode === 0 ||
        (signal.evidence.changedFiles?.length ?? 0) > 0;

      if (hasEvidence) return { decision: 'accept', signal };

      this.reflections++;
      if (this.reflections > this.maxReflections) {
        return {
          decision: 'escalate',
          signal,
          reason: 'Agent tuyên bố xong nhưng không kèm bằng chứng, đã hết số lượt thử lại.',
        };
      }
      const failedCheck = signal.evidence.exitCode !== undefined && signal.evidence.exitCode !== 0;
      return {
        decision: 'reflect',
        signal,
        reason: failedCheck
          ? `Lệnh kiểm tra THẤT BẠI (exitCode ${signal.evidence.exitCode}) — hãy sửa lỗi rồi gửi lại <task-done> kèm exitCode 0.`
          : 'Cần bằng chứng: chạy lệnh kiểm tra và gửi <task-done> kèm command + exitCode.',
      };
    }

    if (detectFalseDone(text)) {
      this.reflections++;
      if (this.reflections > this.maxReflections) {
        return {
          decision: 'escalate',
          signal: null,
          reason: 'Agent nhiều lần nói "xong" mà không kèm bằng chứng.',
        };
      }
      return {
        decision: 'reflect',
        signal: null,
        reason: 'Vừa nói "xong" nhưng không có bằng chứng. Hãy chạy kiểm tra rồi gửi <task-done>.',
      };
    }

    return { decision: 'accept', signal: null };
  }
}

// --------------------------------------------------------- Điểm 10 --------

/** Bản kê bắt buộc của một subagent chỉ đọc. */
export interface EvidenceManifest {
  /** Các file agent chính NÊN đọc lại trước khi hành động. */
  filesToRead: string[];
  /** Kết luận rút ra, ngắn gọn. */
  findings: string[];
}

/** Phát hiện subagent không nộp bản kê. */
export function isManifestComplete(
  manifest: Partial<EvidenceManifest> | null | undefined,
): boolean {
  if (!manifest) return false;
  const files = manifest.filesToRead;
  const findings = manifest.findings;
  return Array.isArray(files) && files.length > 0 && Array.isArray(findings) && findings.length > 0;
}

/** Bắt agent chính phải mở lại đúng những file subagent nêu. */
export function pendingReads(
  manifest: EvidenceManifest,
  alreadyRead: ReadonlySet<string>,
): string[] {
  return manifest.filesToRead.filter((f) => !alreadyRead.has(f));
}

/** Kiểm tra tỉ lệ file bị sửa nằm ngoài bản kê — chỉ số chính của Điểm 10. */
export function outOfManifestEditRate(manifest: EvidenceManifest, editedFiles: string[]): number {
  if (editedFiles.length === 0) return 0;
  const allowed = new Set(manifest.filesToRead);
  const outside = editedFiles.filter((f) => !allowed.has(f));
  return outside.length / editedFiles.length;
}
