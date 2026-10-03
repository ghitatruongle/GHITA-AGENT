#!/usr/bin/env node

// Run: pnpm dogfood

import { execSync } from 'node:child_process';

const PASS = '✅';
const FAIL = '❌';
let passed = 0;
let failed = 0;

const isWin = process.platform === 'win32';
const heapPrefix = isWin
  ? 'set NODE_OPTIONS=--max-old-space-size=8192 && '
  : 'NODE_OPTIONS=--max-old-space-size=8192 ';

function run(name, command) {
  process.stdout.write(`  ${name}... `);
  try {
    execSync(command, { stdio: 'pipe', timeout: 600_000 });
    console.log(PASS);
    passed++;
  } catch (error) {
    console.log(FAIL);
    const output = error.stderr?.toString().trim() || error.stdout?.toString().trim();
    if (output) console.error(`    ${output.split('\n').at(-1)}`);
    failed++;
  }
}

console.log('\n🐕 GHITA CODING AGENT — release dogfood (v0.3.6)\n');

console.log('🔐 Integrity and supply chain:');
run('version sync', 'node scripts/sync-version.mjs --check');
run('artifacts', 'node scripts/check-artifacts.mjs');
run('smell budget (as any ≤ 130)', 'node scripts/count-smells.mjs --max-as-any=130');
run('production audit policy', 'pnpm audit:policy');
run('production license policy', 'pnpm licenses:check');

console.log('\n📦 Build:');
run('packages', 'pnpm build:packages');
run('mobile bundle', 'pnpm --filter @ghita/mobile build');
run('API docs', 'pnpm build:docs');

console.log('\n🔍 Static quality:');
run('typecheck', `${heapPrefix}pnpm exec turbo typecheck --concurrency=1`);
run('tests/ typecheck (root tsconfig)', 'pnpm quality:tests');
run('lint', `${heapPrefix}pnpm exec turbo lint --concurrency=1`);

console.log('\n🧪 Full test suite:');
run('all workspace tests', `${heapPrefix}pnpm test`);

console.log('\n📊 Fresh coverage (T0/T1):');
for (const packageName of [
  'security',
  'agents',
  'communication',
  'ai-engine',
  'memory',
  'skills',
]) {
  run(
    `${packageName} coverage`,
    `${heapPrefix}pnpm --filter @ghita/${packageName} exec vitest run --coverage`,
  );
}
run('tier floors T0/T1', 'node scripts/check-coverage-tiers.mjs --tiers=T0,T1 --require-summaries');

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log('\n⚠️  Release dogfood failed. Fix every blocking check before release.');
  process.exit(1);
}

console.log('\n🎉 Release dogfood passed.');
