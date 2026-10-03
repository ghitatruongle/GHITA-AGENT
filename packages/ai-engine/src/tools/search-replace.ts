// v1.2.0-demo2 P3.4 (Điểm 1): tool edit dạng SEARCH/REPLACE.
//
// Nguồn ý tưởng: `refer_project/ai-tools/aider` (Apache-2.0) —
//   aider/coders/editblock_coder.py: prep() → perfect_or_whitespace() →
//   try_dotdotdots() → replace_most_similar_chunk()
//
// Trước demo2, GHITA chỉ có `replaceFileContent()` khớp CHÍNH XÁC: model lệch
// một dòng trắng đầu là hỏng, và lỗi trả về không nói được khối nào hỏng —
// model phải đoán rồi thử lại từ đầu.
//
// Ba nguyên tắc mình giữ lại:
//   1. Thử dần từ chính xác tới mơ hồ, dừng ở mức khớp đầu tiên.
//   2. Nguyên tử: soạn hết rồi mới ghi. Hỏng khối nào thì file giữ nguyên.
//   3. Lỗi phải HÀNH ĐỘNG ĐƯỢC: nói khối nào hỏng, kèm dòng gần nhất trong file.

import { readFileSync, writeFileSync } from 'node:fs';
import { ensureInSandbox } from './workspace-tools.js';

export type MatchStrategy = 'exact' | 'strip-whitespace' | 'strip-blank-first-line' | 'ellipsis';

export interface SearchMatch {
  /** Đoạn thực sự nằm trong file. */
  text: string;
  strategy: MatchStrategy;
}

/** Một khối edit của model. */
export interface EditBlock {
  search: string;
  replace: string;
}

export type EditOutcome = 'all-applied' | 'partial' | 'none-applied';

export interface BlockOutcome {
  /** Vị trí trong mảng edits, bắt đầu từ 1 để khớp với cách gọi "#1, #2". */
  index: number;
  applied: boolean;
  strategy?: MatchStrategy;
  error?: string;
}

export interface EditResult {
  outcome: EditOutcome;
  content: string;
  applied: number;
  failed: number;
  blocks: BlockOutcome[];
  /** Thông điệp lỗi đã sẵn sàng đưa thẳng cho model đọc. */
  error?: string;
}

/** Nội dung dùng dấu "..." để lược bỏ phần không nhớ chính xác. */
function hasEllipsis(text: string): boolean {
  return text
    .split('\n')
    .some((l) => l.trim() === '...' || l.trim() === '…' || l.trimStart().startsWith('... '));
}

/** Mở rộng "..." thành phần còn thiếu từ nội dung gốc. */
function expandEllipsis(fileContent: string, search: string): string | null {
  const lines = fileContent.split('\n');
  const head = search.split('\n')[0] ?? '';
  const tail = search.split('\n').at(-1) ?? '';
  const headIdx = lines.findIndex((l) => l.trim() === head.trim());
  if (headIdx === -1) return null;
  const tailIdx =
    tail && tail !== head ? lines.findIndex((l) => l.trim() === tail.trim()) : headIdx;
  // Đuôi nằm TRƯỚC đầu (khối lệch/ngược) → slice sẽ ra chuỗi rỗng, mà chuỗi
  // rỗng khớp MỌI nơi và làm treo vòng đếm ở dưới — phải từ chối.
  if (tailIdx === -1 || tailIdx < headIdx) return null;
  const expanded = lines.slice(headIdx, tailIdx + 1).join('\n');
  return expanded || null;
}

/** Có khớp bỏ khoảng trắng thụt đầu không (giữ nguyên phần còn lại). */
function stripLeadingWhitespaceMatch(content: string, search: string): string | null {
  const needle = search
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
  if (!needle) return null;

  for (let i = 0; i < content.length; i++) {
    if (content.startsWith(needle, i)) {
      // Nới rộng về đầu dòng để lấy đúng khoảng trắng thật của file.
      let start = i;
      while (start > 0 && content[start - 1] !== '\n') start--;
      let end = i + needle.length;
      while (end < content.length && content[end] !== '\n') end++;
      return content.slice(start, end);
    }
  }
  return null;
}

/** Bỏ dòng trống ở đầu mẫu tìm kiếm (hay gặp khi model chép lại khối). */
function stripBlankFirstLineMatch(content: string, search: string): string | null {
  const stripped = search.replace(/^\s*\n/, '');
  if (stripped === search) return null;
  return matchSearch(content, stripped)?.text ?? null;
}

/**
 * Nới một vị trí khớp ra thành dòng trọn vẹn, giữ nguyên thụt đầu của file.
 * Bỏ khoảng trắng bao quanh trước khi nới, nếu không mẫu bắt đầu bằng `\n`
 * sẽ nuốt luôn dòng trước đó.
 */
