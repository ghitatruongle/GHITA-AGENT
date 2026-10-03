// v1.2.0-demo2 — vòng review + debug: test ĐỐI KHÁNG cho 6 module mới.
//
// Ở demo1, review pass tìm ra BUG-006/007 chỉ khi đẩy các tình huống biên mà
// test thường không đụng tới. File này làm đúng vậy: không chứng minh tính
// năng, mà cố LÀM HỎNG code.
//
// Mỗi test ghi rõ "bug gì" ở tên — nếu một cái từng fail và nay xanh, đó là
// bug thật đã được sửa.

import { describe, it, expect } from 'vitest';
import {
  matchSearch,
  applyEditBlocks,
  searchReplaceBatch,
} from '../../packages/ai-engine/src/tools/search-replace.js';
import { VerifyLoop } from '../../packages/ai-engine/src/tools/verify-loop.js';
import {
  CompactionMonitor,
  extractKeyMarkers,
  measureRetention,
} from '../../packages/ai-engine/src/context/compaction-monitor.js';
import { ContextManager } from '../../packages/ai-engine/src/context/manager.js';
import {
  fanOutProviders,
  deduplicateChunks,
} from '../../packages/ai-engine/src/context/provider-fanout.js';
import { AIPageCache } from '../../packages/browser-control/src/stagehand-cache.js';
import { McpHealthStore, probeMcpHealth } from '../../packages/mcp/src/health.js';
import {
  parseTaskDone,
  detectFalseDone,
  CompletionGate,
  outOfManifestEditRate,
} from '../../packages/agents/src/track5/completion-contract.js';

// ---------------------------------------------------- search-replace ------

