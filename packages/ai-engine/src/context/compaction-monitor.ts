// v1.2.0-demo2 P3.2 (Điểm 7): biến compaction thành sự kiện có thể đo, và đo
// cả CHẤT LƯỢNG nén chứ không chỉ số token.
//
// Nguồn ý tưởng: `refer_project/ai-core/openhands` (MIT) —
//   src/hooks/use-await-context-compaction.ts
//
// Vì sao cần đo chất lượng: xét số thật ở P2.2 trên transcript 176.300 token —
//   summary giảm 99%, trajectory (mặc định) giảm 49%.
// Nhìn số đó thì `summary` thắng áp đảo. Nhưng nén triệt để có thể là ném bỏ
// thông tin, và khi đó số token đẹp lên trong khi agent mất ngữ cảnh — hỏng
// âm thầm, khó phát hiện. Vì vậy mỗi lần nén đều kèm `retention`: bao nhiêu
// định danh quan trọng (đường dẫn, tên hàm) còn sống sót.

import type { ChatMessage } from '../types.js';
import type { ContextManager } from './manager.js';

/** Bốn trạng thái của một lần nén. */
export type CompactionOutcome = 'not_needed' | 'compacted' | 'no_change' | 'timeout';

export interface CompactionReport {
  outcome: CompactionOutcome;
  /** Chiến lược đã dùng. */
  strategy: string;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  reductionPct: number;
  messagesBefore: number;
  messagesAfter: number;
  durationMs: number;
  /** Tỉ lệ định danh quan trọng còn giữ lại, 0..1. */
  retention: number;
  markersTotal: number;
  markersKept: number;
}

export interface CompactionMonitorOptions {
  /** Ngân sách thời gian cho một lần nén. Vượt ngân sách thì báo `timeout`. */
  timeoutMs?: number;
  /** Nhận mỗi báo cáo — đẩy lên UI/telemetry. */
  onReport?: (report: CompactionReport) => void;
  now?: () => number;
}

// Đường dẫn file: src/a.ts, packages/x/y.rs, ./rel/path.json
// Dùng `\W` thay vì liệt kê ký tự phân tách: ngắn hơn, và khỏi vướng chuyện
// escape `[` trong character class.
const PATH_RE = /(?:^|\W)((?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w-]+\.[A-Za-z]{1,6})\b/g;
// Tên hàm/biến: computeTotal(), fixBug, snake_case_thing
const IDENT_RE = /(?:^|\W)((?:[a-z][\w]*\.)+[A-Za-z]\w*|[a-z]+(?:[A-Z][\w]*)+)\s*(?=\()/g;

/**
 * Trích các định danh "then chốt" khỏi hội thoại: đường dẫn file và tên hàm.
 * Đây là thứ mà khi mất đi thì agent không còn biết đang sửa cái gì.
 */
export function extractKeyMarkers(messages: readonly ChatMessage[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    const text = m.content ?? '';
    for (const re of [PATH_RE, IDENT_RE]) {
      re.lastIndex = 0;
      let m2: RegExpExecArray | null;
      while ((m2 = re.exec(text)) !== null) {
        const value = m2[1];
        if (value) out.add(value);
      }
    }
  }
  return out;
}

export interface Retention {
  ratio: number;
  total: number;
  kept: number;
}

/** Đo phần định danh quan trọng còn giữ lại sau khi nén. */
export function measureRetention(
  before: readonly ChatMessage[],
  after: readonly ChatMessage[],
): Retention {
  const all = extractKeyMarkers(before);
  if (all.size === 0) return { ratio: 1, total: 0, kept: 0 };

  const surviving = extractKeyMarkers(after);
  let kept = 0;
  for (const marker of all) if (surviving.has(marker)) kept++;

  return { ratio: kept / all.size, total: all.size, kept };
}

/**
 * Bọc ContextManager, biến `compact()` đen khuất thành báo cáo đo được.
 *
 * Cố ý KHÔNG đổi chiến lược mặc định. Bảng đo ở P2.2 cho thấy `summary` giảm
 * token nhiều hơn, nhưng chất lượng thì chưa được chứng minh — đổi mặc định
 * khi chưa có bằng chứng là rủi ro, không phải tối ưu.
 */
export class CompactionMonitor {
  private readonly counts: Record<CompactionOutcome, number> = {
    not_needed: 0,
    compacted: 0,
    no_change: 0,
    timeout: 0,
  };

  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly onReport: ((r: CompactionReport) => void) | undefined;

  constructor(
    private readonly manager: ContextManager,
    options: CompactionMonitorOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? (() => Date.now());
    this.onReport = options.onReport;
  }

  get stats(): Record<CompactionOutcome, number> & { total: number } {
    return {
      ...this.counts,
      total:
        this.counts.not_needed +
        this.counts.compacted +
        this.counts.no_change +
        this.counts.timeout,
    };
  }

  /** Chạy một lượt nén và trả về báo cáo. Không bao giờ ném. */
  run(messages: ChatMessage[]): CompactionReport {
    const started = this.now();
    const strategy = this.manager.getConfig().strategy;
    const tokensBefore = this.manager.estimateTokens(messages);

    const base = {
      strategy,
      tokensBefore,
      tokensAfter: tokensBefore,
      tokensSaved: 0,
      reductionPct: 0,
      messagesBefore: messages.length,
      messagesAfter: messages.length,
      durationMs: 0,
      retention: 1,
      markersTotal: 0,
      markersKept: 0,
    };

    if (!this.manager.needsCompact(messages)) {
      return this.emit({ ...base, outcome: 'not_needed' });
    }

    let compacted: ChatMessage[];
    try {
      compacted = this.manager.compact(messages);
    } catch (err) {
      // Nén hỏng thì báo đúng nguyên nhân, không giả vờ là thành công.
      return this.emit({
        ...base,
        outcome: 'no_change',
        durationMs: this.now() - started,
        error: err instanceof Error ? err.message : String(err),
      } as CompactionReport);
    }

    const durationMs = this.now() - started;
    if (durationMs > this.timeoutMs) {
      return this.emit({ ...base, outcome: 'timeout', durationMs });
    }

    const tokensAfter = this.manager.estimateTokens(compacted);
    const saved = tokensBefore - tokensAfter;
    const retention = measureRetention(messages, compacted);

    if (saved <= 0) {
      return this.emit({
        ...base,
        outcome: 'no_change',
        messagesAfter: compacted.length,
        durationMs,
        retention: retention.ratio,
        markersTotal: retention.total,
        markersKept: retention.kept,
      });
    }

    return this.emit({
      outcome: 'compacted',
      strategy,
      tokensBefore,
      tokensAfter,
      tokensSaved: saved,
      reductionPct: Math.round((saved / tokensBefore) * 100),
      messagesBefore: messages.length,
      messagesAfter: compacted.length,
      durationMs,
      retention: retention.ratio,
      markersTotal: retention.total,
      markersKept: retention.kept,
    });
  }

  private emit(report: CompactionReport): CompactionReport {
    this.counts[report.outcome]++;
    try {
      this.onReport?.(report);
    } catch {
      // Telemetry hỏng không được làm hỏng luồng chat.
    }
    return report;
  }
}
