// v1.2.0-demo2 P3.4 (Điểm 1): tool edit dạng SEARCH/REPLACE với cascade matching
// và lỗi CÓ THỂ HÀNH ĐỘNG.
//
// Nguồn ý tưởng: `refer_project/ai-tools/aider` (Apache-2.0) —
//   aider/coders/editblock_coder.py, hàm prep() / perfect_or_whitespace() /
//   try_dotdotdots() / replace_most_similar_chunk().
//
// Hiện trạng GHITA trước demo2: chỉ có `replaceFileContent()` khớp CHÍNH XÁC.
// Lệch một dòng trắng đầu là ném lỗi, và lỗi không nói được khối nào hỏng.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchSearch, searchReplaceBatch, applyEditBlocks } from './search-replace.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghita-sr-'));
  (globalThis as Record<string, unknown>).ghitaWorkspaceRoot = dir;
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>).ghitaWorkspaceRoot;
  rmSync(dir, { recursive: true, force: true });
});

const SOURCE = [
  'export function add(a, b) {',
  '  return a + b;',
  '}',
  '',
  'export function mul(a, b) {',
  '  return a * b;',
  '}',
  '',
].join('\n');

describe('matchSearch — cascade matching', () => {
  it('khớp chính xác thì dùng chiến lược exact', () => {
    const m = matchSearch(SOURCE, '  return a + b;');
    expect(m?.strategy).toBe('exact');
  });

  it('lệch thụt đầu dòng vẫn khớp', () => {
    const m = matchSearch(SOURCE, 'return a + b;');
    expect(m?.strategy).toBe('strip-whitespace');
    expect(m?.text).toBe('  return a + b;');
  });

  it('thừa dòng trống ở đầu vẫn khớp và giữ thụt đầu của file', () => {
    const m = matchSearch(SOURCE, '\n  return a + b;');
    expect(m?.strategy).toBe('strip-whitespace');
    expect(m?.text).toBe('  return a + b;');
  });

  it('bỏ dòng trống đầu mẫu tìm kiếm rồi khớp được', () => {
    const m = matchSearch(SOURCE, '\nexport function add(a, b) {\n  return a + b;');
    expect(m).not.toBeNull();
    expect(m?.text).toContain('export function add');
  });

  it('mở rộng dấu "..." thành các dòng còn lại', () => {
    const content = 'line1\nline2\nline3\nline4';
    const m = matchSearch(content, 'line1\n...\nline4');
    expect(m?.strategy).toBe('ellipsis');
    expect(m?.text).toBe('line1\nline2\nline3\nline4');
  });

  it('không có gì khớp thì trả null, không đoán bừa', () => {
    expect(matchSearch(SOURCE, 'khong ton tai o day')).toBeNull();
  });
});

