// v1.2.0-demo2 P3.2 (Điểm 7): biến compaction thành sự kiện có thể đo.
//
// Nguồn ý tưởng: `refer_project/ai-core/openhands` (MIT) —
//   src/hooks/use-await-context-compaction.ts
//
// Vấn đề gốc của GHITA: `ContextManager.compact()` chạy thật và giảm token
// tốt, nhưng KHÔNG ai biết nó có chạy không, giảm được bao nhiêu, và quan
// trọng nhất — nén xong còn giữ lại được bao nhiêu thông tin then chốt.
//
// Ba outcome lấy từ openhands: `not_needed` | `compacted` | `no_change` |
// `timeout`. Thêm đo chất lượng nén vì chỉ nhìn số token là rủi ro: nén "rẻ"
// bằng cách ném bỏ thông tin thì số token đẹp nhưng agent mất ngữ cảnh.

import { describe, it, expect } from 'vitest';
import { ContextManager } from './manager.js';
import { CompactionMonitor, measureRetention, extractKeyMarkers } from './compaction-monitor.js';
import type { ChatMessage } from '../types.js';

function transcript(n: number, fillerRepeat = 10): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `Lượt ${i}: sửa file src/comp${i}.ts bằng hàm fixBug${i}(). ${'chi tiết về dự án. '.repeat(fillerRepeat)}`,
  }));
}

/** Transcript dài, chắc chắn vượt ngưỡng mặc định 128000 * 0.8 = 102400 token. */
function bigTranscript(): ChatMessage[] {
  // ~450 ký tự/lượt → ceil(450/3)+4 = 154 token/lượt × 900 = 138600 token.
  return transcript(900, 20);
}

/** Dựng lượt có ĐÚNG số ký tự, để tính token chắc chắn. */
function msgOfChars(chars: number, i: number): ChatMessage {
  const head = `Lượt ${i}: `;
  return {
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: head + 'x'.repeat(Math.max(0, chars - head.length)),
  };
}

describe('extractKeyMarkers', () => {
  it('nhận ra đường dẫn file và tên hàm', () => {
    const markers = extractKeyMarkers([
      { role: 'user', content: 'hãy sửa src/a.ts dùng hàm computeTotal()' },
    ]);
    expect(markers.has('src/a.ts')).toBe(true);
    expect(markers.has('computeTotal')).toBe(true);
  });

  it('bỏ qua mệt lời chung chung', () => {
    const markers = extractKeyMarkers([{ role: 'user', content: 'ok làm tiếp đi bạn ơi' }]);
    expect(markers.size).toBe(0);
  });
});

describe('measureRetention', () => {
  it('nén giữ hết thì retention = 1', () => {
    const before = [{ role: 'user' as const, content: 'sửa src/a.ts' }];
    const after = [{ role: 'user' as const, content: 'sửa src/a.ts nhé' }];
    expect(measureRetention(before, after).ratio).toBe(1);
  });

  it('nén mất thông tin thì retention < 1', () => {
    const before = [{ role: 'user' as const, content: 'sửa src/a.ts và src/b.ts' }];
    const after = [{ role: 'user' as const, content: 'đã xong' }];
    const r = measureRetention(before, after);
    expect(r.total).toBe(2);
    expect(r.kept).toBe(0);
    expect(r.ratio).toBe(0);
  });

  it('không có marker nào thì ratio = 1 (không phải lỗi)', () => {
    expect(
      measureRetention([{ role: 'user', content: 'ok' }], [{ role: 'user', content: 'ok' }]).ratio,
    ).toBe(1);
  });
});

describe('CompactionMonitor — 3 outcome', () => {
  it('not_needed: transcript ngắn thì không nén, và KHÔNG giảm token', () => {
    const monitor = new CompactionMonitor(new ContextManager());
    const report = monitor.run(transcript(10));
    expect(report.outcome).toBe('not_needed');
    expect(report.tokensSaved).toBe(0);
  });

  it('compacted: transcript dài thì nén và token giảm', () => {
    const monitor = new CompactionMonitor(new ContextManager());
    const report = monitor.run(bigTranscript());
    expect(report.outcome).toBe('compacted');
    expect(report.tokensAfter).toBeLessThan(report.tokensBefore);
    expect(report.tokensSaved).toBeGreaterThan(0);
    expect(report.reductionPct).toBeGreaterThan(0);
  });

  it('no_change: đã vượt ngưỡng nhưng không rút ngắn được thì báo no_change', () => {
    // maxTokens=200, threshold=0.5 → ngưỡng 100 token, budget sliding=120 token.
    // 3 lượt × ceil(108/3)+4 = 40 token/lượt → tổng 120 > 100 (cần nén),
    // nhưng cả 3 vẫn lọt vào budget 120 → không rút ngắn được gì.
    const cm = new ContextManager({
      maxTokens: 200,
      compactThreshold: 0.5,
      strategy: 'sliding_window',
    });
    const monitor = new CompactionMonitor(cm);
    const report = monitor.run([0, 1, 2].map((i) => msgOfChars(108, i)));
    expect(cm.needsCompact([0, 1, 2].map((i) => msgOfChars(108, i)))).toBe(true);
    expect(report.outcome).toBe('no_change');
    expect(report.tokensSaved).toBe(0);
  });

  it('timeout: nén quá thời gian cho phép thì báo timeout, không giả vờ thành công', () => {
    const monitor = new CompactionMonitor(new ContextManager(), { timeoutMs: -1 });
    const report = monitor.run(bigTranscript());
    expect(report.outcome).toBe('timeout');
  });
});

describe('CompactionMonitor — báo cáo chất lượng', () => {
  it('mọi báo cáo đều có số đo chất lượng để quyết định có đổi mặc định không', () => {
    const monitor = new CompactionMonitor(new ContextManager());
    const report = monitor.run(bigTranscript());
    expect(report.retention).toBeGreaterThanOrEqual(0);
    expect(report.retention).toBeLessThanOrEqual(1);
    expect(report).toHaveProperty('markersTotal');
    expect(report).toHaveProperty('markersKept');
  });

  it('giữ được thông tin quan trọng thì retention cao', () => {
    const monitor = new CompactionMonitor(new ContextManager({ strategy: 'summary' }));
    const msgs = bigTranscript();
    const report = monitor.run(msgs);
    // summary giữ lại các lượt gần nhất → phải giữ được marker của chúng
    expect(report.retention).toBeGreaterThan(0);
  });

  it('thống kê tích luỹ theo từng outcome', () => {
    const monitor = new CompactionMonitor(new ContextManager());
    monitor.run(transcript(10));
    monitor.run(bigTranscript());
    const s = monitor.stats;
    expect(s.not_needed).toBe(1);
    expect(s.compacted).toBe(1);
    expect(s.total).toBe(2);
  });

  it('gọi onReport sau mỗi lần nén', () => {
    const seen: string[] = [];
    const monitor = new CompactionMonitor(new ContextManager(), {
      onReport: (r) => seen.push(r.outcome),
    });
    monitor.run(transcript(10));
    monitor.run(bigTranscript());
    expect(seen).toEqual(['not_needed', 'compacted']);
  });
});
