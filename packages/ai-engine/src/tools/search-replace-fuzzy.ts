// Fuzzy cascade tier for search-replace — pattern from oh-my-pi pi-edit
// fuzzy.rs (MIT), rewritten in TS. Thresholds mirror pi-edit constants
// (DEFAULT_FUZZY_THRESHOLD 0.95, MAX_RECORDED_MATCHES 5, nearest 0.8).
// Nguyên tắc pi-edit giữ nguyên: KHÔNG đoán khi mơ hồ — thay nhầm còn tệ hơn
// không thay.
//
// Hiệu năng (review 2026-11-09, P1): Levenshtein full-matrix O(L²) trên từng
// cửa sổ treo agent ở file lớn (đo thật: 2k dòng ≈ 7s/scan, 20k dòng > 600s).
// Khai tử bằng 3 tầng lọc chi phí, đúng hướng pi-edit (band-limited + pruning):
//   1. SOUND prune: edit distance ≥ |lenA − lenB| → window lệch độ dài quá
//      maxDist bị loại trước khi đụng DP.
//   2. Line-match prefilter: window phải có ≥ PREFILTER_LINE_RATIO dòng khớp
//      (trim) với dòng cùng vị trí của search mới được vào DP — window sim
//      ≥0.9 luôn gần như thẳng hàng theo dòng nên rất an toàn; đường
//      did-you-mean (0.8) có thể bỏ sót candidate lệch dòng — chấp nhận vì
//      chỉ là gợi ý.
//   3. Banded DP (Ukkonen ±maxDist) với early-exit khi row-min vượt maxDist +
//      CELL_BUDGET_PER_SCAN trần tổng ô DP cho cả lần quét (bail trung thực).

export const DEFAULT_FUZZY_THRESHOLD = 0.95;
/** Ngưỡng liệt kê "gần khớp" trong lỗi did-you-mean. */
export const NEAREST_REPORT_THRESHOLD = 0.8;
/** Số ứng viên tối đa ghi nhận (pi-edit MAX_RECORDED_MATCHES). */
export const MAX_RECORDED_MATCHES = 5;
/** Trần chi phí: khối tìm > 200 dòng → bỏ tầng fuzzy. */
export const MAX_SEARCH_LINES = 200;
/** Trần chi phí: file > 20k dòng → bỏ tầng fuzzy. */
export const MAX_CONTENT_LINES = 20000;
/** Tỷ lệ dòng khớp-tương-đối tối thiểu để window được vào DP. */
export const PREFILTER_LINE_RATIO = 0.5;
/** Trần tổng ô DP cho một lần quét (guard chống treo trên file khổng lồ). */
export const CELL_BUDGET_PER_SCAN = 2_000_000;

/** Levenshtein similarity 1 - dist/max(len), exact — dùng cho chuỗi nhỏ/test. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;
  // 0.95 sim không thể tồn tại khi chênh độ dài > 5%; 0.35 là biên an toàn
  // để đường did-you-mean (0.8) vẫn qua pre-filter trước khi tính ma trận.
  if (Math.abs(la - lb) / Math.max(la, lb) > 0.35) return 0;
  let prev: number[] = new Array<number>(lb + 1);
  let cur: number[] = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      // noUncheckedIndexedAccess: hàng trước luôn đã ghi trong vòng này, nhưng
      // trình biên dịch không biết — vá bằng Infinity để Math.min tự bỏ qua.
      const up = (prev[j] ?? Number.POSITIVE_INFINITY) + 1;
      const left = (cur[j - 1] ?? Number.POSITIVE_INFINITY) + 1;
      const diag = (prev[j - 1] ?? Number.POSITIVE_INFINITY) + cost;
      cur[j] = Math.min(up, left, diag);
    }
    // Hoán đổi buffer thay vì cấp phát lại mỗi dòng.
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return 1 - (prev[lb] ?? lb) / Math.max(la, lb);
}

/**
 * Levenshtein banded (Ukkonen, dải |i − j| ≤ maxDist): đường tối ưu có chi
 * phí ≤ maxDist luôn nằm trong dải này, nên bỏ qua phần ngoài là an toàn.
 * Trả khoảng cách thật nếu ≤ maxDist, ngược lại −1. Early-exit khi row-min
 * vượt maxDist — window ngẫu nhiên thoát sau vài chục hàng thay vì quét hết.
 */
