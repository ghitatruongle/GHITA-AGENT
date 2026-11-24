// Cold-start probe for desktop-smoke [D1].
//
// MUST run with plain `node` (no --import tsx). The tsx loader installs an ESM
// resolve hook, so every import pays a TypeScript-transform check; measuring
// inside the tsx process reported loader overhead (~1.0s -> ~2.6s on the same
// machine) instead of the import cost of the built packages, which made the
// D1 budget flaky on shared CI runners.
//
// Prints one JSON line: {"startupMs": <number>}

import { performance } from 'node:perf_hooks';

const modules = [
  '../packages/ai-engine/dist/index.js',
  '../packages/skills/dist/index.js',
  '../packages/agents/dist/index.js',
  '../packages/memory/dist/index.js',
  '../packages/security/dist/index.js',
  '../packages/native-bridge/dist/index.js',
];

const t0 = performance.now();
await Promise.all(modules.map((rel) => import(new URL(rel, import.meta.url).href)));
const startupMs = performance.now() - t0;

process.stdout.write(`${JSON.stringify({ startupMs })}\n`);
