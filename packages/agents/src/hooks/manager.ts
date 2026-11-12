// Loads `.ghita/hooks.json`, validates rules, and dispatches events with:
//   - depth guard   : re-entrant dispatch (hook → http → sidecar → dispatch)
//                     stops at maxDepth instead of recursing forever
//   - cooldown      : per-rule minimum interval between firings
//   - dedup window  : identical (event, tool, input) suppressed within window
//   - fail-open     : action errors never wedge the agent loop by default
// Blocking semantics: shell exit code 2, or stdout/response JSON
// `{"decision":"block"|"ask","reason":"…"}`.
// Hook event parity with claude-code hooks (reference: anthropics/claude-code
// docs/plugins): dispatch is event-agnostic, so SessionEnd, SubagentStop,
// Notification and UserPromptSubmit flow through the same matcher/cooldown/
// dedup pipeline as the original six events (v0.0.1 T6.1). Typed payloads
// (reason/prompt/subagentId/level/message) reach shell listeners via the
// HOOK_CONTEXT env var and http listeners in the POSTed context body.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type {
  HookActionOutcome,
  HookDispatchContext,
  HookEventName,
  HookFile,
  HookOutcome,
  HookRule,
} from './types.js';
import { HOOK_EVENT_NAMES } from './types.js';

const DEFAULT_SHELL_TIMEOUT_MS = 10_000;
const DEFAULT_HTTP_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_DEPTH = 2;

function toolMatches(pattern: string | undefined, tool: string | undefined): boolean {
  if (!pattern) return true;
  if (!tool) return false;
  if (pattern.endsWith('*')) return tool.startsWith(pattern.slice(0, -1));
  return tool === pattern;
}

function hashContext(ctx: HookDispatchContext): string {
  const input = ctx.input === undefined ? '' : JSON.stringify(ctx.input);
  return createHash('sha256')
    .update(`${ctx.event}|${ctx.tool ?? ''}|${input}`)
    .digest('hex');
}

/** Parse + validate a hooks file payload. Throws with a precise message. */
export function parseHookFile(raw: string): HookFile {
  const data: unknown = JSON.parse(raw);
  if (typeof data !== 'object' || data === null) throw new Error('hooks.json: expected an object');
  const file = data as { version?: unknown; rules?: unknown };
  if (file.version !== 1)
    throw new Error(`hooks.json: unsupported version ${String(file.version)}`);
  if (!Array.isArray(file.rules)) throw new Error('hooks.json: "rules" must be an array');
  for (const [index, entry] of file.rules.entries()) {
    const rule = entry as Partial<HookRule>;
    const at = `hooks.json rules[${index}]`;
    if (typeof rule.id !== 'string' || rule.id.length === 0) throw new Error(`${at}: missing id`);
    if (
      rule.events !== '*' &&
      (!Array.isArray(rule.events) ||
        rule.events.length === 0 ||
        !(rule.events as string[]).every((e) =>
          (HOOK_EVENT_NAMES as readonly string[]).includes(e),
        ))
    ) {
      throw new Error(`${at}: events must be "*" or a non-empty list of hook events`);
    }
    if (typeof rule.action !== 'object' || rule.action === null) {
      throw new Error(`${at}: missing action`);
    }
    const action = rule.action as { type?: unknown };
    if (action.type === 'shell' && typeof (action as { command?: unknown }).command !== 'string') {
      throw new Error(`${at}: shell action requires "command"`);
    }
    if (action.type === 'http' && typeof (action as { url?: unknown }).url !== 'string') {
      throw new Error(`${at}: http action requires "url"`);
    }
    if (action.type === 'block' && typeof (action as { reason?: unknown }).reason !== 'string') {
      throw new Error(`${at}: block action requires "reason"`);
    }
    if (action.type !== 'shell' && action.type !== 'http' && action.type !== 'block') {
      throw new Error(`${at}: unknown action type ${String(action.type)}`);
    }
  }
  return file as unknown as HookFile;
}

export interface HookManagerOptions {
  /** Guard against re-entrant dispatch loops (default 2). */
  maxDepth?: number;
  /** Clock override for tests. */
  now?: () => number;
}

