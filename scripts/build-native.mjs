#!/usr/bin/env node

// Builds all napi-rs addons for the current platform:
//   crates/secscan · crates/retrieval · crates/codegraph · packages/memory/rust-napi
// Outputs land next to each crate dir (*.node) where @ghita/native-bridge and
// the memory loader probe for them.
// Usage: node scripts/build-native.mjs [--skip-tests] [--disk-check-only]

import { execSync, execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skipTests = process.argv.includes('--skip-tests');
const diskCheckOnly = process.argv.includes('--disk-check-only');

/** Abort build when the workspace drive is close to full (plan v0.0.2-preview GC#5).
 *  Warn-only during real builds; `--disk-check-only` exits 3 when below the floor. */
function getFreeBytes(driveRoot) {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-PSDrive ${JSON.stringify(driveRoot.slice(0, 1))}).Free`], { encoding: 'utf8' });
    return Number(out.trim());
  }
  const out = execFileSync('df', ['-k', driveRoot], { encoding: 'utf8' });
  const line = out.trim().split('\n').pop();
  return Number(line.trim().split(/\s+/)[3]) * 1024;
}

function assertDiskGuard() {
  const free = getFreeBytes(root);
  const freeGB = (free / 1024 ** 3).toFixed(1);
  console.log(`[disk-guard] free on workspace drive: ${freeGB} GB`);
  if (free < 12 * 1024 ** 3) {
    const msg = `[disk-guard] WARNING: only ${freeGB} GB free (< 12 GB floor) — clean crates/target or src-tauri/target before heavy builds`;
    console.log(msg);
    if (diskCheckOnly) {
      console.error(msg);
      process.exit(3);
    }
  }
}

/** crates that build the napi surface behind the `addon` feature. */
const ADDON_CRATES = [
  { name: 'secscan', dir: 'crates/secscan', args: ['--features', 'addon'] },
  { name: 'retrieval', dir: 'crates/retrieval', args: ['--features', 'addon'] },
  { name: 'codegraph', dir: 'crates/codegraph', args: ['--features', 'addon'] },
  { name: 'sandbox', dir: 'crates/sandbox', args: ['--features', 'addon'] },
  { name: 'tokenizer', dir: 'crates/tokenizer', args: ['--features', 'addon'] },
  { name: 'docloader', dir: 'crates/docloader', args: ['--features', 'addon'] },
  { name: 'store', dir: 'crates/store', args: ['--features', 'addon,vec'] },
  { name: 'patch', dir: 'crates/patch', args: ['--features', 'addon'] },
  { name: 'pty', dir: 'crates/pty', args: ['--features', 'addon'] },
  { name: 'engine', dir: 'crates/engine', args: ['--features', 'full'] },
  // memory addon lives in the package tree (its own Cargo.lock, no features)
  { name: 'memory-napi', dir: 'packages/memory/rust-napi', args: [] },
];

function sh(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

assertDiskGuard();

if (!skipTests) {
  console.log('== cargo test (workspace) ==');
  sh('cargo test --workspace', { cwd: join(root, 'crates'), env: { ...process.env, RUST_MIN_STACK: '134217728', CARGO_BUILD_JOBS: '1' } });
  console.log('\n== cargo test (memory addon) ==');
  sh('cargo test', { cwd: join(root, 'packages/memory/rust-napi') });
}

for (const crate of ADDON_CRATES) {
  const cwd = join(root, crate.dir);
  const featureArgs = crate.args.join(' ');
  console.log(`\n== napi build ${crate.name} (${crate.dir}) ==`);
  sh(
    `pnpm --filter @ghita/memory exec napi build --cwd "${cwd.replaceAll('\\', '/')}" --platform --release ${featureArgs}`,
    { cwd: root },
  );
}

console.log('\nAll native addons built.');

// NOTE: the CPU bench gate is non-blocking on push (see build-native.yml) —
// shared-runner micro-bench variance; blocking only in quality-gates (PR/nightly).
