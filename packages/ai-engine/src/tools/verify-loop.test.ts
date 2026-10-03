// v1.2.0-demo2 P3.4 (Điểm 2): vòng verify lint → test có trần.
//
// Nguồn ý tưởng: `refer_project/ai-tools/aider` (Apache-2.0) —
//   aider/coders/base_coder.py: auto_lint → auto_test → max_reflections = 3.
//
// Vấn đề: trước demo2 GHITA sửa file xong không hề kiểm tra gì, nên code
// hỏng vẫn được coi là xong. Điểm mấu chốt học được từ aider — và điều mình
// giữ nguyên — là HẾT TRẦN THÌ DỪNG HỎI NGƯỜI DÙNG, không tự đoán tiếp.

import { describe, it, expect, vi } from 'vitest';
import { VerifyLoop, type CheckResult } from './verify-loop.js';

const pass: CheckResult = { name: 'lint', passed: true, output: '' };
const failLint: CheckResult = {
  name: 'lint',
  passed: false,
  output: 'src/a.ts:12:1 error: dấu phẩy bị thiếu',
};
const failTest: CheckResult = {
  name: 'test',
  passed: false,
  output: 'FAIL src/a.test.ts\n  ✗ add() trả về sai',
};

describe('VerifyLoop — thứ tự lint rồi test', () => {
  it('lint pass thì mới chạy test', async () => {
    const order: string[] = [];
    const loop = new VerifyLoop({
      checks: [
        {
          name: 'lint',
          run: async () => {
            order.push('lint');
            return pass;
          },
        },
        {
          name: 'test',
          run: async () => {
            order.push('test');
            return pass;
          },
        },
      ],
    });

    const r = await loop.verify();
    expect(r.decision).toBe('accept');
    expect(order).toEqual(['lint', 'test']);
  });

  it('lint fail thì DỪNG, không chạy test cho tốn thời gian', async () => {
    const test = vi.fn(async () => pass);
    const loop = new VerifyLoop({
      checks: [
        { name: 'lint', run: async () => failLint },
        { name: 'test', run: test },
      ],
    });

    const r = await loop.verify();
    expect(r.decision).toBe('retry');
    expect(test).not.toHaveBeenCalled();
  });
});

describe('VerifyLoop — trần số lượt', () => {
  it('mặc định thử lại tối đa 3 lượt rồi DỪNG hỏi người dùng', async () => {
    const run = vi.fn(async () => failTest);
    const loop = new VerifyLoop({ checks: [{ name: 'test', run }] });

    expect((await loop.verify()).decision).toBe('retry');
    expect((await loop.verify()).decision).toBe('retry');
    expect((await loop.verify()).decision).toBe('retry');

    const last = await loop.verify();
    expect(last.decision).toBe('escalate');
    expect(run).toHaveBeenCalledTimes(4); // 3 lượt thử lại + 1 lượt quyết định
    expect(last.escalationMessage).toMatch(/người dùng|user/i);
  });

  it('giữa chừng mà pass thì dừng sớm, không mất lượt nào', async () => {
    let n = 0;
    const loop = new VerifyLoop({
      maxReflections: 3,
      checks: [
        {
          name: 'test',
          run: async () => {
            n++;
            return n < 2 ? failTest : pass;
          },
        },
      ],
    });

    expect((await loop.verify()).decision).toBe('retry');
    expect((await loop.verify()).decision).toBe('accept');
    expect(loop.reflectionsUsed).toBe(1);
  });

  it('báo cáo đủ nguyên nhân để model sửa, không chỉ "fail"', async () => {
    const loop = new VerifyLoop({ checks: [{ name: 'test', run: async () => failTest }] });
    const r = await loop.verify();
    expect(r.decision).toBe('retry');
    expect(r.reflectionMessage).toContain('FAIL src/a.test.ts');
    expect(r.reflectionMessage).toMatch(/test/);
  });

  it('lệnh kiểm tra tự hỏng KHÔNG được coi là đã pass', async () => {
    const loop = new VerifyLoop({
      checks: [
        {
          name: 'test',
          run: async () => {
            throw new Error('runner chết giữa chừng');
          },
        },
      ],
    });
    const r = await loop.verify();
    expect(r.decision).toBe('retry');
    expect(r.reflectionMessage).toContain('runner chết giữa chừng');
  });
});
