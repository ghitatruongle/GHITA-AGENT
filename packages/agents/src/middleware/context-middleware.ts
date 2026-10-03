// Composable middleware for managing agent context quality (pattern:
// langchainjs agents/middleware — summarization, contextEditing, piiRedaction,
// toolError). Each middleware plugs into the existing AgentMiddleware pipeline.
//
// Built-in middlewares:
//   - summarization     : compress old messages into a summary when context
//                         exceeds a char threshold (preModel)
//   - contextEditing    : trim oldest non-system messages to fit budget (preModel)
//   - toolErrorRecovery : convert tool errors into recoverable observations
//                         instead of crashing the run (onError + postTool)
//   - piiRedaction      : mask emails, API keys, tokens in outbound messages
//                         before they reach the model (preModel)

import type { AgentMiddleware, MiddlewareContext, PreModelResult } from './types.js';
import { SystemMessage, ToolMessage, messageFromData } from '../messages/message.js';
import type { BaseMessage } from '../messages/message.js';

// Helpers

function totalChars(msgs: BaseMessage[]): number {
  let sum = 0;
  for (const m of msgs) sum += m.getText().length;
  return sum;
}

/** Regex patterns for common PII. */
const PII_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'EMAIL', re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { label: 'API_KEY', re: /\b(?:sk|pk|ak|rk)[-_]?[a-zA-Z0-9]{20,}\b/gi },
  { label: 'TOKEN', re: /\b(?:ghp|gho|ghu|ghs|glpat|xox[baprs])[-_]?[a-zA-Z0-9]{16,}\b/gi },
  { label: 'AWS_KEY', re: /(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}/g },
  { label: 'PRIVATE_KEY', re: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\sKEY-----[\s\S]*?-----END/g },
];

function redactPii(text: string): string {
  let result = text;
  for (const { label, re } of PII_PATTERNS) {
    result = result.replace(re, `[REDACTED:${label}]`);
  }
  return result;
}

// Summarization Middleware

export interface SummarizationOptions {
  /** Char threshold above which summarization triggers (default: 8000). */
  thresholdChars?: number;
  /** Number of most recent messages to always keep intact (default: 4). */
  keepRecent?: number;
  /** Summary function: receives old messages, returns summary string.
   *  Default: concatenates role + first 80 chars of each message. */
  summarize?: (messages: BaseMessage[]) => string;
}

export function createSummarizationMiddleware(options: SummarizationOptions = {}): AgentMiddleware {
  const threshold = options.thresholdChars ?? 8000;
  const keepRecent = options.keepRecent ?? 4;
  const summarize =
    options.summarize ??
    ((msgs: BaseMessage[]) => {
      const lines = msgs.map((m) => {
        const role = (m.toData() as { role?: string }).role ?? 'unknown';
        const preview = m.getText().slice(0, 80).replace(/\n/g, ' ');
        return `[${role}] ${preview}`;
      });
      return `=== Conversation summary (${msgs.length} earlier messages) ===\n${lines.join('\n')}`;
    });

  return {
    name: 'context-summarization',
    priority: 40,

    async preModel(context: MiddlewareContext): Promise<PreModelResult | void> {
      const chars = totalChars(context.messages);
      if (chars <= threshold || context.messages.length <= keepRecent + 1) return undefined;

      // Split: preserve system prompt (index 0 if system) + recent tail.
      let sysMsg: BaseMessage | undefined;
      let restStart = 0;
      if ((context.messages[0]?.toData() as { role?: string })?.role === 'system') {
        sysMsg = context.messages[0];
        restStart = 1;
      }

      const rest = context.messages.slice(restStart);
      if (rest.length <= keepRecent) return undefined;

      const toSummarize = rest.slice(0, rest.length - keepRecent);
      const toKeep = rest.slice(rest.length - keepRecent);
      const summaryText = summarize(toSummarize);

      const result: BaseMessage[] = [];
      if (sysMsg) result.push(sysMsg);
      result.push(new SystemMessage(summaryText));
      for (const m of toKeep) result.push(m);

      return { messages: result };
    },
  };
}

// Context Editing Middleware

export interface ContextEditingOptions {
  /** Maximum character budget for the full message list (default: 10000). */
  maxChars?: number;
  /** Always preserve the system prompt (default: true). */
  preserveSystemPrompt?: boolean;
}

