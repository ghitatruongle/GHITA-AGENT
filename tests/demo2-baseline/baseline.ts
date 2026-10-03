// v1.2.0-demo2 — Track 2 / P2.2: bộ đo baseline "trước"
//
// Đo các chỉ số của catalog 10 điểm mà KHÔNG cần gọi LLM thật, để P3.6 có
// cột "trước" bằng số thật thay vì "chưa đo". Chạy: pnpm benchmark:demo2
//
// Nguyên tắc: chỉ đo được thứ đang tồn tại. Với điểm mà GHITA chưa có khả
// năng, giá trị baseline là 0 và chỉ số được đánh dấu `structural-absent`
// thay vì bịa ra số.

import { writeFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { BrowserController } from '../../packages/browser-control/src/index.js';
import { AIPageController, AIPageCache } from '../../packages/browser-control/src/stagehand.js';
import { ContextManager } from '../../packages/ai-engine/src/context/manager.js';
import { CompactionMonitor } from '../../packages/ai-engine/src/context/compaction-monitor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../../docs/demo2-baseline.json');
// Đọc version từ package.json thay vì viết cứng: hardcode ở đây là nguồn gốc
// của việc tài liệu và manifest trỏ về 3 nhãn khác nhau cho cùng một bản.
const PKG_VERSION =
  (
    JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
      version?: string;
    }
  ).version ?? 'unknown';

// ---------------------------------------------------------------- helpers ---

/** Fake playwright-like page ($$eval) — cùng pattern với stagehand.test.ts. */
function fakePage(
  elements: Array<{ tag: string; text: string; id?: string; attrs?: Record<string, string> }>,
) {
  return {
    $$eval: async (_sel: string, _fn: (els: Element[]) => unknown) =>
      elements.map((e, idx) => ({
        selector: e.tag + (e.id ? `#${e.id}` : ''),
        text: e.text,
        tag: e.tag,
        attrs: e.attrs ?? {},
        index: idx,
      })),
  };
}

type Measurement = {
  id: string;
  point: number;
  metric: string;
  value: number | string;
  unit: string;
  note: string;
  kind: 'measured' | 'structural-absent' | 'implemented';
};

const results: Measurement[] = [];

function record(m: Measurement) {
  results.push(m);
  const v = m.value;
  console.info(`  ${m.id.padEnd(34)} ${String(v).padStart(8)} ${m.unit.padEnd(12)} [${m.kind}]`);
}

// ------------------------------------------------- B1 — browser LLM calls ---
// Điểm 3 (stagehand cache). Lặp lại cùng một act() N lần trên cùng trang và
// đếm số lần gọi LLM. Có cache thì lần 2+ phải là 0.

async function measureBrowserLlmCalls() {
  const REPEATS = 5;
  let llmCalls = 0;
  const llm = async () => {
    llmCalls++;
    // resolveSelectorByIntent yêu cầu {"index": N}. Trả về index hợp lệ để
    // act() thành công ngay lần đầu — đo chi phí của việc "giải ý định",
    // không phải của việc thử lại.
    return JSON.stringify({ index: 0 });
  };

  const controller = new BrowserController({ click: async () => {} });
  const page = fakePage([{ tag: 'button', text: 'Login', id: 'login' }]);
  const sh = new AIPageController(controller, page, { llm });

  for (let i = 0; i < REPEATS; i++) {
    const r = await sh.act('click login');
    if (!r.success) throw new Error(`act() thất bại ở lần ${i + 1}: ${r.error}`);
  }

  record({
    id: 'B1.browser.llmCallsPerRepeatedAct',
    point: 3,
    metric: 'Số lần gọi LLM cho 5 act() giống hệt nhau — KHÔNG cache (trước demo2)',
    value: llmCalls,
    unit: 'calls',
    note: 'Baseline 1.1.5: không có cache, mỗi act() gọi LLM lại từ đầu.',
    kind: 'measured',
  });

  // Cùng phép đo, nhưng bọc cache (P3.1 Điểm 3) — để thấy "sau demo2".
  const llmCallsCached = { n: 0 };
  const llm2 = async () => {
    llmCallsCached.n++;
    return JSON.stringify({ index: 0 });
  };
  const cache = new AIPageCache();
  const shCached = new AIPageController(controller, page, { llm: cache.wrap(llm2) });
  for (let i = 0; i < REPEATS; i++) {
    const r = await shCached.act('click login');
    if (!r.success) throw new Error(`act() có cache thất bại ở lần ${i + 1}: ${r.error}`);
  }

  record({
    id: 'B1c.browser.llmCallsPerRepeatedActCached',
    point: 3,
    metric: 'Số lần gọi LLM cho 5 act() giống hệt nhau — CÓ cache (sau demo2)',
    value: llmCallsCached.n,
    unit: 'calls',
    note: `Giảm ${Math.round((1 - llmCallsCached.n / llmCalls) * 100)}% so với B1. Cache hits=${cache.stats.hits}, misses=${cache.stats.misses}, lỗi cache=${cache.stats.errors}.`,
    kind: 'measured',
  });

  return { llmCalls, llmCallsCached: llmCallsCached.n, repeats: REPEATS };
}

