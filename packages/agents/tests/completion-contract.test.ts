// v1.2.0-demo2 P3.5 (Điểm 9 + 10) — xem completion-contract.ts

import { describe, it, expect } from 'vitest';
import {
  parseTaskDone,
  detectFalseDone,
  CompletionGate,
  isManifestComplete,
  pendingReads,
  outOfManifestEditRate,
  type EvidenceManifest,
} from '../src/track5/completion-contract.js';

describe('parseTaskDone (Điểm 9)', () => {
  it('bóc được marker kèm bằng chứng JSON', () => {
    const text =
      'Đã xử lý xong.\n<task-done>{"command":"pnpm test","exitCode":0,"changedFiles":["src/a.ts"],"summary":"sửa lỗi"}</task-done>';
    const s = parseTaskDone(text);
    expect(s?.done).toBe(true);
    expect(s?.evidence.command).toBe('pnpm test');
    expect(s?.evidence.exitCode).toBe(0);
    expect(s?.evidence.changedFiles).toEqual(['src/a.ts']);
  });

  it('chấp nhận marker viết HOA', () => {
    expect(parseTaskDone('<TASK-DONE>{"exitCode":0}</TASK-DONE>')?.evidence.exitCode).toBe(0);
  });

  it('nội dung không phải JSON thì coi là lời tuyên bố trần, KHÔNG bịa bằng chứng', () => {
    const s = parseTaskDone('<task-done>da xong roi</task-done>');
    expect(s?.done).toBe(true);
    expect(s?.evidence.exitCode).toBeUndefined();
    expect(s?.evidence.command).toBeUndefined();
  });

  it('không có marker thì null', () => {
    expect(parseTaskDone('Tôi đang nghĩ...')).toBeNull();
  });
});

describe('detectFalseDone (Điểm 9)', () => {
  it('bắt được lời nói xong trần bằng tiếng Việt lẫn tiếng Anh', () => {
    expect(detectFalseDone('Xong.')).toBe(true);
    expect(detectFalseDone('done')).toBe(true);
    expect(detectFalseDone('Đã hoàn thành!')).toBe(true);
  });

  it('không bắt nhầm văn bản thường', () => {
    expect(detectFalseDone('Tôi sẽ sửa file a.ts')).toBe(false);
  });

  it('có marker thật thì không tính là nói dối', () => {
    expect(detectFalseDone('done <task-done>{"exitCode":0}</task-done>')).toBe(false);
  });
});

describe('CompletionGate (Điểm 9)', () => {
  it('chấp nhận khi có marker + bằng chứng thoả', () => {
    const gate = new CompletionGate();
    const r = gate.evaluate('<task-done>{"command":"pnpm test","exitCode":0}</task-done>');
    expect(r.decision).toBe('accept');
  });

  it('exitCode KHÁC 0 là kiểm tra THẤT BẠI — không được coi là bằng chứng xong', () => {
    const gate = new CompletionGate();
    const r = gate.evaluate('<task-done>{"command":"pnpm test","exitCode":1}</task-done>');
    // Trước đây cặp (command + exitCode bất kỳ) đủ để accept — gate tự đánh
    // mất mục đích ngay với kiểu gian lận phổ biến nhất: nộp lệnh vừa fail.
    expect(r.decision).toBe('reflect');
    expect(r.reason).toMatch(/THẤT BẠI/);
    expect(r.reason).toContain('1');
  });

  it('chỉ có command mà không có exitCode thì chưa đủ bằng chứng', () => {
    const gate = new CompletionGate();
    const r = gate.evaluate('<task-done>{"command":"pnpm test"}</task-done>');
    expect(r.decision).toBe('reflect');
    expect(r.reason).toMatch(/bằng chứng/);
  });

  it('bắt thử lại khi nói xong mà không có bằng chứng', () => {
    const gate = new CompletionGate();
    const r = gate.evaluate('Xong rồi.');
    expect(r.decision).toBe('reflect');
    expect(r.reason).toMatch(/bằng chứng/);
  });

  it('hết số lượt thì DỪNG thay vì đoán tiếp — hỏi người dùng', () => {
    const gate = new CompletionGate(1);
    expect(gate.evaluate('Xong.').decision).toBe('reflect');
    const last = gate.evaluate('Xong.');
    expect(last.decision).toBe('escalate');
    expect(gate.reflectionsUsed).toBe(2);
  });

  it('chưa nói xong thì cho đi tiếp bình thường', () => {
    const gate = new CompletionGate();
    expect(gate.evaluate('Đang sửa tiếp file b.ts...').decision).toBe('accept');
  });

  it('có bằng chứng thì không tốn lượt thử lại nào', () => {
    const gate = new CompletionGate();
    gate.evaluate('<task-done>{"exitCode":0}</task-done>');
    expect(gate.reflectionsUsed).toBe(0);
  });
});

describe('EvidenceManifest (Điểm 10)', () => {
  const manifest: EvidenceManifest = {
    filesToRead: ['src/a.ts', 'src/b.ts'],
    findings: ['a.ts sửa lỗi null check', 'b.ts cần đổi kiểu'],
  };

  it('bản kê đủ thì hoàn chỉnh', () => {
    expect(isManifestComplete(manifest)).toBe(true);
  });

  it('thiếu findings thì không hoàn chỉnh', () => {
    expect(isManifestComplete({ filesToRead: ['src/a.ts'], findings: [] })).toBe(false);
  });

  it('null cũng là không hoàn chỉnh', () => {
    expect(isManifestComplete(null)).toBe(false);
  });

  it('chỉ đọc lại những file CHƯA đọc', () => {
    const pending = pendingReads(manifest, new Set(['src/a.ts']));
    expect(pending).toEqual(['src/b.ts']);
  });

  it('đo tỉ lệ sửa nhầm file ngoài bản kê', () => {
    expect(outOfManifestEditRate(manifest, ['src/a.ts', 'src/b.ts'])).toBe(0);
    expect(outOfManifestEditRate(manifest, ['src/a.ts', 'src/zz.ts'])).toBe(0.5);
    expect(outOfManifestEditRate(manifest, ['src/zz.ts'])).toBe(1);
  });
});