export function createContextEditingMiddleware(
  options: ContextEditingOptions = {},
): AgentMiddleware {
  const maxChars = options.maxChars ?? 10000;
  const preserveSys = options.preserveSystemPrompt !== false;

  return {
    name: 'context-editing',
    priority: 45,

    async preModel(context: MiddlewareContext): Promise<PreModelResult | void> {
      let chars = totalChars(context.messages);
      if (chars <= maxChars) return undefined;

      // Identify droppable indices (skip system prompt at index 0 if preserving).
      const droppable: number[] = [];
      for (let i = 0; i < context.messages.length; i++) {
        const sysCheck = context.messages[i];
        if (
          preserveSys &&
          i === 0 &&
          sysCheck &&
          (sysCheck.toData() as { role?: string }).role === 'system'
        ) {
          continue;
        }
        droppable.push(i);
      }

      const keep = new Set<number>(Array.from({ length: context.messages.length }, (_, i) => i));
      for (let di = 0; di < droppable.length && chars > maxChars; di++) {
        const idx = droppable[di];
        if (idx === undefined) continue;
        const dropMsg = context.messages[idx];
        if (!dropMsg) continue;
        chars -= dropMsg.getText().length;
        keep.delete(idx);
      }

      const trimmed = context.messages.filter((_, i) => keep.has(i));
      return { messages: trimmed };
    },
  };
}

// Tool Error Recovery Middleware

export interface ToolErrorRecoveryOptions {
  /** Convert tool execution errors into observations instead of throwing (default: true). */
  recoverFromErrors?: boolean;
  /** Prefix for error observations (default: '[Tool Error] '). */
  errorPrefix?: string;
}

export function createToolErrorRecoveryMiddleware(
  options: ToolErrorRecoveryOptions = {},
): AgentMiddleware {
  const recover = options.recoverFromErrors !== false;
  const prefix = options.errorPrefix ?? '[Tool Error] ';

  return {
    name: 'tool-error-recovery',
    priority: 60,

    async onError(_error: Error, _context: MiddlewareContext): Promise<{ retry?: boolean } | void> {
      if (!recover) return undefined;
      // Signal that the pipeline should NOT retry — we'll handle it via postTool instead.
      return { retry: false };
    },

    async postTool(
      toolName: string,
      result: string,
      _context: MiddlewareContext,
    ): Promise<{ modifiedResult?: string } | void> {
      // If the result looks like an error, wrap it so the model can self-correct.
      if (result.startsWith('Error executing tool') || result.startsWith('Error:')) {
        return {
          modifiedResult: `${prefix}${toolName}: ${result}\nPlease adjust your approach or try a different tool.`,
        };
      }
      return undefined;
    },
  };
}

// PII Redaction Middleware

export interface PiiRedactionOptions {
  /** Additional regex patterns to redact beyond the built-in set. */
  extraPatterns?: Array<{ label: string; re: RegExp }>;
}

export function createPiiRedactionMiddleware(options: PiiRedactionOptions = {}): AgentMiddleware {
  const extra = options.extraPatterns ?? [];

  return {
    name: 'pii-redaction',
    priority: 30,

    async preModel(context: MiddlewareContext): Promise<PreModelResult | void> {
      let changed = false;
      const result: BaseMessage[] = context.messages.map((msg) => {
        const original = msg.getText();
        let redacted = redactPii(original);
        for (const { re } of extra) {
          redacted = redacted.replace(re, '[REDACTED:CUSTOM]');
        }
        if (redacted !== original) {
          changed = true;
          // Rebuild message with redacted content.
          const data = msg.toData();
          if (msg instanceof ToolMessage) {
            return new ToolMessage(
              redacted,
              (msg as ToolMessage & { toolCallId?: string }).toolCallId ?? '',
              msg.toolName,
              { metadata: data.metadata },
            );
          }
          // `messageFromData` giữ lại đầy đủ các trường phụ — quan trọng nhất
          // là `toolCalls` của AIMessage. Dùng `new Ctor(...)` chỉ truyền
          // `metadata`, nên chỉ cần MỘT email trong nội dung assistant là
          // TOÀN BỘ lệnh gọi tool của agent bị xoá, vòng tool-calling gãy.
          try {
            return messageFromData({ ...data, content: redacted });
          } catch {
            return msg;
          }
        }
        return msg;
      });

      if (!changed) return undefined;
      return { messages: result };
    },
  };
}
