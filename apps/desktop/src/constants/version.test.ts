// H1.4 — consistency test: 3 chỗ hiển thị version khớp nguồn duy nhất.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { APP_VERSION, APP_VERSION_LABEL } from './version.js';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, '..', '..');

describe('APP_VERSION single source (H1)', () => {
  it('giá trị theo chu kỳ 0.0.2-alpha (owner chốt 2026-11-24)', () => {
    expect(APP_VERSION).toBe('0.0.2-alpha');
    expect(APP_VERSION_LABEL).toBe('v0.0.2-alpha');
  });

  it('khớp tauri.conf.json (nguyên giá trị, gồm cả hậu tố chu kỳ)', () => {
    const conf = JSON.parse(
      readFileSync(join(desktopRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'),
    ) as {
      version: string;
    };
    expect(conf.version).toBe(APP_VERSION);
  });

  it('splash.html hiển thị đúng label', () => {
    const splash = readFileSync(join(desktopRoot, 'public', 'splash.html'), 'utf8');
    expect(splash).toContain(`>${APP_VERSION_LABEL}</div>`);
  });

  it('cả 6 i18n dùng APP_VERSION_LABEL', () => {
    for (const loc of ['en', 'vi', 'zh', 'ja', 'ko', 'ru']) {
      const s = readFileSync(join(desktopRoot, 'src', 'i18n', `${loc}.ts`), 'utf8');
      expect(s).toContain('version: APP_VERSION_LABEL');
    }
  });
});
