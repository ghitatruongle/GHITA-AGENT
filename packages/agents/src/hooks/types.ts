// Declarative, self-healing hooks (pattern: openclaude hook-chains +
// claude-code hooks + grok-build hook events). Rules live in
// `.ghita/hooks.json` (project) or `~/.ghita/hooks.json` (global); every tool
// boundary in the agent runtime dispatches events through a HookDispatcher.
// Hook event parity with claude-code hooks (reference: anthropics/claude-code
// docs/plugins): SessionEnd, SubagentStop, Notification and UserPromptSubmit
// were added alongside the original six lifecycle events (v0.0.1 T6.1).

/** Lifecycle events a hook rule can subscribe to. */
export type HookEventName =
  | 'SessionStart'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Stop'
  | 'PreCompact'
  | 'SessionEnd'
  | 'SubagentStop'
  | 'Notification'
  | 'UserPromptSubmit';

export const HOOK_EVENT_NAMES: readonly HookEventName[] = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'PreCompact',
  'SessionEnd',
  'SubagentStop',
  'Notification',
  'UserPromptSubmit',
] as const;

/**
 * Why a session ended (claude-code `SessionEnd` reason, T6.1): `logout` the
 * user signed out, `prompt_input` the user left the prompt (/exit, ctrl+c,
 * ctrl+d), `clear` a /clear started a fresh session, `other` anything else
 * (a `-p` run finished, SIGINT/SIGTERM/SIGHUP).
 */
export type SessionEndReason = 'logout' | 'prompt_input' | 'clear' | 'other';

/** Severity of a `Notification` hook event (claude-code parity, T6.1). */
export type HookNotificationLevel = 'info' | 'warning' | 'error';

/** `SessionEnd` payload (claude-code parity, T6.1). */
export interface SessionEndPayload {
  reason: SessionEndReason;
}

/** `SubagentStop` payload (claude-code parity, T6.1). */
export interface SubagentStopPayload {
  subagentId: string;
  /** Conversation thread the subagent ran in, when known. */
  threadId?: string;
}

/** `Notification` payload (claude-code parity, T6.1). */
export interface NotificationPayload {
  level: HookNotificationLevel;
  message: string;
}

/** `UserPromptSubmit` payload (claude-code parity, T6.1). */
export interface UserPromptSubmitPayload {
  prompt: string;
}

/** Input payload handed to matching rules when an event fires. */
export interface HookDispatchContext {
  event: HookEventName;
  /** Tool name for tool-scoped events; agent name otherwise. */
  tool?: string;
  input?: Record<string, unknown>;
  /** Observation/result for PostToolUse. */
  output?: string;
  /** Error message for PostToolUseFailure. */
  error?: string;
  sessionId?: string;
  agentId?: string;
  /** Working directory shell actions run in (defaults to process cwd). */
  cwd?: string;
  // --- claude-code parity payloads (T6.1) ---
  /** SessionEnd: why the session ended. */
  reason?: SessionEndReason;
  /** SubagentStop: id of the subagent that finished. */
  subagentId?: string;
  /** SubagentStop: conversation thread the subagent ran in, when known. */
  threadId?: string;
  /** Notification: severity level. */
  level?: HookNotificationLevel;
  /** Notification: human-readable message. */
  message?: string;
  /** UserPromptSubmit: the prompt text the user submitted. */
  prompt?: string;
}

/** What a hook action decided about the boundary it guards. */
export type HookActionDecision = 'allow' | 'block' | 'ask';

/** Run a shell command; exit code 2 or stdout JSON `{"decision":"block"}` blocks. */
export interface HookShellAction {
  type: 'shell';
  command: string;
  timeoutMs?: number;
}

/** POST the event payload; response JSON `{"decision":"block","reason":"…"}` blocks. */
export interface HookHttpAction {
  type: 'http';
  url: string;
  method?: 'POST' | 'GET';
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** Unconditionally block (used for hard policy rules, no external process). */
export interface HookBlockAction {
  type: 'block';
  reason: string;
}

export type HookAction = HookShellAction | HookHttpAction | HookBlockAction;

/** Matcher: omit to match every tool/agent on the subscribed events. */
export interface HookMatch {
  /** Glob-ish tool match — `*` suffix matches prefixes (e.g. `"terminal.*"`). */
  tool?: string;
}

export interface HookRule {
  id: string;
  /** Events this rule subscribes to. */
  events: HookEventName[] | '*';
  match?: HookMatch;
  action: HookAction;
  /** Minimum ms between two firings of this rule (0 = unlimited). */
  cooldownMs?: number;
  /** Suppress duplicate (event, tool, input-hash) firings within this window. */
  dedupWindowMs?: number;
  /** Fail-open when the action errors (default true — never wedge the agent). */
  failOpen?: boolean;
}

/** Result of executing one rule's action. */
export interface HookActionOutcome {
  ruleId: string;
  ok: boolean;
  decision: HookActionDecision;
  reason?: string;
  durationMs: number;
  error?: string;
  /** Rule matched but was suppressed by cooldown/dedup. */
  suppressed?: boolean;
}

/** Aggregated outcome of dispatching one event. */
export interface HookOutcome {
  event: HookEventName;
  decision: HookActionDecision;
  blockedBy?: string;
  reason?: string;
  results: HookActionOutcome[];
}

/**
 * Boundary a runtime calls to fire hooks. Declared locally so the ReAct agent
 * stays decoupled from the concrete manager (same pattern as PolicyGuard).
 */
export type HookDispatcher = (context: HookDispatchContext) => Promise<HookOutcome> | HookOutcome;

/** Parsed shape of `.ghita/hooks.json`. */
export interface HookFile {
  version: 1;
  rules: HookRule[];
}
