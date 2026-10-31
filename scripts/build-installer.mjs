import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const DEBUG = process.argv.includes('--debug');

// --- 1. Version (single source of truth: apps/desktop/src-tauri/tauri.conf.json)
const tauriConf = JSON.parse(
  require('fs').readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
);
const VERSION = tauriConf.version;
const PRODUCT = (tauriConf.productName || 'Ghita Agent')
  .replace(/\s+/g, '-')
  .replace(/[^A-Za-z0-9-]/g, '');

// Fixed output name — deterministic per version, overwritten on every build.
const NSIS_BUNDLE_DIR = join(
  ROOT,
  'apps',
  'desktop',
  'src-tauri',
  'target',
  'release',
  'bundle',
  'nsis',
);
const RELEASE_DIR = join(ROOT, 'release');
const INSTALLER_NAME = `${PRODUCT}-Setup-v${VERSION}.exe`;
const INSTALLER_PATH = join(RELEASE_DIR, INSTALLER_NAME);

function run(cmd, args, opts = {}) {
  console.log(`\n▶ ${cmd} ${args.join(' ')}`);
  let finalCmd = cmd;
  let finalArgs = args;
  if (cmd === 'pnpm') {
    finalCmd = 'npx';
    finalArgs = ['pnpm', ...args];
  }
  execFileSync(finalCmd, finalArgs, { stdio: 'inherit', shell: IS_WIN, ...opts });
}

function sha256(filePath) {
  return createHash('sha256').update(require('fs').readFileSync(filePath)).digest('hex');
}

// --- 2. Build (unless --debug)
if (!DEBUG) {
  console.log('=== GHITA installer build v' + VERSION + ' ===');

  // `createUpdaterArtifacts: true` requires TAURI_SIGNING_PRIVATE_KEY. When it
  // is not set (typical local build), temporarily disable the updater artifact
  // so the build still produces the single installer; restore afterwards.
  // CI/release pipelines that export the private key keep the .sig artifacts.
  const CONF_PATH = join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json');
  const hasSigningKey = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY);
  let originalConf = null;
  if (!hasSigningKey) {
    originalConf = require('fs').readFileSync(CONF_PATH, 'utf8');
    const conf = JSON.parse(originalConf);
    if (conf.bundle?.createUpdaterArtifacts) {
      conf.bundle.createUpdaterArtifacts = false;
      require('fs').writeFileSync(CONF_PATH, JSON.stringify(conf, null, 2) + '\n', 'utf8');
      console.log('ℹ  TAURI_SIGNING_PRIVATE_KEY not set — updater artifacts disabled for this build.');
    }
  }

  try {
    // Build the frontend FIRST. `beforeBuildCommand` is intentionally empty
    // in tauri.conf.json, so without this step the NSIS bundle would package
    // whatever stale `dist/` happened to sit on disk (wrong version strings,
    // stale UI). `build` = sidecar bundle + tsc -b + vite build.
    run('pnpm', ['--filter', '@ghita/desktop', 'build'], {
      cwd: ROOT,
      timeout: 15 * 60 * 1000,
    });

    // Build the frontend + Rust bundle. `--bundles nsis` keeps exactly one
    // installer format (no .msi, no bare .exe) so the output is a single file.
    run('pnpm', ['--filter', '@ghita/desktop', 'tauri', 'build', '--bundles', 'nsis'], {
      cwd: ROOT,
      timeout: 30 * 60 * 1000,
    });
  } finally {
    if (originalConf !== null) {
      require('fs').writeFileSync(CONF_PATH, originalConf, 'utf8');
    }
  }
}

// --- 3. Locate the freshly built installer
if (!existsSync(NSIS_BUNDLE_DIR)) {
  console.error(`\n❌ NSIS bundle dir not found: ${NSIS_BUNDLE_DIR}`);
  console.error('   Run the build first (or use --debug after a manual tauri build).');
  process.exit(1);
}

const candidates = readdirSync(NSIS_BUNDLE_DIR)
  .filter((f) => f.toLowerCase().endsWith('.exe'))
  .filter((f) => !f.toLowerCase().includes('uninstall'))
  .map((f) => join(NSIS_BUNDLE_DIR, f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

if (candidates.length === 0) {
  console.error(`\n❌ No NSIS installer found in ${NSIS_BUNDLE_DIR}`);
  process.exit(1);
}

const source = candidates[0];
console.log(`\n📦 Found installer: ${source}`);
console.log(`   Size: ${(statSync(source).size / 1024 / 1024).toFixed(1)} MB`);

// --- 4. Copy to the fixed release path (single, deterministic artifact)
mkdirSync(RELEASE_DIR, { recursive: true });
copyFileSync(source, INSTALLER_PATH);

const checksum = sha256(INSTALLER_PATH);
writeFileSync(`${INSTALLER_PATH}.sha256`, `${checksum}  ${INSTALLER_NAME}\n`, 'utf8');

// --- 5. Clean up sibling artifacts so `release/` holds exactly ONE file
const artifacts = readdirSync(RELEASE_DIR).filter(
  (f) => f !== INSTALLER_NAME && f !== `${INSTALLER_NAME}.sha256`,
);
for (const f of artifacts) {
  try {
    require('fs').unlinkSync(join(RELEASE_DIR, f));
  } catch {
    /* ignore */
  }
}

console.log('\n' + '='.repeat(56));
console.log('✅ SINGLE-FILE INSTALLER READY');
console.log('='.repeat(56));
console.log(`   ${INSTALLER_PATH}`);
console.log(`   ${INSTALLER_NAME}.sha256`);
console.log(`   SHA-256: ${checksum.slice(0, 16)}…${checksum.slice(-16)}`);
console.log('');
console.log('📤 Distribute this ONE file to users. They run it and the app');
console.log('   installs for the current user — no admin rights needed.');
console.log('='.repeat(56));