describe('applyEditBlocks — nhiều khối', () => {
  it('áp dụng được cả khối và trả nội dung mới', () => {
    const r = applyEditBlocks(SOURCE, [{ search: '  return a + b;', replace: '  return a - b;' }]);
    expect(r.outcome).toBe('all-applied');
    expect(r.content).toContain('return a - b;');
    expect(r.applied).toBe(1);
    expect(r.failed).toBe(0);
  });

  it('khối hỏng thì báo partial, chỉ đích danh khối hỏng (không ghi file khi chưa được phép)', () => {
    const r = applyEditBlocks(SOURCE, [
      { search: '  return a + b;', replace: '  return a - b;' },
      { search: '  return khong ton tai;', replace: 'x' },
    ]);
    expect(r.outcome).toBe('partial');
    expect(r.applied).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.error).toContain('#2');
    // searchReplaceBatch mặc định KHÔNG ghi khi còn khối hỏng — xem test dưới.
  });

  it('tất cả khối hỏng thì mới là none-applied và file giữ nguyên', () => {
    const r = applyEditBlocks(SOURCE, [
      { search: '  return A;', replace: 'x' },
      { search: '  return B;', replace: 'x' },
    ]);
    expect(r.outcome).toBe('none-applied');
    expect(r.applied).toBe(0);
    expect(r.content).toBe(SOURCE);
  });

  it('lỗi phải hành động được: nói rõ khối nào cần gửi lại + gợi ý dòng gần nhất', () => {
    const r = applyEditBlocks(SOURCE, [
      { search: '  return a + b;', replace: '  return a - b;' },
      // Sai MỘT dòng giữa khối — dòng đầu vẫn đúng nên phải tìm ra vị trí.
      { search: 'export function mul(a, b) {\n  return a + b;\n}', replace: 'x' },
    ]);
    expect(r.outcome).toBe('partial');
    expect(r.applied).toBe(1);
    expect(r.failed).toBe(1);
    // Danh sách khối hỏng + ngữ cảnh để model sửa lại ngay.
    expect(r.error).toMatch(/1\/2/);
    expect(r.error).toContain('#2');
    expect(r.error).toContain('return a * b');
  });

  it('từ chối khi khối khớp nhiều chỗ — thay sai là nguy hiểm hơn không thay', () => {
    const dup = ['x = 1;', 'x = 1;', 'y = 2;'].join('\n');
    const r = applyEditBlocks(dup, [{ search: 'x = 1;', replace: 'x = 3;' }]);
    expect(r.outcome).toBe('none-applied');
    expect(r.error).toContain('nhiều chỗ');
  });

  it('áp dụng tuần tự: khối sau thấy nội dung khối trước đã đổi', () => {
    const r = applyEditBlocks(SOURCE, [
      { search: '  return a + b;', replace: '  return a + b + 0;' },
      { search: '  return a + b + 0;', replace: '  return a + b;' },
    ]);
    expect(r.outcome).toBe('all-applied');
    expect(r.applied).toBe(2);
  });
});

describe('searchReplaceBatch — ghi file thật', () => {
  it('ghi file khi tất cả khối áp dụng được', async () => {
    const file = join(dir, 'a.ts');
    writeFileSync(file, SOURCE, 'utf8');

    const r = await searchReplaceBatch({
      filePath: file,
      edits: [{ search: '  return a + b;', replace: '  return a - b;' }],
    });
    expect(r.outcome).toBe('all-applied');
    expect(readFileSync(file, 'utf8')).toContain('return a - b;');
  });

  it('hỏng thì KHÔNG đụng file (nguyên tử: soạn trước, ghi sau)', async () => {
    const file = join(dir, 'b.ts');
    writeFileSync(file, SOURCE, 'utf8');

    const r = await searchReplaceBatch({
      filePath: file,
      edits: [{ search: '  return khong ton tai;', replace: 'x' }],
    });
    expect(r.outcome).toBe('none-applied');
    expect(readFileSync(file, 'utf8')).toBe(SOURCE);
  });

  it('một khối hỏng thì KHÔNG ghi file, trừ khi cho phép partial', async () => {
    const file = join(dir, 'c.ts');
    writeFileSync(file, SOURCE, 'utf8');

    const r = await searchReplaceBatch({
      filePath: file,
      edits: [
        { search: '  return a + b;', replace: '  return a - b;' },
        { search: '  return KHONG CO;', replace: 'x' },
      ],
    });
    expect(r.outcome).toBe('partial');
    expect(readFileSync(file, 'utf8')).toBe(SOURCE);

    // Cho phép partial thì mới ghi phần đã áp dụng được.
    const r2 = await searchReplaceBatch({
      filePath: file,
      allowPartial: true,
      edits: [
        { search: '  return a + b;', replace: '  return a - b;' },
        { search: '  return KHONG CO;', replace: 'x' },
      ],
    });
    expect(r2.outcome).toBe('partial');
    expect(readFileSync(file, 'utf8')).toContain('return a - b;');
  });

  it('lỗi rõ ràng khi file không tồn tại', async () => {
    const r = await searchReplaceBatch({
      filePath: join(dir, 'khong-co.ts'),
      edits: [{ search: 'a', replace: 'b' }],
    });
    expect(r.outcome).toBe('none-applied');
    expect(r.error).toContain('không tồn tại');
  });
});
