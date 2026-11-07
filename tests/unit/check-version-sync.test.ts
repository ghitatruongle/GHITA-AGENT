// H1.4 — test cho check-version-sync (H1.2): khớp -> exit 0; lệch -> exit 1.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'check-version-sync.mjs');

function makeFixture(overrides: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghita-vsync-'));
  const w = (rel: string, content: string): void => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content, 'utf8');
  };
  const defaults: Record<string, string> = {
    'apps/desktop/src/constants/version.ts': "export const APP_VERSION = '0.0.1-beta';",
    'apps/desktop/src-tauri/tauri.conf.json': '{ "version": "0.0.1" }',
    'apps/desktop/public/splash.html': '<div class="version">v0.0.1-beta</div>',
  };
  for (const loc of ['en', 'vi', 'zh', 'ja', 'ko', 'ru']) {
    defaults[`apps/desktop/src/i18n/${loc}.ts`] = "version: APP_VERSION_LABEL,";
  }
  defaults['apps/desktop/src/components/chat/ChatMessages.tsx'] =
    "import { APP_VERSION_LABEL } from '../constants/version';";
  const files = { ...defaults, ...overrides };
  for (const [rel, content] of Object.entries(files)) w(rel, content);
  return dir;
}

function runSync(root: string): { status: number; output: string } {
  try {
    const out = execFileSync('node', [SCRIPT, '--root', root], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, output: out };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

describe('check-version-sync (H1.2)', () => {
  it('fixture KHỚP nguồn -> exit 0', () => {
    const dir = makeFixture();
    try {
      const r = runSync(dir);
      expect(r.status).toBe(0);
      expect(r.output).toContain('check-version-sync OK');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('splash còn v0.0.0 -> exit 1 kèm lý do rõ', () => {
    const dir = makeFixture({
      'apps/desktop/public/splash.html': '<div class="version">v0.0.0</div>',
    });
    try {
      const r = runSync(dir);
      expect(r.status).toBe(1);
      expect(r.output).toContain('FAILED');
      expect(r.output).toContain('splash.html');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tauri.conf lệch với APP_VERSION -> exit 1', () => {
    const dir = makeFixture({
      'apps/desktop/src-tauri/tauri.conf.json': '{ "version": "9.9.9" }',
    });
    try {
      const r = runSync(dir);
      expect(r.status).toBe(1);
      expect(r.output).toContain('tauri.conf.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('i18n thiếu APP_VERSION_LABEL -> exit 1', () => {
    const dir = makeFixture({
      'apps/desktop/src/i18n/vi.ts': "    version: 'v0.0.0',",
    });
    try {
      const r = runSync(dir);
      expect(r.status).toBe(1);
      expect(r.output).toContain('i18n/vi.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('chạy trên repo thật -> exit 0 (bằng chứng cây hiện tại đồng bộ)', () => {
    const r = runSync(process.cwd());
    expect(r.status).toBe(0);
  });
});