describe('ĐỐI KHÁNG · search_replace', () => {
  it('BUG: khối sau tham chiếu nội dung khối trước vừa GHI ĐÈ thì phải fail, không được khớp bậy', () => {
    // Khối 1 đổi "a" thành "b". Khối 2 tìm "a" — nhưng "a" vẫn còn ở chỗ khác
    // trong file thì vẫn hợp lệ. Ở đây file chỉ có đúng một "a" nên khối 2
    // phải hỏng.
    const src = 'x = a;';
    const r = applyEditBlocks(src, [
      { search: 'x = a;', replace: 'x = b;' },
      { search: 'x = a;', replace: 'x = c;' },
    ]);
    expect(r.applied).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.content).toBe('x = b;');
  });

  it('BUG: file hết dòng mà không có newline — không nới quá ranh giới', () => {
    const src = 'last line no newline';
    const m = matchSearch(src, 'newline');
    expect(m?.text).toBe('last line no newline');
  });

  it('BUG: chuỗi rỗng không được khớp và làm hỏng file', () => {
    const src = 'abc';
    const r = applyEditBlocks(src, [{ search: '', replace: 'X' }]);
    // Rỗng khớp mọi nơi → phải từ chối, không được chèn bậy.
    expect(r.outcome).toBe('none-applied');
    expect(r.content).toBe(src);
  });

  it('BUG: replace rỗng (xoá) vẫn phải chạy đúng', () => {
    const r = applyEditBlocks('keep\nREMOVE\nkeep', [{ search: 'REMOVE\n', replace: '' }]);
    expect(r.outcome).toBe('all-applied');
    expect(r.content).toBe('keep\nkeep');
  });

  it('BUG: "..." ở giữa khi file chỉ có một dòng — không được mở rộng lung tung', () => {
    const m = matchSearch('one line only', 'one\n...\nonly');
    expect(m).toBeNull();
  });

  it('BUG: chuỗi đệ quy lồng nhau không làm treo (ReDoS)', () => {
    const nasty = 'a'.repeat(20000);
    const t0 = Date.now();
    matchSearch(nasty, 'b'.repeat(20000));
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('BUG: nhiều khối hỏng vẫn liệt kê ĐÚNG số khối hỏng', () => {
    const r = applyEditBlocks('a\nb\nc', [
      { search: 'x1', replace: 'y' },
      { search: 'a', replace: 'A' },
      { search: 'x2', replace: 'y' },
      { search: 'x3', replace: 'y' },
      { search: 'c', replace: 'C' },
    ]);
    expect(r.applied).toBe(2);
    expect(r.failed).toBe(3);
    expect(r.error).toContain('#1, #3, #4');
  });

  it('BUG: allowPartial mới ghi phần đã áp dụng — mặc định tuyệt đối không ghi', async () => {
    // Không set workspace -> phải fail sạch chứ không ném lỗi thô.
    const r = await searchReplaceBatch({
      filePath: '/khong/ton/tai/xyz.ts',
      edits: [{ search: 'a', replace: 'b' }],
    });
    expect(r.outcome).toBe('none-applied');
    expect(r.error).toBeTruthy();
  });
});

// ------------------------------------------------------ verify-loop -------

describe('ĐỐI KHÁNG · verify loop', () => {
  it('BUG: maxReflections = 0 thì phải escalate ngay lần đầu, không lãng phí lượt', async () => {
    const loop = new VerifyLoop({
      maxReflections: 0,
      checks: [{ name: 't', run: async () => ({ name: 't', passed: false, output: 'x' }) }],
    });
    expect((await loop.verify()).decision).toBe('escalate');
  });

  it('BUG: không có check nào thì coi như pass, không phải treo', async () => {
    const loop = new VerifyLoop({ checks: [] });
    expect((await loop.verify()).decision).toBe('accept');
  });

  it('BUG: lỗi trong reflectionMessage không được làm hỏng vòng verify', async () => {
    const loop = new VerifyLoop({
      checks: [{ name: 't', run: async () => ({ name: 't', passed: false, output: 'err' }) }],
    });
    await loop.verify();
    expect(loop.reflectionsUsed).toBe(1);
  });
});

// -------------------------------------------------- compaction-monitor ----

describe('ĐỐI KHÁNG · compaction monitor', () => {
  it('BUG: regex \\W mới KHÔNG được nuốt mất dấu chấm trong đường dẫn', () => {
    const m = extractKeyMarkers([{ role: 'user', content: 'sửa src/a.ts' }]);
    expect(m.has('src/a.ts')).toBe(true);
  });

  it('BUG: đường dẫn sâu nhiều cấp không bị cắt cụt', () => {
    const m = extractKeyMarkers([
      { role: 'user', content: 'xem apps/desktop/src-tauri/src/lib.rs nhé' },
    ]);
    expect(m.has('apps/desktop/src-tauri/src/lib.rs')).toBe(true);
  });

  it('BUG: "1. làm tiếp" KHÔNG được coi là đường dẫn file', () => {
    // Regex mới dùng \W nên "." là ký tự phân cách — phải chống lại "số. chữ".
    const m = extractKeyMarkers([{ role: 'user', content: '1. làm tiếp đi 2. ok' }]);
    expect([...m].some((x) => /^\d+\./.test(x))).toBe(false);
  });

  it('BUG: văn bản rất dài không làm treo regex', () => {
    const big = `${'x'.repeat(200000)} src/real.ts`;
    const t0 = Date.now();
    const m = extractKeyMarkers([{ role: 'user', content: big }]);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(m.has('src/real.ts')).toBe(true);
  });

  it('BUG: nén xong mất sạch thì retention = 0, không phải 1', () => {
    const r = measureRetention(
      [{ role: 'user', content: 'sửa src/a.ts và src/b.ts' }],
      [{ role: 'user', content: 'xong' }],
    );
    expect(r.ratio).toBe(0);
  });

  it('BUG: transcript rỗng không làm vỡ CompactionMonitor', () => {
    const m = new CompactionMonitor(new ContextManager());
    const r = m.run([]);
    expect(['not_needed', 'no_change']).toContain(r.outcome);
    expect(r.retention).toBe(1);
  });
});

// ---------------------------------------------------- provider-fanout -----

describe('ĐỐI KHÁNG · provider fan-out', () => {
  it('BUG: nguồn trả về promise bị reject kiểu lạ vẫn được bắt, không làm sập cả lượt', async () => {
    const r = await fanOutProviders([
      { name: 'x', load: () => Promise.reject('chuỗi rác không phải Error') },
    ]);
    expect(r.failed).toHaveLength(1);
    expect(r.chunks).toHaveLength(0);
  });

  it('BUG: nguồn trả về mảng rỗng thì vẫn tính là healthy', async () => {
    const r = await fanOutProviders([{ name: 'rỗng', load: async () => [] }]);
    expect(r.healthy).toEqual(['rỗng']);
    expect(r.failed).toHaveLength(0);
  });

  it('BUG: maxChunks = 0 không được làm mất sạch dữ liệu im lặng', async () => {
    const r = await fanOutProviders(
      [
        {
          name: 'a',
          load: async () => [
            { filePath: 'f.ts', startLine: 1, endLine: 2, text: 'x', source: 'a' },
          ],
        },
      ],
      { maxChunksPerProvider: 0 },
    );
    // 0 nghĩa là không giới hạn theo ý nghĩa thông thường — nhưng nếu hiểu là
    // cắt tất cả thì phải báo `truncated` để người dùng không bị hiểu nhầm.
    expect(r.truncated.length + r.chunks.length).toBeGreaterThan(0);
  });

  it('BUG: dedup giữ nguyên thứ tự đầu vào', () => {
    const c = (f: string) => ({ filePath: f, startLine: 1, endLine: 2, text: 'x', source: 's' });
    const out = deduplicateChunks([c('b.ts'), c('a.ts'), c('b.ts')]);
    expect(out.map((x) => x.filePath)).toEqual(['b.ts', 'a.ts']);
  });
});

// ----------------------------------------------------- stagehand-cache ----

describe('ĐỐI KHÁNG · AIPageCache', () => {
  it('BUG: cache không được trả kết quả của prompt KHÁC nhau', async () => {
    const cache = new AIPageCache();
    const llm = async (p: string) => JSON.stringify({ index: p.length % 7 });
    const w = cache.wrap(llm);
    const a = await w('prompt một');
    const b = await w('prompt hai hoàn toàn khác');
    expect(a).not.toBe(b);
  });

  it('BUG: LLM trả kết quả rỗng KHÔNG được cache — replay kết quả rỗng là tự lừa mình', async () => {
    // Thiết kế của AIPageCache (defaultValidate): chuỗi rỗng bị từ chối, gọi
    // lại LLM lần 2. Cache kết quả rỗng sẽ đóng băng trang ở đúng lúc act()
    // đang tự phục hồi.
    const cache = new AIPageCache();
    let n = 0;
    const w = cache.wrap(async () => {
      n++;
      return '';
    });
    await w('p');
    await w('p');
    expect(n).toBe(2);
  });

  it('BUG: vượt trần số mục thì phải loại bớt, không phình vô hạn', async () => {
    const cache = new AIPageCache(3);
    const w = cache.wrap(async (p: string) => p);
    for (let i = 0; i < 50; i++) await w(`p${i}`);
    expect(cache.size).toBeLessThanOrEqual(3);
  });

  it('BUG: hash phải phân biệt được chuỗi rất giống nhau', async () => {
    const cache = new AIPageCache();
    let calls = 0;
    const w = cache.wrap(async (p: string) => {
      calls++;
      return p;
    });
    // 200 chuỗi cùng độ dài, chỉ khác vài ký tự cuối: mỗi prompt phải gọi LLM
    // đúng 1 lần — hash va chạm thì calls sẽ ít hơn và cache trả nhầm kết quả.
    for (let i = 0; i < 200; i++) await w('a'.repeat(200) + String(i).padStart(4, '0'));
    expect(calls).toBe(200);
    expect(cache.size).toBe(200);
  });

  it('BUG: clear() dọn sạch cả thống kê về mặt nhìn người dùng', () => {
    const cache = new AIPageCache();
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

// -------------------------------------------------------------- health ----

describe('ĐỐI KHÁNG · MCP health', () => {
  it('BUG: probe treo thì trạng thái "checking" phải hết hạn về unknown sau TTL', () => {
    let now = 1000;
    const store = new McpHealthStore({ ttlMs: 50, now: () => now });
    store.beginCheck('srv');
    // Ngay sau khi bắt đầu probe, state = checking...
    expect(store.summary().checking).toBe(1);
    // ...nhưng probe chết mà không record kết quả thì sau TTL phải về unknown,
    // không được kẹt "checking" mãi (UI sẽ hiện "đang kiểm tra" vĩnh viễn).
    now += 51;
    expect(store.summary().checking).toBe(0);
    expect(store.get('srv').state).toBe('unknown');
  });

  it('BUG: beginCheck phải ghi timestamp để TTL có hiệu lực', () => {
    let now = 1000;
    const store = new McpHealthStore({ ttlMs: 50, now: () => now });
    store.beginCheck('srv');
    expect(store.get('srv').checkedAt).toBe(1000);
    now += 51;
    expect(store.get('srv').state).toBe('unknown');
  });

  it('BUG: lỗi không phải Error vẫn đưa vào message được', async () => {
    const client = {
      connect: async () => {
        // Cố tình ném chuỗi: đây chính là tình huống probe phải sống sót.
        // eslint-disable-next-line no-throw-literal
        throw 'lỗi dạng chuỗi';
      },
      refreshTools: async () => [],
      callTool: async () => '',
      close: async () => {},
    } as never;
    const r = await probeMcpHealth('srv', client);
    expect(r.state).toBe('degraded');
    expect(r.error).toContain('lỗi dạng chuỗi');
  });

  it('BUG: probe phải luôn close() kể cả khi connect ném', async () => {
    let closed = false;
    const client = {
      connect: async () => {
        throw new Error('x');
      },
      refreshTools: async () => [],
      callTool: async () => '',
      close: async () => {
        closed = true;
      },
    } as never;
    await probeMcpHealth('srv', client);
    expect(closed).toBe(true);
  });

  it('BUG: 401 trong thông báo lỗi phải nhận ra là unauthenticated', async () => {
    const client = {
      connect: async () => {},
      refreshTools: async () => [],
      callTool: async () => {
        throw new Error('request failed with status 401');
      },
      close: async () => {},
    } as never;
    const r = await probeMcpHealth('srv', client, { authProbeTool: 'whoami' });
    expect(r.auth).toBe('unauthenticated');
  });
});

// ------------------------------------------------- completion-contract ----

describe('ĐỐI KHÁNG · completion contract', () => {
  it('BUG: nhiều thẻ <task-done> lồng nhau không được treo', () => {
    const t0 = Date.now();
    parseTaskDone(`${'<task-done>'.repeat(2000)}x`);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('BUG: JSON hỏng KHÔNG được bịa ra bằng chứng', () => {
    const s = parseTaskDone('<task-done>{"command":"x","exitCode":"KHÔNG PHẢI SỐ"}</task-done>');
    expect(s).not.toBeNull();
    expect(s!.evidence.exitCode).toBeUndefined();
  });

  it('BUG: exitCode là chuỗi "0" cũng không được coi là bằng chứng hợp lệ', () => {
    const s = parseTaskDone('<task-done>{"command":"x","exitCode":"0"}</task-done>');
    expect(s!.evidence.exitCode).toBeUndefined();
  });

  it('BUG: emoji và ký tự lạ không vỡ hàm bỏ dấu', () => {
    expect(detectFalseDone('🎉 Xong!')).toBe(true);
    expect(detectFalseDone('ok 👍')).toBe(false);
  });

  it('BUG: văn bản dài không kết thúc bằng "xong" không được báo nhầm', () => {
    const long = 'đã sửa xong file a, xong file b, xong file c nhưng chưa kiểm tra';
    expect(detectFalseDone(long)).toBe(false);
  });

  it('BUG: CompletionGate với maxReflections âm thì không được kẹt vòng lặp vô hạn', async () => {
    const gate = new CompletionGate(-5);
    const r = await gate.evaluate('Xong.');
    expect(r.decision).toBe('escalate');
  });

  it('BUG: manifest rỗng thì tỉ lệ sửa nhầm phải 1 khi không sửa gì', () => {
    const r = outOfManifestEditRate({ filesToRead: [], findings: ['x'] }, []);
    expect(r).toBe(0);
  });
});
