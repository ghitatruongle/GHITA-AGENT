// v1.2.0-demo2 P3.3 (Điểm 6): gom context từ nhiều nguồn, mỗi nguồn một vùng
// try/catch riêng, rồi dedup theo vùng dòng.
//
// Nguồn ý tưởng: `refer_project/ai-tools/continue` (Apache-2.0) —
//   core/context/retrieval/pipelines/BaseRetrievalPipeline.ts và
//   core/context/retrieval/util.ts (deduplicateChunks).
//
// Vì sao cách ly lỗi là điều khoản số một: nguồn embedding hay chết vì hết
// hạn mức, nhưng nguồn full-text vẫn chạy tốt. Nếu gộp chung một try/catch thì
// MỘT nguồn chết kéo theo mất sạch ngữ cảnh — người dùng thấy agent "mất
// trí nhớ" một cách vô lý.

export interface ContextChunk {
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
  /** Nguồn đã sinh ra chunk, để truy vết khi debug. */
  source: string;
}

export interface ContextProvider {
  name: string;
  load: () => Promise<ContextChunk[]>;
}

export interface FanOutOptions {
  /** Trần chunk cho MỘT nguồn, để nguồn ồn không chiếm hết chỗ. */
  maxChunksPerProvider?: number;
}

export interface FanOutFailure {
  name: string;
  error: string;
}

export interface FanOutResult {
  chunks: ContextChunk[];
  healthy: string[];
  failed: FanOutFailure[];
  /** Nguồn bị cắt bớt vì vượt trần. */
  truncated: string[];
}

const DEFAULT_MAX_PER_PROVIDER = 20;

/** Gọi mọi nguồn; nguồn chết chỉ chết một mình nó. */
export async function fanOutProviders(
  providers: ContextProvider[],
  options: FanOutOptions = {},
): Promise<FanOutResult> {
  const max = options.maxChunksPerProvider ?? DEFAULT_MAX_PER_PROVIDER;

  // Promise.allSettled thay vì Promise.all: một nguồn reject không được
  // làm hỏng kết quả của các nguồn còn lại. Bọc `async` quanh load() để cả
  // lỗi ném ĐỒNG BỘ (sync throw) cũng thành rejection bị bắt, không thoát ra
  // ngoài trước khi allSettled kịp can thiệp.
  const settled = await Promise.allSettled(providers.map(async (p) => p.load()));

  const chunks: ContextChunk[] = [];
  const healthy: string[] = [];
  const failed: FanOutFailure[] = [];
  const truncated: string[] = [];

  settled.forEach((outcome, i) => {
    const provider = providers[i];
    if (!provider) return;
    if (outcome.status === 'rejected') {
      failed.push({
        name: provider.name,
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
      return;
    }
    const loaded = outcome.value;
    // Nguồn trả về thứ không phải mảng (undefined, object...) là nguồn hỏng —
    // đọc .length trên nó sẽ ném và làm mất kết quả của cả lượt fan-out.
    if (!Array.isArray(loaded)) {
      failed.push({
        name: provider.name,
        error: `load() phải trả về mảng chunk, nhận được: ${typeof loaded}`,
      });
      return;
    }
    healthy.push(provider.name);
    if (loaded.length > max) {
      truncated.push(provider.name);
      for (const c of loaded.slice(0, max)) chunks.push({ ...c, source: provider.name });
    } else {
      for (const c of loaded) chunks.push({ ...c, source: provider.name });
    }
  });

  return { chunks, healthy, failed, truncated };
}

/**
 * Bỏ chunk trùng theo (filePath, startLine, endLine).
 *
 * Cố ý KHÔNG gộp các vùng dòng lồng nhau: vùng 1–30 và 10–20 là hai lần đọc
 * khác nhau về cùng một file, gộp lại sẽ mất bối cảnh.
 */
export function deduplicateChunks(chunks: readonly ContextChunk[]): ContextChunk[] {
  const seen = new Set<string>();
  const out: ContextChunk[] = [];
  for (const c of chunks) {
    const key = `${c.filePath}:${c.startLine}:${c.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
