// v1.2.0-demo2 P3.3 (Điểm 6): gom context từ nhiều nguồn, mỗi nguồn một vùng
// try/catch riêng, rồi dedup theo vùng dòng.
//
// Nguồn ý tưởng: `refer_project/ai-tools/continue` (Apache-2.0) —
//   core/context/retrieval/pipelines/BaseRetrievalPipeline.ts (try/catch riêng
//   từng nguồn) + core/context/retrieval/util.ts (deduplicateChunks).

import { describe, it, expect } from 'vitest';
import { fanOutProviders, deduplicateChunks, type ContextChunk } from './provider-fanout.js';

const chunk = (file: string, start: number, end: number, text = 'x'): ContextChunk => ({
  filePath: file,
  startLine: start,
  endLine: end,
  text,
  source: 'fts',
});

describe('fanOutProviders — cách ly lỗi từng nguồn', () => {
  it('một nguồn chết KHÔNG làm hỏng cả pipeline', async () => {
    const r = await fanOutProviders([
      { name: 'fts', load: async () => [chunk('src/a.ts', 1, 10)] },
      {
        name: 'embeddings',
        load: async () => {
          throw new Error('OpenAI 429');
        },
      },
      { name: 'git-diff', load: async () => [chunk('src/b.ts', 5, 8)] },
    ]);

    expect(r.chunks).toHaveLength(2);
    expect(r.healthy).toEqual(['fts', 'git-diff']);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]?.name).toBe('embeddings');
    expect(r.failed[0]?.error).toContain('429');
  });

  it('nguồn hỏng một phần vẫn trả về phần còn lại, KHÔNG ném ra ngoài', async () => {
    await expect(
      fanOutProviders([
        {
          name: 'bad',
          load: async () => {
            throw new Error('timeout');
          },
        },
      ]),
    ).resolves.toBeDefined();
  });

  it('giới hạn số chunk để một nguồn ồn không chiếm hết chỗ', async () => {
    const many = Array.from({ length: 100 }, (_, i) => chunk('src/big.ts', i, i + 1));
    const r = await fanOutProviders([{ name: 'fts', load: async () => many }], {
      maxChunksPerProvider: 5,
    });
    expect(r.chunks).toHaveLength(5);
    expect(r.truncated).toEqual(['fts']);
  });

  it('giữ nguyên thứ tự nguồn khai báo', async () => {
    const r = await fanOutProviders([
      { name: 'a', load: async () => [chunk('a.ts', 1, 2)] },
      { name: 'b', load: async () => [chunk('b.ts', 1, 2)] },
    ]);
    expect(r.chunks.map((c) => c.filePath)).toEqual(['a.ts', 'b.ts']);
  });
});

describe('deduplicateChunks — theo vùng dòng', () => {
  it('cùng file + cùng vùng dòng thì chỉ giữ một', () => {
    const out = deduplicateChunks([
      chunk('src/a.ts', 1, 20, 'bản từ fts'),
      chunk('src/a.ts', 1, 20, 'bản từ embeddings'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe('bản từ fts'); // giữ bản đến trước
  });

  it('vùng dòng khác nhau thì giữ cả hai', () => {
    const out = deduplicateChunks([chunk('src/a.ts', 1, 20), chunk('src/a.ts', 21, 40)]);
    expect(out).toHaveLength(2);
  });

  it('cùng file nhưng vùng dòng lồng nhau thì KHÔNG gộp (tránh mất ngữ cảnh)', () => {
    const out = deduplicateChunks([chunk('src/a.ts', 1, 30), chunk('src/a.ts', 10, 20)]);
    expect(out).toHaveLength(2);
  });

  it('file khác nhau thì không gộp', () => {
    const out = deduplicateChunks([chunk('src/a.ts', 1, 10), chunk('src/b.ts', 1, 10)]);
    expect(out).toHaveLength(2);
  });

  it('fanOut + dedup chạy liền nhau', async () => {
    const r = await fanOutProviders([
      { name: 'fts', load: async () => [chunk('src/a.ts', 1, 10, 'fts')] },
      { name: 'emb', load: async () => [chunk('src/a.ts', 1, 10, 'emb')] },
    ]);
    const deduped = deduplicateChunks(r.chunks);
    expect(deduped).toHaveLength(1);
  });
});