function expandToWholeLines(content: string, at: number, len: number): string {
  // Chỉ bỏ khoảng trắng ở ĐẦU. Nếu bỏ cả ở CUỐI thì mẫu kết thúc bằng `\n`
  // (trường hợp xoá cả dòng) sẽ mất dấu xuống dòng và để lại dòng trống.
  let head = at;
  while (head < at + len && /\s/.test(content[head] ?? '')) head++;

  let start = head;
  while (start > 0 && content[start - 1] !== '\n') start--;

  // Mẫu đã kết thúc bằng newline thì dừng đúng ở đó, KHÔNG nới sang dòng kế.
  if (len > 0 && content[at + len - 1] === '\n') {
    return content.slice(start, at + len);
  }

  let end = at + len;
  while (end < content.length && content[end] !== '\n') end++;

  return content.slice(start, end);
}

/** Khớp có nằm ngay đầu dòng không (hoặc ở đầy đủ nhiều dòng). */
function isLineAligned(content: string, at: number, len: number): boolean {
  const startsLine = at === 0 || content[at - 1] === '\n';
  const endsLine = at + len === content.length || content[at + len] === '\n';
  return startsLine && endsLine;
}

/**
 * Tìm mẫu trong nội dung, thử dần từ chính xác tới mơ hồ.
 * Trả `null` nếu không khớp — KHÔNG đoán bừa, vì thay nhầm còn tệ hơn không thay.
 */
export function matchSearch(content: string, search: string): SearchMatch | null {
  // 1. Khớp thẳng. Nếu nó nằm giữa dòng (model quên thụt đầu) thì nới ra
  //    cả dòng để giữ nguyên thụt đầu của file khi thay. Ưu tiên chỗ khớp
  //    TRỌN DÒNG; chỗ khớp giữa token (vd "xreturn") là chỗ sai — nới ra cả
  //    dòng sẽ xoá nhầm định danh, nên chỉ dùng khi không còn lựa chọn nào.
  if (content.includes(search)) {
    let aligned = -1;
    let plain = -1;
    for (let i = content.indexOf(search); i !== -1; i = content.indexOf(search, i + 1)) {
      if (aligned === -1 && isLineAligned(content, i, search.length)) aligned = i;
      const midToken = i > 0 && /[A-Za-z0-9_$]/.test(content[i - 1] ?? '');
      if (plain === -1 && !midToken) plain = i;
    }
    const at = aligned !== -1 ? aligned : plain !== -1 ? plain : content.indexOf(search);
    if (isLineAligned(content, at, search.length)) {
      return { text: search, strategy: 'exact' };
    }
    return { text: expandToWholeLines(content, at, search.length), strategy: 'strip-whitespace' };
  }

  // 2. Dấu "..." — model nhớ đại ý nhưng quên các dòng ở giữa.
  if (hasEllipsis(search)) {
    const expanded = expandEllipsis(content, search);
    if (expanded !== null && content.includes(expanded)) {
      return { text: expanded, strategy: 'ellipsis' };
    }
  }

  // 3. Thừa dòng trống ở đầu mẫu.
  const noBlank = stripBlankFirstLineMatch(content, search);
  if (noBlank) {
    return { text: noBlank, strategy: 'strip-blank-first-line' };
  }

  // 4. Lệch thụt đầu dòng.
  const noIndent = stripLeadingWhitespaceMatch(content, search);
  if (noIndent) return { text: noIndent, strategy: 'strip-whitespace' };

  return null;
}

/**
 * Vài dòng quanh vị trí hỏng, để model biết mình đang ở đâu.
 * Thử TỪNG dòng của khối tìm kiếm — khối hỏng thường chỉ sai một dòng, các
 * dòng còn lại vẫn chỉ đúng vị trí cần sửa.
 */
function nearbyExcerpt(content: string, search: string, radius = 4): string {
  const lines = content.split('\n');
  const needles = search
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 6);

  for (const needle of needles) {
    const idx = lines.findIndex((l) => l.trim() === needle);
    if (idx !== -1) {
      const start = Math.max(0, idx - 1);
      return lines.slice(start, start + radius).join('\n');
    }
  }
  return lines.slice(0, radius).join('\n');
}

/** Số chỗ khớp — nếu > 1 thì thay sai chỗ là nguy hiểm. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0; // rỗng khớp mọi vị trí → coi như không tìm
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Áp dụng nhiều khối edit lên một chuỗi nội dung, KHÔNG ghi file.
 * Tuần tự: khối sau nhìn thấy kết quả của khối trước.
 */