// ---------------------------------------------------- B2 — self-heal cost ---
// Điểm 4. act() hiện đã có vòng retry tối đa 2; đo số lần thử thực tế khi
// hành động hỏng lần đầu (selector stale / node detached).

async function measureSelfHealAttempts() {
  let clickCalls = 0;
  const click = async () => {
    clickCalls++;
    if (clickCalls === 1) throw new Error('detached node');
  };
  const controller = new BrowserController({ click });
  const page = fakePage([{ tag: 'button', text: 'Save', id: 'save' }]);
  const sh = new AIPageController(controller, page);

  const r = await sh.act('click save');
  record({
    id: 'B2.browser.actAttemptsOnRecover',
    point: 4,
    metric: 'Số lần thử khi click hỏng lần đầu',
    value: r.attempts,
    unit: 'attempts',
    note: `Self-heal đã tồn tại (tối đa 2). Thiếu: attempts chưa đưa lên UI/telemetry. Recovery thành công=${r.success}.`,
    kind: 'measured',
  });

  // Không lần nào hồi phục được — số lần thử vẫn là 2, tức trần cứng.
  const alwaysFail = new BrowserController({
    click: async () => {
      throw new Error('detached node');
    },
  });
  const sh2 = new AIPageController(alwaysFail, page);
  const r2 = await sh2.act('click save');
  record({
    id: 'B2b.browser.actAttemptsUnrecoverable',
    point: 4,
    metric: 'Số lần thử khi hỏng không hồi phục được',
    value: r2.attempts,
    unit: 'attempts',
    note: `Trần cứng 2 lần, không cấu hình được, không ghi metric. success=${r2.success}.`,
    kind: 'measured',
  });

  return { recoverAttempts: r.attempts, unrecoverAttempts: r2.attempts };
}

// -------------------------------------------------- B3 — context compaction ---
// Điểm 7. ContextManager có compact() nhưng không có sự kiện nào đo kết quả,
// nên không biết lần nào compaction thực sự giảm token.

