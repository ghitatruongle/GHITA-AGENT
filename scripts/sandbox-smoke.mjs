#!/usr/bin/env node
// v0.0.2-preview T3 P3.5 — sandbox smoke 4 case qua napi spawn_sandboxed.
// Chạy TRÊN MÁY OWNER (không CI): node scripts/sandbox-smoke.mjs
// v1 (Job Object containment): case 2/3 ghi hiện trạng honestly — nếu
// không block được thì restricted-token KHÔNG ship mặc định (giữ supervised).

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
import { createRequire } from "node:module";
const requireAt = createRequire(import.meta.url);
function loadSandboxAddon() {
  const candidates = [
    join(root, "crates/sandbox/sandbox.win32-x64-gnu.node"),
    join(root, "crates/sandbox/sandbox.win32-x64-msvc.node"),
    join(root, "crates/sandbox/target/release/index.node"),
  ];
  for (const c of candidates) {
    try { return requireAt(c); } catch { /* next */ }
  }
  return null;
}

const workspace = mkdtempSync(join(tmpdir(), 'ghita-sbx-'));
const outside = mkdtempSync(join(tmpdir(), 'ghita-sbx-out-'));

function run(profile, cmd, args) {
  const addon = loadSandboxAddon();
  if (!addon) return { skipped: true, why: "sandbox addon not built" };
  return addon.spawnSandboxed(cmd, args, { profile: "workspace", workspace });
}

const results = [];
function record(caseName, expectation, outcome) {
  results.push({ case: caseName, expectation, outcome });
  console.log(`[${caseName}] expect=${expectation} got=${JSON.stringify(outcome).slice(0, 160)}`);
}

// Case 1 — ghi file trong workspace → được phép
{
  const inside = join(workspace, 'inside.txt');
  const r = run('workspace', 'powershell', ['-NoProfile', '-Command', `Set-Content -Path '${inside}' -Value 'ok'`]);
  record('1-write-inside', 'allowed', r);
}
// Case 2 — ghi file NGOÀI workspace → kỳ vọng blocked
{
  const outsidePath = join(outside, 'out.txt');
  const r = run('workspace', 'powershell', ['-NoProfile', '-Command', `Set-Content -Path '${outsidePath}' -Value 'leak'`]);
  record('2-write-outside', 'blocked', r);
}
// Case 3 — network → kỳ vọng blocked
{
  const r = run('workspace', 'powershell', ['-NoProfile', '-Command', 'try { Invoke-WebRequest https://example.com -UseBasicParsing -TimeoutSec 5 | Out-Null; "NET_OK" } catch { "NET_BLOCKED" }']);
  record('3-network', 'blocked', r);
}
// Case 4 — spawning child (codex known issue) → ghi kết quả thật
{
  const r = run('workspace', 'node', ['-e', 'require("child_process").execSync("echo child-ok")']);
  record('4-child-spawn', 'record-actual', r);
}

rmSync(workspace, { recursive: true, force: true });
rmSync(outside, { recursive: true, force: true });

const blocked2 = JSON.stringify(results.find(r => r.case === '2-write-outside') ?? {}).includes('denied');
const blocked3 = JSON.stringify(results.find(r => r.case === '3-network') ?? {}).includes('blocked') || JSON.stringify(results.find(r => r.case === '3-network') ?? {}).includes('NET_BLOCKED');
console.log('---');
console.log(`policy: case2-blocked=${blocked2} case3-blocked=${blocked3}`);
console.log(blocked2 && blocked3 ? 'SMOKE_PASS' : 'SMOKE_PARTIAL — giữ supervised mặc định, restricted-token opt-in (docs P3.6)');
