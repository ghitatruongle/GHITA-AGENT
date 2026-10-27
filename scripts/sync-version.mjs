#!/usr/bin/env node
/**
 * Sync / check monorepo package versions.
 *
 *   node scripts/sync-version.mjs            # sync root package version everywhere
 *   node scripts/sync-version.mjs --check    # fail if drift
 *   node scripts/sync-version.mjs --set 0.3.6
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const setIdx = args.indexOf('--set');
const rootPackagePath = join(root, 'package.json');
const rootPackage = JSON.parse(readFileSync(rootPackagePath, 'utf8'));
const TARGET = setIdx >= 0 ? args[setIdx + 1] : rootPackage.version;

if (!TARGET || !/^\d+\.\d+\.\d+([.-].+)?$/.test(TARGET)) {
  console.error(`Invalid version: ${TARGET}`);
  process.exit(2);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function collectPackageJsons() {
  const paths = [rootPackagePath];
  for (const dir of ['packages', 'apps']) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const p = join(base, name.name, 'package.json');
      if (existsSync(p)) paths.push(p);
    }
  }
  const docsPackage = join(root, 'docs', 'package.json');
  if (existsSync(docsPackage)) paths.push(docsPackage);
  return paths;
}

function updateTextVersion(relativePath, replacements) {
  const full = join(root, relativePath);
  if (!existsSync(full)) return;

  const source = readFileSync(full, 'utf8');
  let next = source;
  for (const { pattern, replacement, label, all = false } of replacements) {
    const effectivePattern = all
      ? new RegExp(
          pattern.source,
          pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
        )
      : pattern;
    const matches = all
      ? [...next.matchAll(effectivePattern)]
      : [next.match(effectivePattern)].filter(Boolean);
    if (matches.length === 0) {
      drifts.push(`${relativePath}: missing ${label}`);
      continue;
    }

    for (const match of matches) {
      const current = match[1];
      if (current !== String(replacement)) {
        drifts.push(`${relativePath} ${label}: ${current} != ${replacement}`);
      }
    }
    next = next.replace(effectivePattern, (whole, current) =>
      whole.replace(current, String(replacement)),
    );
  }

  if (!checkOnly && next !== source) writeFileSync(full, next, 'utf8');
}

const drifts = [];
const packageJsons = collectPackageJsons();

for (const p of packageJsons) {
  const data = readJson(p);
  if (data.version !== TARGET) {
    drifts.push(`${p}: ${data.version} != ${TARGET}`);
    if (!checkOnly) {
      data.version = TARGET;
      writeJson(p, data);
    }
  }
}

const manifestPath = join(root, '.release-please-manifest.json');
if (existsSync(manifestPath)) {
  const manifest = readJson(manifestPath);
  if (manifest['.'] !== TARGET) {
    drifts.push(`.release-please-manifest.json: ${manifest['.']} != ${TARGET}`);
    if (!checkOnly) {
      manifest['.'] = TARGET;
      writeJson(manifestPath, manifest);
    }
  }
}

const tauriConfigPath = join(root, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json');
if (existsSync(tauriConfigPath)) {
  const tauriConfig = readJson(tauriConfigPath);
  if (tauriConfig.version !== TARGET) {
    drifts.push(`apps/desktop/src-tauri/tauri.conf.json: ${tauriConfig.version} != ${TARGET}`);
    if (!checkOnly) {
      tauriConfig.version = TARGET;
      writeJson(tauriConfigPath, tauriConfig);
    }
  }
}

const [major, minor, patch] = TARGET.split(/[.-]/).slice(0, 3).map(Number);
// Android versionCode / iOS CURRENT_PROJECT_VERSION must be >= 1 (0 is an
// invalid build number), so 0.x.y-style versions still produce a valid one.
const nativeBuildNumber = Math.max(1, major * 1_000_000 + minor * 1_000 + patch);

updateTextVersion('crates/Cargo.toml', [
  {
    pattern: /^version\s*=\s*"([^"]+)"/m,
    replacement: TARGET,
    label: 'workspace.package version',
  },
]);
updateTextVersion('apps/desktop/src-tauri/Cargo.toml', [
  {
    pattern: /^version\s*=\s*"([^"]+)"/m,
    replacement: TARGET,
    label: 'package version',
  },
]);
updateTextVersion('apps/desktop/src-tauri/Cargo.lock', [
  {
    pattern: /(?<=\[\[package\]\]\r?\nname = "ghita-coding-agent"\r?\nversion = ")([^"]+)/,
    replacement: TARGET,
    label: 'workspace package version',
  },
]);

const cratesWorkspaceToml = join(root, 'crates', 'Cargo.toml');
if (existsSync(cratesWorkspaceToml)) {
  const members = [
    ...readFileSync(cratesWorkspaceToml, 'utf8').matchAll(/members\s*=\s*\[([^\]]+)\]/g),
  ].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((n) => n[1]));
  const cratesLockReplacements = members
    .map((name) => ({
      pattern: new RegExp(`(?<=\\[\\[package\\]\\]\\r?\\nname = "ghita-${name}"\\r?\\nversion = ")([^"]+)`),
      replacement: TARGET,
      label: `${name} version`,
    }));
  if (cratesLockReplacements.length > 0) {
    updateTextVersion('crates/Cargo.lock', cratesLockReplacements);
  }
}
updateTextVersion('apps/mobile/android/app/build.gradle', [
  {
    pattern: /versionCode\s+(\d+)/,
    replacement: nativeBuildNumber,
    label: 'versionCode',
  },
  {
    pattern: /versionName\s+"([^"]+)"/,
    replacement: TARGET,
    label: 'versionName',
  },
]);
updateTextVersion('apps/mobile/ios/GhitaMobile.xcodeproj/project.pbxproj', [
  {
    pattern: /CURRENT_PROJECT_VERSION = ([^;]+);/,
    replacement: nativeBuildNumber,
    label: 'CURRENT_PROJECT_VERSION',
    all: true,
  },
  {
    pattern: /MARKETING_VERSION = ([^;]+);/,
    replacement: TARGET,
    label: 'MARKETING_VERSION',
    all: true,
  },
]);
updateTextVersion('snap/snapcraft.yaml', [
  {
    pattern: /^version:\s*['"]?([^'"\r\n]+)['"]?/m,
    replacement: TARGET,
    label: 'snap version',
  },
]);
updateTextVersion('apps/desktop/public/splash.html', [
  {
    pattern: /<div class="version">v([^<]+)<\/div>/,
    replacement: TARGET,
    label: 'splash html version',
  },
]);

for (const lang of ['en', 'vi', 'zh', 'ja', 'ko', 'ru']) {
  updateTextVersion(`apps/desktop/src/i18n/${lang}.ts`, [
    {
      pattern: /version:\s*'v([^']+)'/,
      replacement: TARGET,
      label: `${lang} i18n version`,
    },
  ]);
}

const versionConstantFiles = [];
const packagesRoot = join(root, 'packages');
for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const indexPath = join('packages', entry.name, 'src', 'index.ts');
  if (existsSync(join(root, indexPath))) versionConstantFiles.push(indexPath);
}
versionConstantFiles.push('packages/shared/src/constants.ts', 'packages/skills/src/types.ts');

for (const file of versionConstantFiles) {
  const full = join(root, file);
  if (!existsSync(full)) continue;
  const source = readFileSync(full, 'utf8');
  const pattern = /((?:APP|[A-Z][A-Z_]*)_VERSION\s*=\s*['"])([^'"]+)(['"])/g;
  let found = false;
  const next = source.replace(pattern, (whole, prefix, current, suffix) => {
    found = true;
    if (current === TARGET) return whole;
    drifts.push(`${file}: ${current} != ${TARGET}`);
    return `${prefix}${TARGET}${suffix}`;
  });
  if (found && !checkOnly && next !== source) writeFileSync(full, next, 'utf8');
}

if (checkOnly) {
  if (drifts.length) {
    console.error('Version drift detected:');
    for (const d of drifts) console.error(' -', d);
    process.exit(1);
  }
  console.info(`OK: all checked versions are ${TARGET}`);
  process.exit(0);
}

console.info(`Synced version -> ${TARGET}`);
if (drifts.length) {
  console.info(`Updated ${drifts.length} locations.`);
} else {
  console.info('Already in sync.');
}