function measureCompaction() {
  // Ngưỡng mặc định: 128000 * 0.8 = 102400 token. Transcript phải vượt ngưỡng
  // này thì compact() mới chạy — nếu không thì nó no-op và ta đo nhầm.
  // Transcript phải có nội dung GIỐNG hội thoại thật: nhắc tới đường dẫn file
  // và tên hàm. Nếu không có, retention luôn = 100% một cách giả tạo, vì
  // không có gì để mất — đo như vậy là tự lừa mình.
  const messages = Array.from({ length: 900 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content:
      `Lượt ${i}: sửa apps/desktop/src/module${i}/handler${i}.ts bằng hàm processBatch${i}() ` +
      `và cập nhật crates/retrieval/src/importance${i}.rs. ${'nội dung hội thoại mô phỏng chi tiết về dự án. '.repeat(
        11,
      )}`,
  }));

  const defaultCm = new ContextManager();
  const before = defaultCm.estimateTokens(messages);
  const neededByDefault = defaultCm.needsCompact(messages);

  // Đo cả 3 chiến lược ở cùng một cấu hình để so sánh được.
  const strategies = ['sliding_window', 'summary', 'trajectory'] as const;
  const perStrategy: Record<
    string,
    { before: number; after: number; ms: number; msgs: number; retention: number; outcome: string }
  > = {};

  for (const strategy of strategies) {
    const cm = new ContextManager({ strategy });
    const monitor = new CompactionMonitor(cm);
    const report = monitor.run(messages);
    perStrategy[strategy] = {
      before: report.tokensBefore,
      after: report.tokensAfter,
      ms: Number(report.durationMs.toFixed(3)),
      msgs: report.messagesAfter,
      retention: report.retention,
      outcome: report.outcome,
    };
  }

  record({
    id: 'B3.context.tokensBeforeCompact',
    point: 7,
    metric: 'Token trước compact (900 lượt)',
    value: before,
    unit: 'tokens',
    note: `needsCompact với config mặc định = ${neededByDefault} (ngưỡng 128000*0.8=102400). Ước lượng chars/3, không dùng tokenizer thật.`,
    kind: 'measured',
  });

  for (const [strategy, r] of Object.entries(perStrategy)) {
    const pct = Math.round((1 - r.after / r.before) * 100);
    record({
      id: `B3.${strategy}.tokenReductionPct`,
      point: 7,
      metric: `Giảm token sau compact — ${strategy}`,
      value: pct,
      unit: '%',
      note: `${r.before} → ${r.after} token, ${r.ms}ms, còn ${r.msgs}/${messages.length} lượt.`,
      kind: 'measured',
    });
    // CHỈ SỐ QUYẾT ĐỊNH: giảm bao nhiêu token so với giữ được bao nhiêu
    // thông tin then chốt. Nén rẻ bằng cách ném bỏ thông tin thì số token
    // đẹp nhưng retention thấp — đó là lý do KHÔNG đổi mặc định chỉ vì số.
    record({
      id: `B3.${strategy}.retention`,
      point: 7,
      metric: `Retention sau compact — ${strategy}`,
      value: Number((r.retention * 100).toFixed(1)),
      unit: '%',
      note: `Giữ lại ${Math.round(r.retention * 100)}% đường dẫn/tên hàm còn nguyên. outcome=${r.outcome}.`,
      kind: 'measured',
    });
  }

  // TUYỆT ĐỐI KHÔNG chọn theo số token thấp nhất. `summary` giảm 99% token
  // nhưng chỉ giữ lại 0,8% đường dẫn/tên hàm — tức là phá huỷ ngữ cảnh. Số
  // token thấp chỉ là HỆ QUẢ của việc ném bỏ thông tin, không phải mục tiêu.
  const RETENTION_FLOOR = 0.5;
  const viable = Object.entries(perStrategy).filter(([, r]) => r.retention >= RETENTION_FLOOR);
  const pool = viable.length > 0 ? viable : Object.entries(perStrategy);
  const best = pool.sort((a, b) => b[1].retention - a[1].retention || a[1].after - b[1].after)[0]!;
  const dropped = Object.keys(perStrategy).filter((s) => !viable.some(([n]) => n === s));
  record({
    id: 'B3c.context.bestStrategy',
    point: 7,
    metric: 'Chiến lược compact đáng dùng (retention ≥ 50%, ưu tiên giữ thông tin)',
    value: best[0],
    unit: 'name',
    note: `Còn ${best[1].after} token sau compact, giữ ${Math.round(best[1].retention * 100)}% thông tin. ${
      dropped.length
        ? `ĐÃ LOẠI vì mất quá nhiều thông tin: ${dropped.join(', ')}.`
        : 'Không có chiến lược nào bị loại.'
    }`,
    kind: 'measured',
  });

  return { before, neededByDefault, perStrategy };
}

