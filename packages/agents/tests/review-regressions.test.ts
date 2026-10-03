// v1.2.0 — hồi quy cho các lỗi tìm được trong đợt review "all code".
//
// Mỗi test ghi rõ lỗi gì ở tên. Trước khi sửa, các test này đều KHÔNG tồn
// tại — nghĩa là không lỗi nào bị bộ test sẵn che phủ.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownCIGate } from '../src/checker/markdownGate.js';
import { Flow } from '../src/flow/flow.js';
import type { FlowStep } from '../src/flow/types.js';

describe('BUG: glob "**" bị thay hai lần nên chỉ khớp 1 cấp thư mục', () => {
  it('quét được file markdown ở MỌI độ sâu', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ghita-mgate-'));
    try {
      mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true });
      writeFileSync(join(root, 'shallow.md'), '# S');
      writeFileSync(join(root, 'a', 'deep.md'), '# D');
      writeFileSync(join(root, 'a', 'b', 'deeper.md'), '# DD');
      writeFileSync(join(root, 'a', 'b', 'c', 'deepest.md'), '# DDD');

      const gate = new MarkdownCIGate({ rootDir: root, include: ['**/*.md'] });
      const report = await gate.run();
      // Trước đây chỉ `shallow.md` được thấy, ba file còn lại biến mất.
      expect(report.filesScanned).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loại trừ được dist/ ở độ sâu con', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ghita-mgate-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, 'dist', 'sub'), { recursive: true });
      writeFileSync(join(root, 'src', 'keep.md'), '# K');
      writeFileSync(join(root, 'dist', 'sub', 'junk.md'), '# J');

      const gate = new MarkdownCIGate({
        rootDir: root,
        include: ['**/*.md'],
        exclude: ['dist/**'],
      });
      const report = await gate.run();
      expect(report.filesScanned).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('BUG: chunkArray treo vô hạn khi maxConcurrency = 0', () => {
  // `mode: 'parallel'` là bắt buộc: chỉ runParallel dùng chunkArray — thiếu nó
  // thì test chạy đường sequential và pass cả trước lẫn sau khi sửa (test vỏ rỗng).
  it('maxConcurrency = 0 không được làm treo', async () => {
    const step: FlowStep = { id: 'a', name: 'A', execute: async () => 1 };
    const flow = new Flow({ name: 'f', mode: 'parallel', maxConcurrency: 0 }).addStep(step);
    // Trước đây `i += 0` khiến vòng lặp không bao giờ kết thúc → OOM worker.
    const run = await flow.run();
    expect(run.status).toBe('completed');
    expect(run.steps).toHaveLength(1);
  }, 5000);

  it('maxConcurrency âm cũng không được làm treo', async () => {
    const step: FlowStep = { id: 'a', name: 'A', execute: async () => 1 };
    const flow = new Flow({ name: 'f', mode: 'parallel', maxConcurrency: -3 }).addStep(step);
    const run = await flow.run();
    expect(run.status).toBe('completed');
    expect(run.steps).toHaveLength(1);
  }, 5000);

  it('maxConcurrency = NaN không được âm thầm chạy 0 step', async () => {
    const step: FlowStep = { id: 'a', name: 'A', execute: async () => 1 };
    const flow = new Flow({ name: 'f', mode: 'parallel', maxConcurrency: NaN }).addStep(step);
    const run = await flow.run();
    // Trước đây `i += NaN` sai vòng đầu → 0 step nhưng vẫn báo completed.
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]?.status).toBe('completed');
  }, 5000);
});

describe('BUG: retries báo lệch 1 so với số lần thật', () => {
  it('maxRetries = 0 thì retries phải là 0, không phải 1', async () => {
    const step: FlowStep = {
      id: 'boom',
      name: 'Boom',
      maxRetries: 0,
      execute: () => Promise.reject(new Error('x')),
    };
    const flow = new Flow({ name: 'f' }).addStep(step);
    const run = await flow.run();
    const r = run.steps.find((s) => s.stepId === 'boom');
    expect(r?.status).toBe('failed');
    expect(r?.retries).toBe(0);
  }, 10000);

  it('fail 1 lần rồi thành công thì retries phải là 1, không phải 0', async () => {
    let calls = 0;
    const step: FlowStep = {
      id: 'flaky',
      name: 'Flaky',
      maxRetries: 3,
      execute: () => {
        calls++;
        return calls === 1 ? Promise.reject(new Error('lan dau')) : Promise.resolve('ok');
      },
    };
    const flow = new Flow({ name: 'f' }).addStep(step);
    const run = await flow.run();
    const r = run.steps.find((s) => s.stepId === 'flaky');
    expect(r?.status).toBe('completed');
    expect(r?.retries).toBe(1);
  }, 10000);
});
