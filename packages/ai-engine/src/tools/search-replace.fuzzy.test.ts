// T4.2 — fuzzy cascade tests (pattern oh-my-pi pi-edit fuzzy.rs, MIT).
// Bám nguyên tắc: unique → áp kèm warning; ambiguous → không đoán; none →
// did-you-mean. Existing search-replace.test.ts phủ tầng exact/whitespace.
import { describe, expect, it } from 'vitest';
import {
  applyEditBlocks,
  matchSearch,
  type EditBlock,
} from './search-replace.js';
import { similarity } from './search-replace-fuzzy.js';

describe('similarity (Levenshtein)', () => {
  it('giống hệt = 1, khác hoàn toàn ~ 0', () => {
    expect(similarity('const a = 1;', 'const a = 1;')).toBe(1);
    expect(similarity('abc', 'xyz')).toBe(0);
  });

  it('lệch 1 ký tự trên khối đủ dài ≥ 0.95', () => {
    const a = 'function calcTotal(items) {\n  return items.reduce((s, i) => s + i.price, 0);\n}';
    const b = 'function calcTotal(items) {\n  return items.reduce((s, i) => s + i.pricf, 0);\n}';
    expect(similarity(a, b)).toBeGreaterThanOrEqual(0.95);
  });
});

describe('matchSearch tầng fuzzy', () => {
  const content = [
    'export function calcTotal(items: Item[]): number {',
    '  let total = 0;',
    '  for (const it of items) {',
    '    total += it.price * it.qty;',
    '  }',
    '  return total;',
    '}',
  ].join('\n');

  it('khớp gần (1 ký tự khác) → strategy fuzzy + sim', () => {
    const search = [
      'export function calcTotal(items: Item[]): number {',
      '  let total = 0;',
      '  for (const it of items) {',
      '    total += it.price * it.qtx;', // qty → qtx
      '  }',
      '  return total;',
      '}',
    ].join('\n');
    const m = matchSearch(content, search);
    expect(m).not.toBeNull();
    expect(m?.strategy).toBe('fuzzy');
    expect(m?.sim).toBeGreaterThanOrEqual(0.95);
  });

  it('chênh lệch lớn → vẫn miss (không đoán bừa)', () => {
    expect(matchSearch(content, 'hoàn toàn khác bất kỳ đâu\ntrong file này cả')).toBeNull();
  });
});

describe('applyEditBlocks fuzzy cascade', () => {
  const content = [
    'function alpha() {',
    '  doWork(alphaState);',
    '  return 1;',
    '}',
    '',
    'function beta() {',
    '  doWork(betaState);',
    '  return 2;',
    '}',
  ].join('\n');

  it('unique fuzzy hit → áp dụng + warning + sim', () => {
    const edits: EditBlock[] = [
      {
        // 1 ký tự khác ('t' → 'f') → không exact, fuzzy ≥0.95.
        search: 'function alpha() {\n  doWork(alphaStatf);\n  return 1;\n}',
        replace: 'function alpha() {\n  doWork(alphaState);\n  return 10;\n}',
      },
    ];
    const r = applyEditBlocks(content, edits);
    expect(r.outcome).toBe('all-applied');
    expect(r.blocks[0]?.strategy).toBe('fuzzy');
    expect(r.blocks[0]?.sim).toBeGreaterThanOrEqual(0.95);
    expect(r.warning).toContain('fuzzy match');
    expect(r.content).toContain('return 10;');
  });

  it('ambiguous (2 ứng viên ≥ threshold) → không áp, lỗi liệt kê vị trí', () => {
    // Hai cửa sổ chỉ khác chữ số cuối; search lệch 1 ký tự so với CẢ HAI
    // (return 9 so với 1 và 2) → 2 ứng viên ≥0.95 → không được đoán.
    const sym = [
      'function gamma() {',
      '  doWork(alphaState);',
      '  return 1;',
      '}',
      '',
      'function gamma() {',
      '  doWork(alphaState);',
      '  return 2;',
      '}',
    ].join('\n');
    const search = 'function gamma() {\n  doWork(alphaState);\n  return 9;\n}';
    const edits: EditBlock[] = [{ search, replace: 'x' }];
    const r = applyEditBlocks(sym, edits);
    expect(r.outcome).toBe('none-applied');
    expect(r.blocks[0]?.applied).toBe(false);
    expect(r.error).toContain('gần khớp 2 chỗ');
    expect(r.error).toContain('dòng 1');
    expect(r.content).toBe(sym);
  });

  it('no candidate → did-you-mean với sim tốt nhất', () => {
    const edits: EditBlock[] = [
      {
        search: 'function alpha() {\n  doWork(alphaState);\n  return 999999;', // miss rõ
        replace: 'x',
      },
    ];
    const r = applyEditBlocks(content, edits);
    expect(r.outcome).toBe('none-applied');
    expect(r.blocks[0]?.error).toContain('Gần khớp nhất');
  });

  it('exact match không sinh warning fuzzy', () => {
    const r = applyEditBlocks(content, [{ search: '  return 1;', replace: '  return 3;' }]);
    expect(r.outcome).toBe('all-applied');
    expect(r.warning).toBeUndefined();
    expect(r.blocks[0]?.strategy).toBe('exact');
  });

  it('search dài hơn file → miss, không crash', () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const r = applyEditBlocks('ngắn', [{ search: long, replace: 'x' }]);
    expect(r.outcome).toBe('none-applied');
  });
});
