// Track 3 — Edit khong hong file: tag hash (3.1), stale recovery (3.2),
// checkpoint/rollback (3.3), atomic write (3.4).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileEditCheckpointer,
  assertEditablePath,
  atomicWriteFileSync,
  fileHashTag,
  listCheckpointRuns,
  pruneCheckpoints,
  snapshotOf,
} from './edit-guard.js';
import { searchReplaceBatch } from './search-replace.js';
import { readFile } from './workspace-tools.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghita-eg-'));
  (globalThis as Record<string, unknown>).ghitaWorkspaceRoot = dir;
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>).ghitaWorkspaceRoot;
  rmSync(dir, { recursive: true, force: true });
});

describe('3.1 — tag hash', () => {
  it('cung tag cho cung noi dung, khac tag khi noi dung khac', () => {
    expect(fileHashTag('a\nb\n')).toBe(fileHashTag('a\nb\n'));
    expect(fileHashTag('a\nb\n')).not.toBe(fileHashTag('a\nb\nx\n'));
  });


  it('readFile them header tag, ca khi doc theo dai dong', async () => {
    const file = join(dir, 'sample.ts');
    writeFileSync(file, ['line1', 'line2', ''].join('\n'), 'utf8');
    const full = await readFile({ filePath: 'sample.ts' });
    expect(full.startsWith('[sample.ts#')).toBe(true);
    const ranged = await readFile({ filePath: 'sample.ts', startLine: 2 });
    expect(ranged.startsWith('[')).toBe(true);
  });
});


describe('3.1/3.2 — tag guard trong searchReplaceBatch', () => {
  const SOURCE = ['function add(a, b) {', '  return a + b;', '}', ''].join('\n');

  it('tag dung thi ap dung binh thuong', async () => {
    const file = join(dir, 'm.ts');
    writeFileSync(file, SOURCE, 'utf8');
    const tag = fileHashTag(SOURCE);
    const result = await searchReplaceBatch({
      filePath: 'm.ts',
      expectedTag: tag,
      edits: [{ search: 'return a + b;', replace: 'return a - b;' }],
    });
    expect(result.outcome).toBe('all-applied');
    expect(result.tagRecovered).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toContain('a - b');
  });

  it('tag lech + khoi tim van khop -> recovery kem canh bao', async () => {
    const file = join(dir, 'm.ts');
    writeFileSync(file, `${SOURCE  }// extra\n`, 'utf8');
    const stale = fileHashTag(SOURCE);
    const result = await searchReplaceBatch({
      filePath: 'm.ts',
      expectedTag: stale,
      edits: [{ search: 'return a + b;', replace: 'return a - b;' }],
    });
    expect(result.outcome).toBe('all-applied');
    expect(result.tagRecovered).toBe(true);
    expect(result.warning).toContain('Tag stale');
    expect(readFileSync(file, 'utf8')).toContain('a - b');
  });

  it('tag lech + khoi tim khong khop -> chan, khong ghi file', async () => {
    const file = join(dir, 'm.ts');
    const current = `${SOURCE  }// user edited this part\n`;
    writeFileSync(file, current, 'utf8');
    const stale = fileHashTag(SOURCE);
    const result = await searchReplaceBatch({
      filePath: 'm.ts',
      expectedTag: stale,
      edits: [{ search: 'return a * b;', replace: 'return a - b;' }],
    });
    expect(result.outcome).toBe('none-applied');
    expect(result.error).toContain('Tag stale');
    expect(readFileSync(file, 'utf8')).toBe(current);
  });
});

describe('3.3 — checkpoint + rollback', () => {
  it('rollback khoi phuc noi dung truoc run (co manifest)', () => {
    const file = join(dir, 'm.ts');
    writeFileSync(file, 'BEFORE\n', 'utf8');
    const cp = new FileEditCheckpointer('run-a', join(dir, '.ghita/checkpoints'));
    cp.captureBefore(file);
    writeFileSync(file, 'AFTER\n', 'utf8');
    const summary = cp.rollback();
    expect(summary.restored).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe('BEFORE\n');
  });

  it('rollback xoa file ma run da tao ra (absent)', () => {
    const file = join(dir, 'new.ts');
    const cp = new FileEditCheckpointer('run-b', join(dir, '.ghita/checkpoints'));
    cp.captureBefore(file); // absent
    writeFileSync(file, 'created\n', 'utf8');
    const summary = cp.rollback();
    expect(summary.deleted).toBe(1);
    expect(existsSync(file)).toBe(false);
  });

  it('prune giu lai keep run moi nhat', () => {
    const root = join(dir, '.ghita/checkpoints');
    for (let i = 0; i < 5; i++) {
      const cp = new FileEditCheckpointer(`run-${  String(i).padStart(4, '0')}`, root);
      cp.captureBefore(join(dir, `f${  i  }.ts`)); // absent -> tao manifest
    }
    const pruned = pruneCheckpoints(root, 3);
    expect(pruned).toBe(2);
    const remaining = existsSync(join(root, 'run-0000', 'manifest.json'));
    expect(remaining).toBe(false);
    expect(existsSync(join(root, 'run-0004', 'manifest.json'))).toBe(true);
  });
});

