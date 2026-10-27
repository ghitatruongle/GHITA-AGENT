#!/usr/bin/env node

// Diagnoses the development environment and prints actionable fixes.
// Usage:  pnpm doctor          (from the repo root)
// Exit 0 when everything required is present, 1 otherwise.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';

let failures = 0;
let warnings = 0;

const ok = (msg) => console.log(`  \u2705 ${msg}`);
const warn = (msg) => {
  warnings += 1;
  console.log(`  \u26a0\ufe0f  ${msg}`);
};
const fail = (msg) => {
  failures += 1;
  console.log(`  \u274c ${msg}`);
};
const hint = (msg) => console.log(`      \u2192 ${msg}`);
const section = (title) => console.log(`\n\u25b8 ${title}`);

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 15000,
      // On Windows most CLIs are .cmd/.ps1 shims that execFileSync cannot
      // resolve without a shell (pnpm, corepack, ...).
      shell: IS_WIN,
    }).trim();
  } catch {
    return null;
  }
}

function semverSatisfiesMin(version, min) {
  const a = version.split('.').map((n) => parseInt(n, 10) || 0);
  const b = min.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
}

console.log('\n\ud83e\ude7a Ghita Agent \u2014 Doctor');
console.log('='.repeat(48));

// --- 1. Runtime -------------------------------------------------------------
section('Runtime');
{
  const nodeVersion = process.versions.node;
  if (semverSatisfiesMin(nodeVersion, '20.0.0')) {
    ok(`Node.js ${nodeVersion} (>= 20 required)`);
  } else {
    fail(`Node.js ${nodeVersion} is too old (>= 20 required)`);
    hint(IS_WIN ? 'Install from https://nodejs.org or: winget install OpenJS.NodeJS.LTS' : 'Install via nvm: nvm install 20');
  }

  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch {
    /* root package.json missing — reported below */
  }
  const wanted = String(pkg.packageManager || 'pnpm@11.5.2').split('@')[1];
  const pnpmVersion = run('pnpm', ['--version']);
  if (pnpmVersion) {
    if (wanted && pnpmVersion !== wanted) {
      warn(`pnpm ${pnpmVersion} differs from pinned ${wanted} (corepack will usually fix this)`);
      hint(`corepack enable && corepack prepare pnpm@${wanted} --activate`);
    } else {
      ok(`pnpm ${pnpmVersion}`);
    }
  } else {
    fail('pnpm not found on PATH');
    hint('corepack enable   (or: npm install -g pnpm)');
  }

  const gitVersion = run('git', ['--version']);
  if (gitVersion) ok(gitVersion);
  else {
    warn('git not found — version history features will be unavailable');
    hint(IS_WIN ? 'winget install Git.Git' : 'Install git from your package manager');
  }
}

// --- 2. Rust / Tauri ---------------------------------------------------------
section('Rust / Tauri (needed for the desktop app)');
{
  const cargo = run('cargo', ['--version']);
  const rustc = run('rustc', ['--version']);
  if (cargo && rustc) {
    ok(`${cargo}`);
    ok(`${rustc}`);
    if (IS_WIN) {
      const targets = run('rustup', ['target', 'list', '--installed']) || '';
      if (targets.includes('x86_64-pc-windows-msvc')) {
        ok('Rust target x86_64-pc-windows-msvc installed');
      } else {
        fail('Missing Rust target x86_64-pc-windows-msvc');
        hint('rustup target add x86_64-pc-windows-msvc');
      }
      const cl = run('where', ['cl.exe']) || run('link', ['/version']);
      if (!cl) {
        warn('MSVC linker not detected on PATH (ok if you build from a VS Developer shell)');
        hint('Install "Desktop development with C++" via Visual Studio Installer');
      }
    }
  } else {
    fail('Rust toolchain not found (cargo/rustc missing)');
    hint(IS_WIN ? 'winget install Rustlang.Rustup' : 'curl https://sh.rustup.rs -sSf | sh');
  }
}

// --- 3. Workspace state ------------------------------------------------------
section('Workspace');
{
  if (existsSync(path.join(ROOT, 'node_modules'))) {
    ok('node_modules present');
  } else {
    fail('node_modules missing');
    hint('pnpm bootstrap   (runs fix-store + frozen install)');
  }

  const packagesDir = path.join(ROOT, 'packages');
  if (existsSync(packagesDir)) {
    ok('packages/ workspace found');
  } else {
    fail('packages/ directory missing — is this the repo root?');
  }

  const bundle = path.join(ROOT, 'apps', 'desktop', 'src-tauri', 'sidecar', 'server.bundle.mjs');
  if (existsSync(bundle)) {
    ok('sidecar bundle present (server.bundle.mjs)');
  } else {
    warn('sidecar bundle missing — the desktop app will build it, or run:');
    hint('node apps/desktop/scripts/build-sidecar.mjs');
  }
}

// --- 4. System resources -----------------------------------------------------
section('System');
{
  try {
    const stats = statfsSync(ROOT);
    const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3;
    if (freeGb > 5) ok(`Disk free: ${freeGb.toFixed(1)} GB`);
    else {
      warn(`Low disk space: ${freeGb.toFixed(1)} GB free (Rust builds need ~5 GB)`);
    }
  } catch {
    warn('Could not determine free disk space');
  }

  const memGb = os.totalmem() / 1024 ** 3;
  if (memGb >= 8) ok(`RAM: ${memGb.toFixed(1)} GB`);
  else warn(`RAM: ${memGb.toFixed(1)} GB (8 GB+ recommended)`);
}

// --- 5. Sidecar port ---------------------------------------------------------
section('Ports');
{
  const port = Number(process.env.GHITA_LIBERATE_PORTS || 39001);
  const { createServer } = await import('node:net');
  const free = await new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    try {
      srv.listen(port, '127.0.0.1');
    } catch {
      resolve(false);
    }
  });
  if (free) ok(`Sidecar port ${port} is free`);
  else warn(`Port ${port} is busy (another GHITA instance may be running)`);
}

// --- Summary -----------------------------------------------------------------
console.log('\n' + '='.repeat(48));
if (failures === 0) {
  console.log(`\ud83c\udf89 Environment looks good!${warnings ? ` (${warnings} warning(s))` : ''}`);
  console.log('Next steps:  pnpm bootstrap  \u2192  pnpm dev:desktop\n');
  process.exit(0);
} else {
  console.log(`\ud83d\udea8 ${failures} problem(s) found \u2014 fix the \u274c items above, then re-run pnpm doctor.`);
  console.log('Full guide: docs/docs/installation.md\n');
  process.exit(1);
}
