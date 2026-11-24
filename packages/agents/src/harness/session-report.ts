// v0.4.9 A3: Agent Work Loop Harness — Session Evidence Report
//
// Renders a WorkLoopReview into a durable, reader-safe Markdown report. No raw
// prompts, commands, paths, or secrets are emitted: every free-text field is
// sanitized through InputSanitizer (packages/security) and the shared
// pii-redaction middleware — nothing is reimplemented here. The emission bar
// is re-enforced at render time so hand-built reviews cannot bypass it.

import { InputSanitizer } from '@ghita/security';
import type { ManagedAgent } from '../runtime.js';
import type { MiddlewareContext } from '../middleware/types.js';
import { createPiiRedactionMiddleware } from '../middleware/context-middleware.js';
import { HumanMessage } from '../messages/message.js';
import { passesEmissionBar } from './work-loop.js';
import type { WorkLoopReview } from './types.js';

const DIMENSION_LABELS: Record<string, string> = {
  'task-understanding': 'Task Understanding',
  'controlled-execution': 'Controlled Execution',
  'change-validation': 'Change Validation',
  'reliable-delivery': 'Reliable Delivery',
  'learning-capture': 'Learning Capture',
};

const sanitizer = new InputSanitizer();
const piiRedaction = createPiiRedactionMiddleware();

/**
 * Sanitize one free-text field for the reader-safe report: strip injected
 * scripts/handlers via InputSanitizer.scan, then redact PII (emails, API
 * keys, tokens, private keys…) through the shared pii-redaction middleware.
 */
async function sanitizeText(text: string): Promise<string> {
  const { cleaned } = sanitizer.scan(text, 'session-report');
  const context: MiddlewareContext = {
    // The pii-redaction middleware only reads `messages`; a bare agent stub
    // is enough for this offline, report-local pass.
    agent: {} as unknown as ManagedAgent,
    messages: [new HumanMessage(cleaned)],
    metadata: {},
  };
  const result = await piiRedaction.preModel?.(context);
  return result?.messages?.[0]?.getText() ?? cleaned;
}

/**
 * Render a WorkLoopReview into a Markdown session-evidence report.
 */
export async function renderSessionReport(review: WorkLoopReview): Promise<string> {
  const lines: string[] = [];
  const episodeId = await sanitizeText(review.episodeId);
  const goal = await sanitizeText(review.goal);
  lines.push(`# Agent Work Loop Report — ${episodeId}`);
  lines.push('');
  lines.push(`**Goal:** ${goal}`);
  lines.push(`**Loop Effectiveness:** ${review.loopEffectiveness}/100`);
  if (review.sessionLimited) {
    lines.push('');
    lines.push('> ⚠️ `session-limited` review — some behavior remained Unobserved.');
  }
  lines.push('');

  lines.push('## Dimensions');
  lines.push('');
  lines.push('| Dimension | Score | Highest evidence | Ceiling |');
  lines.push('| --- | ---: | --- | ---: |');
  for (const dim of review.dimensions) {
    const label = DIMENSION_LABELS[dim.dimension] ?? dim.dimension;
    lines.push(`| ${label} | ${dim.score} | ${dim.highestEvidence} | ${dim.ceiling} |`);
  }
  lines.push('');

  // Per-check detail.
  for (const dim of review.dimensions) {
    const label = DIMENSION_LABELS[dim.dimension] ?? dim.dimension;
    lines.push(`### ${label}`);
    lines.push('');
    for (const check of dim.checks) {
      const summary = await sanitizeText(check.summary);
      lines.push(`- **${check.checkId}** — \`${check.state}\`: ${summary}`);
    }
    lines.push('');
  }

  // Emission bar re-check — findings missing any bound field are not rendered.
  const emittable = review.findings.filter(passesEmissionBar);
  if (emittable.length > 0) {
    lines.push('## Findings');
    lines.push('');
    for (const f of emittable) {
      const progress = f.repairProgress ? ` _(repair: ${f.repairProgress})_` : '';
      const [problem, impact, repair, validationRoute] = await Promise.all([
        sanitizeText(f.problem),
        sanitizeText(f.impact),
        sanitizeText(f.repair),
        sanitizeText(f.validationRoute),
      ]);
      lines.push(`### [${f.severity.toUpperCase()}] ${f.id} — ${f.primaryCheck}${progress}`);
      lines.push(`- **Problem:** ${problem}`);
      lines.push(`- **Impact:** ${impact}`);
      lines.push(`- **Repair:** ${repair}`);
      lines.push(`- **Validation:** ${validationRoute}`);
      lines.push('');
    }
  } else {
    lines.push('## Findings');
    lines.push('');
    lines.push('_No repairable findings for this episode._');
    lines.push('');
  }

  return lines.join('\n');
}