describe('3.4 — atomic write', () => {
  it('ghi file dung noi dung, khong de lai tmp', () => {
    const file = join(dir, 'atom.ts');
    atomicWriteFileSync(file, 'payload\n');
    expect(readFileSync(file, 'utf8')).toBe('payload\n');
    const leftovers = existsSync(`${file  }.ghita-tmp-${  String(process.pid)}`);
    expect(leftovers).toBe(false);
  });
});
describe('7.1 — PathPolicy', () => {
  it('cho path tuong doi hop le', () => {
    expect(() => assertEditablePath('src/a.ts')).not.toThrow();
    expect(() => assertEditablePath('./nested/b.txt')).not.toThrow();
  });

  it('tu choi URI scheme, path rong, byte null', () => {
    expect(() => assertEditablePath('file://C:/x')).toThrow(/URI scheme/);
    expect(() => assertEditablePath('http://evil')).toThrow(/URI scheme/);
    expect(() => assertEditablePath('')).toThrow(/rỗng/);
    expect(() => assertEditablePath(`a${  String.fromCharCode(0)  }b`)).toThrow(/null/);
  });

  it('tu choi path verbatim Windows va ky tu bidi', () => {
    const V = String.fromCharCode(92, 92, 63, 92);
    expect(() => assertEditablePath(`${V  }C:${  String.fromCharCode(92)  }x`)).toThrow(/verbatim/);
    expect(() => assertEditablePath(`a${  String.fromCharCode(0x202E)  }b`)).toThrow(/bidi/);
  });
});

describe('7.2 — diagnostics writethrough', () => {
  it('provider báo lỗi sau ghi thì tool result có dòng diagnostics', async () => {
    const { registerDiagnosticsProvider, diagnosticsAfterWrite } = await import('./diagnostics.js');
    registerDiagnosticsProvider(async (fp) => ({
      filePath: fp,
      errors: 2,
      warnings: 1,
      first: 'TS2345 at line 3',
    }));
    const note = await diagnosticsAfterWrite('m.ts');
    expect(note).toContain('2 error(s)');
    expect(note).toContain('TS2345');
    registerDiagnosticsProvider(undefined);
  });

  it('không có provider -> no-op; provider sạch -> undefined', async () => {
    const { registerDiagnosticsProvider, diagnosticsAfterWrite, hasDiagnosticsProvider } = await import('./diagnostics.js');
    expect(hasDiagnosticsProvider()).toBe(false);
    expect(await diagnosticsAfterWrite('m.ts')).toBeUndefined();
    registerDiagnosticsProvider(async (fp) => ({ filePath: fp, errors: 0, warnings: 0 }));
    expect(await diagnosticsAfterWrite('m.ts')).toBeUndefined();
    registerDiagnosticsProvider(undefined);
  });
});

describe('7.3 — snapshot/undo API', () => {
  it('listCheckpointRuns + snapshotOf đọc lại nội dung TRƯỚC', () => {
    const root = join(dir, '.ghita/checkpoints');
    const file = join(dir, 'snap.ts');
    writeFileSync(file, 'OLD\n', 'utf8');
    const cp = new FileEditCheckpointer('run-s1', root);
    cp.captureBefore(file);
    writeFileSync(file, 'NEW\n', 'utf8');

    const runs = listCheckpointRuns(root);
    expect(runs).toContain('run-s1');
    expect(snapshotOf('run-s1', file, root)).toBe('OLD\n');
    expect(snapshotOf('run-missing', file, root)).toBeUndefined();
  });
});