export function applyEditBlocks(original: string, edits: EditBlock[]): EditResult {
  if (edits.length === 0) {
    return {
      outcome: 'none-applied',
      content: original,
      applied: 0,
      failed: 0,
      blocks: [],
      error: 'Không có khối edit nào.',
    };
  }

  // `search` rỗng khớp ở MỌI vị trí — dùng nó sẽ chèn bậy nội dung vào file.
  // Đây là trường hợp model sinh ra khi kết thúc thẻ bị cắt cụt, nên phải chặn.
  if (edits.some((e) => typeof e.search !== 'string' || e.search.trim() === '')) {
    return {
      outcome: 'none-applied',
      content: original,
      applied: 0,
      failed: edits.length,
      blocks: edits.map((_, i) => ({
        index: i + 1,
        applied: false,
        error: 'Nội dung cần tìm bị rỗng.',
      })),
      error:
        `Có khối edit có phần tìm kiếm rỗng. ` +
        `Mỗi khối phải có nội dung cụ thể để tìm trong file.`,
    };
  }

  let content = original;
  let applied = 0;
  const blocks: BlockOutcome[] = [];
  const failedIndexes: number[] = [];

  for (let i = 0; i < edits.length; i++) {
    const block = edits[i];
    if (!block) continue;
    const match = matchSearch(content, block.search);

    if (!match) {
      failedIndexes.push(i + 1);
      blocks.push({
        index: i + 1,
        applied: false,
        error: 'Không tìm thấy nội dung cần thay trong file.',
      });
      continue;
    }

    if (countOccurrences(content, match.text) > 1) {
      failedIndexes.push(i + 1);
      blocks.push({
        index: i + 1,
        applied: false,
        error: 'Nội dung này khớp nhiều chỗ trong file — không thể thay an toàn.',
      });
      continue;
    }

    // Dùng hàm thay thế thay vì chuỗi: nếu không, "$&", "$1", "$'"... trong
    // nội dung thay của model sẽ bị hiểu là mẫu thay và làm hỏng file.
    content = content.replace(match.text, () => block.replace);
    applied++;
    blocks.push({ index: i + 1, applied: true, strategy: match.strategy });
  }

  const failed = edits.length - applied;
  const outcome: EditOutcome =
    failed === 0 ? 'all-applied' : applied === 0 ? 'none-applied' : 'partial';

  let error: string | undefined;
  if (failed > 0) {
    const list = failedIndexes.map((n) => `#${n}`).join(', ');
    const reasons = blocks
      .filter((b) => !b.applied)
      .map((b) => `#${b.index}: ${b.error}`)
      .join('; ');
    const firstFailedAt = failedIndexes[0];
    const firstFailed = firstFailedAt === undefined ? undefined : edits[firstFailedAt - 1];
    const excerpt = firstFailed
      ? nearbyExcerpt(original, firstFailed.search)
      : '(không xác định được vị trí)';
    error =
      `Áp dụng ${applied}/${edits.length} khối. Khối hỏng: ${list}. ` +
      `Lý do — ${reasons}. ` +
      `Hãy gửi lại riêng ${list} với nội dung khớp chính xác với file. ` +
      `Gần vị trí đó, file đang có:\n${excerpt}`;
  }

  return { outcome, content, applied, failed, blocks, error };
}

/**
 * Áp dụng edit lên file thật. Nguyên tử: chỉ ghi khi mọi khối áp dụng được
 * hoặc người dùng chấp nhận kết quả một phần — mặc định KHÔNG ghi khi hỏng.
 */
export async function searchReplaceBatch(args: {
  filePath: string;
  edits: EditBlock[];
  /** Ghi file dù chỉ một phần khối áp dụng được. Mặc định false. */
  allowPartial?: boolean;
}): Promise<EditResult> {
  let fullPath: string;
  try {
    fullPath = ensureInSandbox(args.filePath);
  } catch (err) {
    // ensureInSandbox ném khi chưa chọn workspace hoặc đường dẫn nằm ngoài.
    // Đó là lỗi cấu hình, không phải lỗi nội dung — trả về gọn để agent đọc.
    return {
      outcome: 'none-applied',
      content: '',
      applied: 0,
      failed: args.edits.length,
      blocks: [],
      error: `Không mở được file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let original: string;
  try {
    original = readFileSync(fullPath, 'utf8');
  } catch {
    return {
      outcome: 'none-applied',
      content: '',
      applied: 0,
      failed: args.edits.length,
      blocks: [],
      error: `File không tồn tại: ${args.filePath}`,
    };
  }

  // Toàn bộ logic khớp làm việc trên LF; file CRLF (chuẩn Windows) được chuẩn
  // hoá trước và trả về đúng định dạng cũ khi ghi, tránh khớp hỏng lẫn ghi
  // lẫn lộn \r\n với \n.
  const hadCrlf = original.includes('\r\n');
  const normalized = hadCrlf ? original.replace(/\r\n/g, '\n') : original;

  const result = applyEditBlocks(normalized, args.edits);

  if (result.outcome === 'all-applied' || (result.outcome === 'partial' && args.allowPartial)) {
    if (globalThis.agentPermissionMode === 'custom' && globalThis.approveFileWriteHandler) {
      const approved = await globalThis.approveFileWriteHandler('modify', args.filePath);
      if (!approved) {
        return {
          ...result,
          outcome: 'none-applied',
          error: `Permission Denied: User rejected modifying "${args.filePath}".`,
        };
      }
    }
    const out = hadCrlf ? result.content.replace(/\r?\n/g, '\r\n') : result.content;
    writeFileSync(fullPath, out, 'utf8');
  }

  return result;
}
