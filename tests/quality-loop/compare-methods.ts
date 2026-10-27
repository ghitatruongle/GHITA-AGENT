//   between PageRank and Regex Search
//
// Usage: npx tsx tests/quality-loop/compare-methods.ts

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MockLLMSearchEngine, compareSearchMethods } from './evaluator.js';
import type { BenchmarkQuery, SearchResult } from './evaluator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const benchmarkPath = path.resolve(__dirname, 'benchmark.json');

// Load benchmark data
const raw = fs.readFileSync(benchmarkPath, 'utf8');
const benchmarkData: { queries: BenchmarkQuery[] } = JSON.parse(raw);
const queries = benchmarkData.queries;

// ====== PageRank-based search (deterministic mock) ======
const mockEngine = new MockLLMSearchEngine(queries);
const pageRankFn = (q: BenchmarkQuery): SearchResult[] => mockEngine.search(q);

// ====== Regex-based search (simulated: broader but noisier) ======
const regexFn = (q: BenchmarkQuery): SearchResult[] => {
  // Simulate regex: always finds the symbol but may include false positives
  const results: SearchResult[] = [
    {
      symbol: q.symbol,
      file: q.file,
      kind: q.expectedKind,
      type: q.expectedType,
      score: 0.5,
    },
  ];

  // 30% chance of adding a false positive (regex is less precise)
  if (q.id % 3 === 0) {
    results.push({
      symbol: q.symbol,
      file: `packages/other/src/${q.symbol.toLowerCase()}.ts`,
      kind: 'reference',
      type: 'unknown',
      score: 0.2,
    });
  }

  return results;
};

// ====== Run comparison ======
console.info('='.repeat(70));
console.info('Ghita Agent — Search Method Comparison Report');
console.info(`Benchmark: ${queries.length} queries`);
console.info('='.repeat(70));

const results = compareSearchMethods(queries, pageRankFn, regexFn);

for (const r of results) {
  console.info(`\n--- ${r.method} ---`);
  console.info(`  Precision:    ${(r.metrics.precision * 100).toFixed(1)}%`);
  console.info(`  Recall:       ${(r.metrics.recall * 100).toFixed(1)}%`);
  console.info(`  F1-Score:     ${(r.metrics.f1Score * 100).toFixed(1)}%`);
  console.info(`  Matched:      ${r.metrics.matchedQueries} / ${r.metrics.totalQueries}`);
  console.info(`  Avg Score:    ${r.metrics.avgScore.toFixed(3)}`);
  console.info(`  Exec Time:    ${r.executionTimeMs.toFixed(2)} ms`);
}

// Summary
const prF1 = results[0].metrics.f1Score;
const rxF1 = results[1].metrics.f1Score;
const winner = prF1 >= rxF1 ? 'PageRank' : 'RegexSearch';
const diff = Math.abs(prF1 - rxF1) * 100;

console.info(`\n${'='.repeat(70)}`);
console.info(`WINNER: ${winner} (F1 diff: ${diff.toFixed(1)}%)`);
console.info('='.repeat(70));