describe('9.2 — P1/P2 fix regression', () => {
  it('P1-5: tag hash cùng nền cho file CRLF — read rồi edit không dính stale', async () => {
    const file = join(dir, 'crlf.ts');
    writeFileSync(file, ['function a() {', '  return 1;', '}', ''].join('\r\n'), 'utf8');
    const content = readFileSync(file, 'utf8');
    const tag = fileHashTag(content); // tag lấy từ read (raw CRLF)
    const result = await searchReplaceBatch({
      filePath: 'crlf.ts',
      expectedTag: tag,
      edits: [{ search: 'return 1;', replace: 'return 2;' }],
    });
    expect(result.outcome).toBe('all-applied');
    expect(result.tagRecovered).toBeUndefined(); // KHÔNG stale oan
    expect(readFileSync(file, 'utf8')).toContain('return 2;');
  });
});

describe('R3 debug — CRLF round trip, unicode, permission, rollback đa file', () => {
  it('E1: edit file CRLF xong file VẪN CRLF (không lẫn dòng)', async () => {
    const file = join(dir, 'crlf2.ts');
    writeFileSync(file, `${['a', 'b', 'c'].join('\r\n')  }\r\n`, 'utf8');
    const tag = fileHashTag(readFileSync(file, 'utf8'));
    const r = await searchReplaceBatch({
      filePath: 'crlf2.ts',
      expectedTag: tag,
      edits: [{ search: 'b', replace: 'B' }],
    });
    expect(r.outcome).toBe('all-applied');
    const after = readFileSync(file, 'utf8');
    expect(after).toContain('B');
    expect(after.includes('\r\n')).toBe(true);
    expect(after.replace(/\r\n/g, '').includes('\n')).toBe(false); // không lẫn LF
  });

  it('E2: nội dung unicode (tiếng Việt + emoji) — tag ổn định, edit đúng', async () => {
    const file = join(dir, 'uni.md');
    const content = '# Tiêu đề 🎉\n\nXin chào thế giới!\n';
    writeFileSync(file, content, 'utf8');
    const tag = fileHashTag(content);
    expect(fileHashTag(readFileSync(file, 'utf8'))).toBe(tag);
    const r = await searchReplaceBatch({
      filePath: 'uni.md',
      expectedTag: tag,
      edits: [{ search: 'Xin chào thế giới!', replace: 'Tạm biệt! 👋' }],
    });
    expect(r.outcome).toBe('all-applied');
    expect(readFileSync(file, 'utf8')).toContain('Tạm biệt! 👋');
  });

  it('E3: user từ chối ghi (custom mode) -> none-applied, file nguyên, không checkpoint rác', async () => {
    const file = join(dir, 'perm.ts');
    writeFileSync(file, 'BEFORE\n', 'utf8');
    const before = readFileSync(file, 'utf8');
    (globalThis as Record<string, unknown>).agentPermissionMode = 'custom';
    (globalThis as Record<string, unknown>).approveFileWriteHandler = async () => false;
    try {
      const r = await searchReplaceBatch({
        filePath: 'perm.ts',
        edits: [{ search: 'BEFORE', replace: 'AFTER' }],
      });
      expect(r.outcome).toBe('none-applied');
      expect(r.error).toContain('Permission Denied');
      expect(readFileSync(file, 'utf8')).toBe(before);
    } finally {
      delete (globalThis as Record<string, unknown>).agentPermissionMode;
      delete (globalThis as Record<string, unknown>).approveFileWriteHandler;
    }
  });

  it('E4: checkpoint 1 run chụp NHIỀU file -> rollback cả hai', () => {
    const f1 = join(dir, 'r1.ts');
    const f2 = join(dir, 'r2.ts');
    writeFileSync(f1, 'OLD-1\n', 'utf8');
    writeFileSync(f2, 'OLD-2\n', 'utf8');
    const cp = new FileEditCheckpointer('multi', join(dir, '.ghita/checkpoints'));
    cp.captureBefore(f1);
    cp.captureBefore(f2);
    writeFileSync(f1, 'NEW-1\n', 'utf8');
    writeFileSync(f2, 'NEW-2\n', 'utf8');
    const summary = cp.rollback();
    expect(summary.restored).toBe(2);
    expect(readFileSync(f1, 'utf8')).toBe('OLD-1\n');
    expect(readFileSync(f2, 'utf8')).toBe('OLD-2\n');
  });
});
