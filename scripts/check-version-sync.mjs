#!/usr/bin/env node
// (H1.2) check-version-sync — chặn build khi version hiển thị lệch nguồn.
//
// Nguồn sự thật: apps/desktop/src/constants/version.ts (APP_VERSION)
// Phải khớp:
//   1. apps/desktop/src-tauri/tauri.conf.json version === phần số của APP_VERSION
//   2. splash.html hiển thị 'v' + APP_VERSION
//   3. i18n ×6 dùng APP_VERSION_LABEL (import từ constants)
//   4. ChatMessages dùng APP_VERSION_LABEL
//   5. Anti-stale: src UI không còn chuỗi hiển thị 'v0.0.0' / 'v1.2.0' / 'v1.1.5'
//
// Cách dùng: node scripts/check-version-sync.mjs [--root <dir>]
// Exit 0 = khớp; exit 1 = lệch (kèm danh sách lỗi).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootArgIdx = process.argv.indexOf('--root');
const ROOT = rootArgIdx !== -1 ? process.argv[rootArgIdx + 1] : join(scriptDir, '..');

const errors = [];
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// --- 1. APP_VERSION từ constants (parse bằng regex, không import ESM) ---
let appVersion = '';
try {
  const constants = read('apps/desktop/src/constants/version.ts');
  const m = constants.match(/export const APP_VERSION = '([^']+)';/);
  if (!m) {
    errors.push('constants/version.ts: không tìm thấy "export const APP_VERSION = \'...\';"');
  } else {
    appVersion = m[1];
  }
} catch {
  errors.push('Thiếu apps/desktop/src/constants/version.ts');
}

const expectedLabel = appVersion ? 'v' + appVersion : '';
const numeric = appVersion ? appVersion.replace(/-beta$/, '') : '';

// --- 2. tauri.conf.json version khớp phần số ---
try {
  const conf = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json'));
  if (appVersion && conf.version !== numeric) {
    errors.push(`tauri.conf.json version="${conf.version}" !== APP_VERSION số "${numeric}"`);
  }
} catch (err) {
  errors.push('Không đọc được tauri.conf.json: ' + err.message);
}

// --- 3. splash.html ---
try {
  const splash = read('apps/desktop/public/splash.html');
  if (appVersion && !splash.includes('>' + expectedLabel + '</div>')) {
    errors.push(`splash.html: không hiển thị "${expectedLabel}"`);
  }
} catch (err) {
  errors.push('Không đọc được splash.html: ' + err.message);
}

// --- 4. i18n ×6 dùng APP_VERSION_LABEL ---
for (const loc of ['en', 'vi', 'zh', 'ja', 'ko', 'ru']) {
  try {
    const s = read(join('apps/desktop/src/i18n', loc + '.ts'));
    if (appVersion && !s.includes('version: APP_VERSION_LABEL')) {
      errors.push(`i18n/${loc}.ts: chưa dùng APP_VERSION_LABEL cho app.version`);
    }
  } catch (err) {
    errors.push(`Không đọc được i18n/${loc}.ts: ${err.message}`);
  }
}

// --- 5. ChatMessages dùng APP_VERSION_LABEL ---
try {
  const s = read('apps/desktop/src/components/chat/ChatMessages.tsx');
  if (appVersion && !s.includes('APP_VERSION_LABEL')) {
    errors.push('ChatMessages.tsx: chưa dùng APP_VERSION_LABEL');
  }
  if (appVersion && !s.includes("constants/version")) {
    errors.push('ChatMessages.tsx: thiếu import từ constants/version');
  }
} catch (err) {
  errors.push('Không đọc được ChatMessages.tsx: ' + err.message);
}

// --- 6. Anti-stale: chuỗi version cũ dạng hiển thị trong src UI ---
const stalePatterns = [/v0\.0\.0/g, /'v1\.2\.0'/g, /'v1\.1\.5'/g];
const staleFiles = [
  'apps/desktop/public/splash.html',
  'apps/desktop/src/i18n/en.ts',
  'apps/desktop/src/i18n/vi.ts',
  'apps/desktop/src/i18n/zh.ts',
  'apps/desktop/src/i18n/ja.ts',
  'apps/desktop/src/i18n/ko.ts',
  'apps/desktop/src/i18n/ru.ts',
  'apps/desktop/src/components/chat/ChatMessages.tsx',
  'apps/desktop/src/constants/version.ts',
];
for (const rel of staleFiles) {
  try {
    const s = read(rel);
    for (const pat of stalePatterns) {
      if (pat.test(s)) {
        errors.push(`${rel}: còn chuỗi version cũ ${pat.source}`);
        pat.lastIndex = 0;
      }
    }
  } catch {
    // đã báo lỗi đọc file ở trên nếu thiếu
  }
}

if (errors.length > 0) {
  console.error('❌ check-version-sync FAILED:');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log('✅ check-version-sync OK — version "' + appVersion + '" đồng bộ (' + 'splash/i18n×6/chat/tauri.conf)');