export class HookManager {
  private readonly rules: HookRule[];
  private readonly maxDepth: number;
  private readonly now: () => number;
  private depth = 0;
  private readonly lastFired = new Map<string, number>();
  private readonly lastSignature = new Map<string, number>();

  constructor(rules: HookRule[] = [], options: HookManagerOptions = {}) {
    this.rules = rules;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.now = options.now ?? Date.now;
  }

  /** Load + validate a hooks.json from disk. */
  static fromFile(path: string, options?: HookManagerOptions): HookManager {
    return new HookManager(parseHookFile(readFileSync(path, 'utf8')).rules, options);
  }

  /** Dispatcher compatible with the ReAct runtime boundary. */
  async dispatch(context: HookDispatchContext): Promise<HookOutcome> {
    if (this.depth >= this.maxDepth) {
      return {
        event: context.event,
        decision: 'allow',
        results: [
          {
            ruleId: '__depth_guard__',
            ok: true,
            decision: 'allow',
            reason: `dispatch depth ${this.depth} >= maxDepth ${this.maxDepth} — suppressed`,
            durationMs: 0,
            suppressed: true,
          },
        ],
      };
    }

    this.depth += 1;
    try {
      return await this.dispatchInner(context);
    } finally {
      this.depth -= 1;
    }
  }

  private async dispatchInner(context: HookDispatchContext): Promise<HookOutcome> {
    const results: HookActionOutcome[] = [];
    let decision: 'allow' | 'block' | 'ask' = 'allow';
    let blockedBy: string | undefined;
    let reason: string | undefined;
    const timestamp = this.now();
    const signature = hashContext(context);

    for (const rule of this.rules) {
      if (!this.ruleMatchesEvent(rule, context.event)) continue;
      if (!toolMatches(rule.match?.tool, context.tool)) continue;

      // Cooldown: per-rule minimum interval between firings.
      const cooldownMs = rule.cooldownMs ?? 0;
      const last = this.lastFired.get(rule.id);
      if (cooldownMs > 0 && last !== undefined && timestamp - last < cooldownMs) {
        results.push({
          ruleId: rule.id,
          ok: true,
          decision: 'allow',
          durationMs: 0,
          suppressed: true,
          reason: 'cooldown',
        });
        continue;
      }

      // Dedup: identical (event, tool, input) within the window is skipped.
      const dedupMs = rule.dedupWindowMs ?? 0;
      const sigKey = `${rule.id}:${signature}`;
      const lastSig = this.lastSignature.get(sigKey);
      if (dedupMs > 0 && lastSig !== undefined && timestamp - lastSig < dedupMs) {
        results.push({
          ruleId: rule.id,
          ok: true,
          decision: 'allow',
          durationMs: 0,
          suppressed: true,
          reason: 'dedup',
        });
        continue;
      }

      this.lastFired.set(rule.id, timestamp);
      this.lastSignature.set(sigKey, timestamp);

      const outcome = await this.runAction(rule, context);
      results.push(outcome);
      if (outcome.decision !== 'allow' && decision === 'allow') {
        decision = outcome.decision;
        blockedBy = rule.id;
        reason = outcome.reason;
        // A blocking verdict stops later rules from adding side effects.
        break;
      }
    }

    return {
      event: context.event,
      decision,
      ...(blockedBy !== undefined ? { blockedBy, reason } : {}),
      results,
    };
  }

  private ruleMatchesEvent(rule: HookRule, event: HookEventName): boolean {
    if (rule.events === '*') return true;
    return rule.events.includes(event);
  }