function bandedDistance(a: string, b: string, maxDist: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDist) return -1;
  if (la === 0 || lb === 0) {
    return Math.max(la, lb) <= maxDist ? Math.max(la, lb) : -1;
  }
  const INF = Number.POSITIVE_INFINITY;
  const width = 2 * maxDist + 1;
  // Buffer band-relative: prev[k] = giá trị ô (i−1, prevLo + k).
  let prev = new Array<number>(width).fill(INF);
  let prevLo = 0;
  // Row 0: dist(0, j) = j, các ô j ∈ [0, maxDist] nằm trong dải.
  for (let j = 0; j <= Math.min(lb, maxDist); j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const jLo = Math.max(0, i - maxDist);
    const jHi = Math.min(lb, i + maxDist);
    if (jLo > jHi) return -1;
    const cur = new Array<number>(width).fill(INF);
    let rowMin = INF;
    for (let j = jLo; j <= jHi; j++) {
      const up = j - prevLo >= 0 && j - prevLo < width ? (prev[j - prevLo] ?? INF) : INF;
      const diag =
        j - 1 - prevLo >= 0 && j - 1 - prevLo < width ? (prev[j - 1 - prevLo] ?? INF) : INF;
      const left = j - 1 >= jLo ? (cur[j - 1 - jLo] ?? INF) : INF;
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(up + 1, left + 1, diag + cost);
      cur[j - jLo] = v;
      if (v < rowMin) rowMin = v;
    }
    // Early exit: cả hàng đều vượt maxDist → kết quả chắc chắn > maxDist.
    if (rowMin > maxDist) return -1;
    prev = cur;
    prevLo = jLo;
  }
  const final = prev[lb - prevLo] ?? INF;
  return final <= maxDist ? final : -1;
}

export interface FuzzyCandidate {
  /** Đoạn trọn cửa sổ trong file. */
  text: string;
  /** Chỉ số dòng 0-based của cửa sổ trong file. */
  lineIndex: number;
  sim: number;
}

/**
 * Trượt cửa sổ theo số dòng của search qua các dòng file. Chỉ là tầng cuối —
 * tầng exact/whitespace xử lý các trường hợp rẻ trước đó. 3 tầng lọc chi phí
 * xem header comment (P1 review 2026-11-09).
 */
export function findFuzzyCandidates(
  content: string,
  search: string,
  threshold: number = DEFAULT_FUZZY_THRESHOLD,
  max: number = MAX_RECORDED_MATCHES,
): FuzzyCandidate[] {
  if (!search.trim()) return [];
  const contentLines = content.split('\n');
  const searchLines = search.split('\n');
  if (searchLines.length > MAX_SEARCH_LINES) return [];
  if (contentLines.length > MAX_CONTENT_LINES) return [];
  const span = searchLines.length;
  // Set dòng-trim của search cho prefilter O(1)/dòng.
  const searchTrimmed = new Set<string>();
  for (const line of searchLines) searchTrimmed.add(line.trim());

  const out: FuzzyCandidate[] = [];
  let budget = CELL_BUDGET_PER_SCAN;
  for (let i = 0; i + span <= contentLines.length; i++) {
    const window = contentLines.slice(i, i + span).join('\n');
    if (window === search) continue; // exact đã xử lý ở tầng trước
    const la = window.length;
    const lb = search.length;
    const maxDist = Math.ceil((1 - threshold) * Math.max(la, lb));
    // (1) Sound prune: distance ≥ |lenA − lenB|.
    if (Math.abs(la - lb) > maxDist) continue;
    // (2) Line-match prefilter: đếm dòng khớp-trim theo vị trí.
    let matchedLines = 0;
    for (let k = 0; k < span; k++) {
      if (searchTrimmed.has((contentLines[i + k] ?? '').trim())) matchedLines++;
    }
    if (matchedLines / span < PREFILTER_LINE_RATIO) continue;
    // (3) Budget guard: trần tổng ô DP của cả lần quét.
    const cost = Math.min(la, lb) * (2 * maxDist + 1);
    if (cost > budget) break; // bail trung thực — phần còn lại bỏ qua
    budget -= cost;
    const dist = bandedDistance(window, search, maxDist);
    if (dist === -1) continue;
    const sim = 1 - dist / Math.max(la, lb);
    if (sim >= threshold) {
      out.push({ text: window, lineIndex: i, sim });
      if (out.length >= max * 3) break;
    }
  }
  out.sort((x, y) => y.sim - x.sim);
  return out.slice(0, max);
}

export type FuzzyResolution =
  | { kind: 'unique'; candidate: FuzzyCandidate }
  | { kind: 'ambiguous'; candidates: FuzzyCandidate[] }
  | { kind: 'none'; nearest: FuzzyCandidate[] };

/**
 * Điểm vào duy nhất cho tầng fuzzy: unique → áp kèm cảnh báo; ambiguous →
 * không đoán; none → nêu gần khớp nhất cho lỗi did-you-mean.
 */
export function resolveFuzzy(
  content: string,
  search: string,
  threshold: number = DEFAULT_FUZZY_THRESHOLD,
): FuzzyResolution {
  const cands = findFuzzyCandidates(content, search, threshold);
  const first = cands[0];
  if (cands.length === 1 && first) return { kind: 'unique', candidate: first };
  if (cands.length >= 2) return { kind: 'ambiguous', candidates: cands };
  return { kind: 'none', nearest: findFuzzyCandidates(content, search, NEAREST_REPORT_THRESHOLD) };
}