// ------------------------------------------- B4 — những thứ chưa tồn tại ---
// Các điểm mà GHITA chưa có khả năng: baseline = 0, đánh dấu structural-absent
// để không ai tưởng là đã đo xong.

function recordAbsent() {
  const rows: Array<[string, number, string, string, number, Measurement['kind']]> = [
    [
      'B4.aiEngine.searchReplaceToolCount',
      1,
      'Số module edit SEARCH/REPLACE trong ai-engine',
      'P3.4 Điểm 1 ĐÃ LÀM: ai-engine/src/tools/search-replace.ts — cascade 4 tầng + lỗi hành động được.',
      1,
      'implemented',
    ],
    [
      'B5.aiEngine.lmRetryAttemptsOn429',
      1,
      'Số lần thử lại khi provider trả 429/503',
      'sidecar/server.mjs dùng Promise.race với timeout hardcode, KHÔNG retry. 1 lần rồi chat_error.',
      0,
      'structural-absent',
    ],
    [
      'B6.mcp.healthStorePresent',
      8,
      'Có tầng health cho MCP không',
      'P3.2 Điểm 8 ĐÃ LÀM: mcp/src/health.ts — 4 trạng thái + TTL, verdict không persist, xác thực 3 trị.',
      1,
      'implemented',
    ],
    [
      'B7.codeGraph.incrementalReindexMs',
      5,
      'Thời gian re-index sau khi đổi branch',
      'Chưa làm (P3.3). Cần content-addressed cache trong crates/codegraph + crates/retrieval.',
      0,
      'structural-absent',
    ],
    [
      'B8.agents.taskDoneContractPresent',
      9,
      'Có cổng chặn hoàn thành không',
      'P3.5 Điểm 9 ĐÃ LÀM: agents/src/track5/completion-contract.ts — CompletionGate, trần 3 lượt rồi DỪNG hỏi user.',
      1,
      'implemented',
    ],
    [
      'B9.agents.evidenceManifestHelpers',
      10,
      'Có bản kê bắt buộc cho subagent không',
      'P3.5 Điểm 10 ĐÃ LÀM: EvidenceManifest + isManifestComplete + outOfManifestEditRate đo sửa nhầm file.',
      1,
      'implemented',
    ],
  ];

  for (const [id, point, metric, note, value, kind] of rows) {
    record({
      id,
      point,
      metric,
      value,
      unit: kind === 'implemented' ? 'present' : 'absent',
      note,
      kind,
    });
  }
}

// ------------------------------------------------------------------ main ---