  private async runAction(
    rule: HookRule,
    context: HookDispatchContext,
  ): Promise<HookActionOutcome> {
    const started = this.now();
    const failOpen = rule.failOpen !== false;
    try {
      if (rule.action.type === 'block') {
        return {
          ruleId: rule.id,
          ok: true,
          decision: 'block',
          reason: rule.action.reason,
          durationMs: this.now() - started,
        };
      }
      if (rule.action.type === 'shell') {
        return await this.runShell(rule, context, started);
      }
      return await this.runHttp(rule, context, started);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        ruleId: rule.id,
        ok: false,
        decision: failOpen ? 'allow' : 'block',
        reason: failOpen ? undefined : `hook errored (fail-closed): ${error}`,
        durationMs: this.now() - started,
        error,
      };
    }
  }

  private async runShell(
    rule: HookRule,
    context: HookDispatchContext,
    started: number,
  ): Promise<HookActionOutcome> {
    const action = rule.action as { type: 'shell'; command: string; timeoutMs?: number };
    const timeoutMs = action.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
    return await new Promise<HookActionOutcome>((resolve) => {
      const child = spawn(process.execPath, ['-e', action.command], {
        cwd: context.cwd,
        env: {
          ...process.env,
          HOOK_EVENT: context.event,
          HOOK_TOOL: context.tool ?? '',
          HOOK_SESSION_ID: context.sessionId ?? '',
          HOOK_INPUT: JSON.stringify(context.input ?? {}),
          // Full dispatch context incl. typed claude-code-parity payloads
          // (SessionEnd.reason, UserPromptSubmit.prompt, SubagentStop,
          // Notification) — T6.1.
          HOOK_CONTEXT: JSON.stringify(context),
        },
        windowsHide: true,
      });
      let stdout = '';
      let settled = false;
      const finish = (outcome: HookActionOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(
        () =>
          finish({
            ruleId: rule.id,
            ok: false,
            decision: 'allow',
            durationMs: this.now() - started,
            error: `timeout after ${timeoutMs}ms`,
          }),
        timeoutMs,
      );
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.on('error', (err) =>
        finish({
          ruleId: rule.id,
          ok: false,
          decision: 'allow',
          durationMs: this.now() - started,
          error: err.message,
        }),
      );
      child.on('close', (code) => {
        const parsed = parseDecisionOutput(stdout);
        if (parsed?.decision === 'block' || parsed?.decision === 'ask') {
          finish({
            ruleId: rule.id,
            ok: true,
            decision: parsed.decision,
            reason: parsed.reason ?? `blocked by hook ${rule.id}`,
            durationMs: this.now() - started,
          });
          return;
        }
        // Exit code 2 = blocking verdict (matches the Claude Code hooks contract).
        if (code === 2) {
          finish({
            ruleId: rule.id,
            ok: true,
            decision: 'block',
            reason: stdout.trim() || `hook ${rule.id} exited with code 2`,
            durationMs: this.now() - started,
          });
          return;
        }
        finish({
          ruleId: rule.id,
          ok: code === 0,
          decision: 'allow',
          durationMs: this.now() - started,
          ...(code !== 0 && code !== null ? { error: `exit code ${code}` } : {}),
        });
      });
    });
  }

  private async runHttp(
    rule: HookRule,
    context: HookDispatchContext,
    started: number,
  ): Promise<HookActionOutcome> {
    const action = rule.action as {
      type: 'http';
      url: string;
      method?: 'POST' | 'GET';
      headers?: Record<string, string>;
      timeoutMs?: number;
    };
    const timeoutMs = action.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(action.url, {
        method: action.method ?? 'POST',
        headers: { 'content-type': 'application/json', ...(action.headers ?? {}) },
        body: action.method === 'GET' ? undefined : JSON.stringify(context),
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = parseDecisionOutput(text);
      if (parsed?.decision === 'block' || parsed?.decision === 'ask') {
        return {
          ruleId: rule.id,
          ok: true,
          decision: parsed.decision,
          reason: parsed.reason ?? `blocked by hook ${rule.id}`,
          durationMs: this.now() - started,
        };
      }
      return {
        ruleId: rule.id,
        ok: response.ok,
        decision: 'allow',
        durationMs: this.now() - started,
        ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

interface DecisionOutput {
  decision: 'allow' | 'block' | 'ask';
  reason?: string;
}

/** Parse `{"decision":…}` JSON from hook stdout/response body; tolerate noise. */
export function parseDecisionOutput(stdout: string): DecisionOutput | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  const candidates = [trimmed];
  const jsonStart = trimmed.indexOf('{');
  const jsonEnd = trimmed.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd > jsonStart) candidates.push(trimmed.slice(jsonStart, jsonEnd + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { decision?: unknown; reason?: unknown };
      if (
        (parsed.decision === 'allow' || parsed.decision === 'block' || parsed.decision === 'ask') &&
        typeof parsed.decision === 'string'
      ) {
        return {
          decision: parsed.decision,
          ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
        };
      }
    } catch {
      // try next candidate
    }
  }
  return undefined;
}
