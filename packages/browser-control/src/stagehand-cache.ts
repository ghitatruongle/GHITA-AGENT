// v1.2.0-demo2 P3.1 (Điểm 3): cache best-effort cho các lời gọi LLM của
// AIPageController (observe / act / extract).
//
// Nguồn ý tưởng: `refer_project/browser/stagehand` (MIT) — cacheService.ts.
//
// Ba nguyên tắc bắt buộc, học thẳng từ đó:
//   1. Hit → replay deterministic, KHÔNG gọi LLM.
//   2. Mọi lỗi của cache đều bị nuốt và rơi về đường LLM thật. Cache chỉ là
//      tối ưu, không bao giờ được làm hỏng hành động.
//   3. Chỉ cache kết quả THÀNH CÔNG — lỗi thì phải thử lại được.
//
// Cache key chỉ gồm *prompt*. Prompt của resolveSelectorByIntent đã chứa sẵn
// câu lệnh + toàn bộ cây phần tử của trang (xem ai-browser.ts), nên đổi nội
// dung trang là đổi key — đúng như mong muốn. Model KHÔNG nằm trong prompt nên
// đổi model không vô hiệu cache, cũng đúng như stagehand làm.
//
// GHI CHÚ: `track7/act-cache.ts` đã có sẵn một bản cache cùng mục đích (SQLite,
// TTL, khoá theo intent+URL+DOM signature) nhưng KHÔNG được nối vào đâu cả.
// Hai bản nên gộp ở mốc sau — xem docs/research-demo2-10-points.md.

/** Kiểu hàm LLM mà AIPageController dùng (khớp AIBrowserContext.llm). */
import { createHash } from 'node:crypto';

export type LlmFn = (
  prompt: string,
  opts?: { json?: boolean; maxTokens?: number },
) => Promise<string>;

/** Tuỳ chọn khi bọc cache quanh một hàm LLM. */
export interface WrapOptions {
  /** Quyết định kết quả có đáng cache không. Mặc định: loại rỗng + lời từ chối. */
  validate?: (result: string) => boolean;
}

/** Mấu lời từ chối hay gặp — không được phát lại như một câu trả lời thật. */
const REFUSAL_PATTERNS = [
  /i can(?:'|no)t help with that/i,
  /i cannot assist/i,
  /i'm (?:sorry|unable) (?:but )?i/i,
  /^sorry[,! ]/i,
];

function defaultValidate(result: string): boolean {
  const trimmed = result.trim();
  if (!trimmed) return false;
  return !REFUSAL_PATTERNS.some((re) => re.test(trimmed));
}

export interface AIPageCacheStats {
  /** Số lần trả từ cache, không gọi LLM. */
  hits: number;
  /** Số lần phải gọi LLM. */
  misses: number;
  /** Số lần cache tự hỏng và bị bỏ qua (best-effort). */
  errors: number;
  /** Số lần có kết quả nhưng bị từ chối cache (rỗng / lời từ chối). */
  rejected: number;
}

const DEFAULT_MAX_ENTRIES = 500;

/**
 * SHA-256 của prompt.
 *
 * Cố ý dùng `node:crypto` chứ không phải hash tự chế: một VA CHẠM ở đây
 * không chỉ làm hỏng cache mà còn trả về selector của trang KHÁC — tức là
 * click nhầm phần tử. Với cache của hành động trình duyệt thì hậu quả đó
 * không chấp nhận được bằng "xác suất thấp".
 *
 * `browser-control` chạy ở Node (Electron/Tauri main, Playwright, node-pty)
 * nên `node:crypto` luôn sẵn có — cùng cách `track7/act-cache.ts` đã làm.
 */
function cacheKeyFor(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 32);
}

export class AIPageCache {
  readonly stats: AIPageCacheStats = { hits: 0, misses: 0, errors: 0, rejected: 0 };

  private map = new Map<string, string>();

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  /** Số mục đang cache (để test + chẩn đoán). */
  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  /**
   * Bọc một hàm LLM thành bản có cache.
   *
   * `validate` cho biết kết quả có dùng lại được không. Mặc định chỉ chấp
   * nhận câu trả lời **không rỗng và không phải lời từ chối** — vì cache lời
   * từ chối thì câu đó sống tới khi bị 500 mục khác đẩy ra, và LLM vốn đã có
   * thể trả lời đúng ở lượt sau. Với `aiExtract` thì đây là **dữ liệu trích
   * xuất sai được phát lại vĩnh viễn**.
   */
  wrap(llm: LlmFn, options: WrapOptions = {}): LlmFn {
    const validate = options.validate ?? defaultValidate;
    return async (prompt, opts) => {
      // `opts` phải nằm trong key: cùng một prompt nhưng khác `json`/`maxTokens`
      // cho ra kết quả khác nhau, gộp chung là trả nhầm.
      const key = cacheKeyFor(
        opts ? `${opts.json ? 1 : 0}|${opts.maxTokens ?? ''}|${prompt}` : prompt,
      );

      try {
        const hit = this.map.get(key);
        if (hit !== undefined) {
          this.stats.hits++;
          return hit;
        }
      } catch {
        // Cache hỏng → bỏ qua, đi tiếp bằng LLM thật.
        this.stats.errors++;
      }

      this.stats.misses++;
      const result = await llm(prompt, opts);

      if (validate(result)) {
        try {
          this.set(key, result);
        } catch {
          // Không ghi được cache cũng không sao — kết quả vẫn trả về bình thường.
          this.stats.errors++;
        }
      } else {
        this.stats.rejected++;
      }
      return result;
    };
  }

  /** Ghi vào cache, tự loại bỏ mục cũ nhất khi vượt trần. */
  private set(key: string, value: string): void {
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }
}