async function main() {
  console.info('\n📏 v1.2.0-demo2 — baseline "trước" (đo offline, không gọi LLM)\n');

  console.info('B1–B2 · browser control (điểm 3, 4):');
  const b1 = await measureBrowserLlmCalls();
  const b2 = await measureSelfHealAttempts();

  console.info('\nB3 · context compaction (điểm 7):');
  const b3 = measureCompaction();

  console.info('\nB4–B9 · khả năng chưa tồn tại (điểm 1, 5, 8, 9, 10):');
  recordAbsent();

  console.info('\nB10 · search_replace cascade (điểm 1):');
  await measureSearchReplace();

  console.info('\nB11-B12 · verify loop + context fan-out (điểm 2, 6):');
  await measureVerifyLoop();
  await measureFanOut();

  const payload = {
    version: PKG_VERSION,
    phase: 'P2.2',
    generatedAt: new Date().toISOString(),
    note: 'Đo offline, không cần API key. Giá trị 0 kèm kind=structural-absent nghĩa là khả năng chưa tồn tại, KHÔNG phải đã đo được 0.',
    summary: {
      browserLlmCallsPerRepeatedAct: b1.llmCalls,
      browserRepeatedActCount: b1.repeats,
      selfHealRecoverAttempts: b2.recoverAttempts,
      selfHealUnrecoverAttempts: b2.unrecoverAttempts,
      contextTokensBeforeCompact: b3.before,
      contextNeedsCompactByDefault: b3.neededByDefault,
      contextPerStrategy: b3.perStrategy,
    },
    measurements: results,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.info(`\n${'─'.repeat(60)}`);
  console.info(`Đã ghi: docs/demo2-baseline.json (${results.length} chỉ số)`);
  console.info(`${'─'.repeat(60)}\n`);
}

// ------------------------------------------------ B10 — search_replace ------
// Điểm 1. Trước demo2 chỉ có khớp CHÍNH XÁC: lệch một dòng trắng là hỏng.
// Đo tỉ lệ khớp được của từng tình huống thực tế hay gặp.

const SAMPLE = [
  'export function add(a, b) {',
  '  return a + b;',
  '}',
  '',
  'export function mul(a, b) {',
  '  return a * b;',
  '}',
].join('\n');

const EDIT_CASES: Array<{ name: string; search: string; expectMatch: boolean }> = [
  { name: 'khớp chính xác', search: '  return a + b;', expectMatch: true },
  { name: 'quên thụt đầu dòng', search: 'return a + b;', expectMatch: true },
  { name: 'thừa dòng trống đầu', search: '\n  return a + b;', expectMatch: true },
  {
    name: 'dùng dấu "..." cho dòng ở giữa',
    search: 'export function add(a, b) {\n  ...\n}',
    expectMatch: true,
  },
  { name: 'sai hoàn toàn', search: 'return KHONG_CO;', expectMatch: false },
];

async function measureSearchReplace() {
  const { matchSearch } = await import('../../packages/ai-engine/src/tools/search-replace.js');

  let matched = 0;
  for (const c of EDIT_CASES) {
    const m = matchSearch(SAMPLE, c.search);
    if (Boolean(m) === c.expectMatch) matched++;
  }
  const rate = Math.round((matched / EDIT_CASES.length) * 100);
  record({
    id: 'B10.searchReplace.cascadeMatchRate',
    point: 1,
    metric: 'Tỉ lệ khớp cascade trên 5 tình huống thực tế',
    value: rate,
    unit: '%',
    note: 'Trước demo2 chỉ khớp chính xác → 3/5 tình huống hỏng. Giờ 4 tầng: exact → ellipsis → bỏ dòng trống → bỏ thụt đầu.',
    kind: 'measured',
  });

  // Nguyên tử phải đo ở tầng GHI FILE, không phải tầng chuỗi: applyEditBlocks
  // cố ý trả về nội dung áp dụng được một phần, còn searchReplaceBatch mới là
  // nơi quyết định có ghi xuống đĩa hay không.
  const dir = mkdtempSync(join(tmpdir(), 'ghita-demo2-'));
  const file = join(dir, 'a.ts');
  const globals = globalThis as Record<string, unknown>;
  const previousRoot = globals.ghitaWorkspaceRoot;
  globals.ghitaWorkspaceRoot = dir;
  writeFileSync(file, SAMPLE, 'utf8');
  try {
    const { searchReplaceBatch } =
      await import('../../packages/ai-engine/src/tools/search-replace.js');
    const r = await searchReplaceBatch({
      filePath: file,
      edits: [
        { search: '  return a + b;', replace: '  return a - b;' },
        { search: '  return KHONG_CO;', replace: 'x' },
      ],
    });
    const unchanged = readFileSync(file, 'utf8') === SAMPLE;
    // Phải kiểm ĐÚNG lý do từ chối. Nếu chỉ xem "file không đổi" thì hỏng
    // `ghitaWorkspaceRoot` (sandbox hỏng) cũng ra kết quả "đạt" — chỉ số xanh
    // vì lý do sai thì vô nghĩa.
    const rejectedForRightReason = r.outcome === 'partial' && r.applied === 1 && r.failed === 1;
    record({
      id: 'B10b.searchReplace.fileUntouchedOnFailure',
      point: 1,
      metric: 'File KHÔNG bị ghi khi còn khối hỏng',
      value: unchanged && rejectedForRightReason ? 1 : 0,
      unit: 'bool',
      note: `outcome=${r.outcome}, applied=${r.applied}, failed=${r.failed}. Mặc định không ghi khi partial; phải truyền allowPartial mới ghi.`,
      kind: 'measured',
    });
  } finally {
    // Khôi phục đúng trạng thái cũ — `delete` sẽ xoá mất giá trị nếu môi
    // trường vốn đã có sẵn.
    if (previousRoot === undefined) delete globals.ghitaWorkspaceRoot;
    else globals.ghitaWorkspaceRoot = previousRoot;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- B11 — verify loop (điểm 2) -----
// Trước demo2: sửa file xong không kiểm tra gì, nên code hỏng vẫn tính là xong.
// Đo: agent nói "xong" liên tục thì có bị chặn và có DỪNG hỏi người dùng không.

async function measureVerifyLoop() {
  const { VerifyLoop } = await import('../../packages/ai-engine/src/tools/verify-loop.js');
  const fail = { name: 'test', passed: false, output: 'FAIL: add() trả về sai' };
  const loop = new VerifyLoop({ checks: [{ name: 'test', run: async () => fail }] });

  const decisions: string[] = [];
  for (let i = 0; i < 4; i++) {
    decisions.push((await loop.verify()).decision);
  }

  const escalated = decisions[decisions.length - 1] === 'escalate';
  record({
    id: 'B11.verifyLoop.stopsAfterMaxReflections',
    point: 2,
    metric: 'Có DỪNG hỏi người dùng khi hết lượt không',
    value: escalated ? 1 : 0,
    unit: 'bool',
    note: `Chuỗi quyết định: ${decisions.join(' → ')}. Trần 3 lượt rồi escalate — không tự đoán tiếp.`,
    kind: 'measured',
  });
}

// --------------------------------------- B12 — context fan-out (điểm 6) -----
// Đo: một nguồn chết có làm hỏng cả pipeline không, và dedup có bỏ trùng không.

async function measureFanOut() {
  const { fanOutProviders, deduplicateChunks } =
    await import('../../packages/ai-engine/src/context/provider-fanout.js');
  const mk = (file: string, s: number, e: number) => ({
    filePath: file,
    startLine: s,
    endLine: e,
    text: 'x',
    source: '',
  });

  const r = await fanOutProviders([
    { name: 'fts', load: async () => [mk('src/a.ts', 1, 10)] },
    {
      name: 'embeddings',
      load: async () => {
        throw new Error('429 rate limited');
      },
    },
    { name: 'git-diff', load: async () => [mk('src/b.ts', 1, 10)] },
  ]);

  record({
    id: 'B12.context.survivesDeadProvider',
    point: 6,
    metric: 'Số nguồn còn sống sau khi 1 nguồn chết',
    value: r.healthy.length,
    unit: 'sources',
    note: `healthy=${r.healthy.join(',')}; failed=${r.failed.map((f) => f.name).join(',')}. Một nguồn chết KHÔNG kéo theo mất ngữ cảnh.`,
    kind: 'measured',
  });

  const deduped = deduplicateChunks([mk('src/a.ts', 1, 20), mk('src/a.ts', 1, 20)]);
  record({
    id: 'B12b.context.dedupByLineRange',
    point: 6,
    metric: 'Số chunk còn lại sau dedup (từ 2 chunk trùng)',
    value: deduped.length,
    unit: 'chunks',
    note: 'Dedup theo (file, startLine, endLine). Vùng lồng nhau thì KHÔNG gộp để khỏi mất bối cảnh.',
    kind: 'measured',
  });
}

// Gọi ở CUỐI file: `main()` dùng hằng khai báo phía trên (SAMPLE, EDIT_CASES).
// Gọi ở giữa file chỉ chạy được nhờ `await` đầu tiên treo đủ lâu cho module
// kịp chạy nốt phần còn lại — xoá await đó là ReferenceError ngay.
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
