// Track S3 P2 — StreamObject protocol: the canonical 5-kind stream vocabulary
// shared by the 4 provider wire formats, the Orchestrator/EventStream bus, and
// the mobile wire (packages/communication).
//
// Everything here is additive over AIStreamChunk: legacy chunks without a
// `type` field classify as text deltas (or tool-call when toolCalls ride on
// the terminal chunk), so S2-era consumers keep working unchanged.

import type { AIStreamChunk, StreamChunkType } from '@ghita/shared';

export type { StreamChunkType };

/** The 5 canonical StreamObject kinds, in stream order. */
export const STREAM_OBJECT_TYPES: readonly StreamChunkType[] = [
  'text-delta',
  'reasoning',
  'tool-call',
  'tool-result',
  'tool-incomplete-result',
];

export function isStreamChunkType(value: unknown): value is StreamChunkType {
  return typeof value === 'string' && (STREAM_OBJECT_TYPES as readonly string[]).includes(value);
}

/**
 * Classify a chunk. An explicit valid `type` wins; otherwise inference:
 * toolCalls present → 'tool-call', anything else → 'text-delta'.
 */
export function streamObjectType(chunk: AIStreamChunk): StreamChunkType {
  if (isStreamChunkType(chunk.type)) return chunk.type;
  if (chunk.toolCalls && chunk.toolCalls.length > 0) return 'tool-call';
  return 'text-delta';
}

// --- Builders (typed chunk constructors for generators and tests) ---

function base(partial?: Partial<AIStreamChunk>): Partial<AIStreamChunk> {
  return partial ? { ...partial } : {};
}

export function textDelta(content: string, partial?: Partial<AIStreamChunk>): AIStreamChunk {
  return { content, done: false, type: 'text-delta', ...base(partial) };
}

export function reasoningDelta(content: string, partial?: Partial<AIStreamChunk>): AIStreamChunk {
  return { content, done: false, type: 'reasoning', ...base(partial) };
}

export function toolCallChunk(
  toolCalls: NonNullable<AIStreamChunk['toolCalls']>,
  partial?: Partial<AIStreamChunk>,
): AIStreamChunk {
  return { content: '', done: true, type: 'tool-call', toolCalls, ...base(partial) };
}

export function toolResultChunk(
  content: string,
  toolCallId?: string,
  partial?: Partial<AIStreamChunk>,
): AIStreamChunk {
  return {
    content,
    done: true,
    type: 'tool-result',
    ...(toolCallId ? { toolCallId } : {}),
    ...base(partial),
  };
}

/** A tool result cut short — abort, error, or a partial payload. */
export function toolIncompleteResultChunk(
  content: string,
  reason: string,
  toolCallId?: string,
  partial?: Partial<AIStreamChunk>,
): AIStreamChunk {
  return {
    content,
    done: true,
    type: 'tool-incomplete-result',
    reason,
    ...(toolCallId ? { toolCallId } : {}),
    ...base(partial),
  };
}

// --- Client-side merge ---

export interface ToolCallRecord {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultRecord {
  toolCallId?: string;
  content: string;
  incomplete: boolean;
  reason?: string;
}

export interface MergedStreamResult {
  /** Concatenated text-delta content. */
  text: string;
  /** Concatenated reasoning content (separate from the visible answer). */
  reasoning: string;
  /** Tool calls seen in order; duplicates (same id, or name+args) collapse. */
  toolCalls: ToolCallRecord[];
  /** Tool results/incomplete results seen in order. */
  toolResults: ToolResultRecord[];
  /** True when at least one tool-incomplete-result arrived. */
  hasIncompleteResults: boolean;
  /** True when a terminal chunk (done: true) was seen. */
  done: boolean;
  /** Model/provider resolved from the chunks (last one wins). */
  model?: string;
  provider?: string;
  /** Last usage block seen on the stream. */
  usage?: AIStreamChunk['usage'];
}

function sameToolCall(a: ToolCallRecord, b: ToolCallRecord): boolean {
  if (a.id && b.id) return a.id === b.id;
  return a.name === b.name && JSON.stringify(a.arguments) === JSON.stringify(b.arguments);
}

/**
 * Fold a sequence of StreamObjects (client-side) into one accumulated result.
 * This is what every consumer (UI, mobile, harness) does instead of manually
 * concatenating `chunk.content` and hoping tool calls arrive exactly once.
 */
export function mergeStreamObjects(objects: Iterable<AIStreamChunk>): MergedStreamResult {
  const merged: MergedStreamResult = {
    text: '',
    reasoning: '',
    toolCalls: [],
    toolResults: [],
    hasIncompleteResults: false,
    done: false,
  };

  for (const obj of objects) {
    const type = streamObjectType(obj);
    if (obj.model) merged.model = obj.model;
    if (obj.provider) merged.provider = obj.provider;
    if (obj.usage) merged.usage = obj.usage;
    if (obj.done) merged.done = true;

    switch (type) {
      case 'text-delta':
        merged.text += obj.content ?? '';
        break;
      case 'reasoning':
        merged.reasoning += obj.content ?? '';
        break;
      case 'tool-call':
        for (const call of obj.toolCalls ?? []) {
          const record: ToolCallRecord = {
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            arguments: call.arguments,
          };
          if (!merged.toolCalls.some((existing) => sameToolCall(existing, record))) {
            merged.toolCalls.push(record);
          }
        }
        break;
      case 'tool-result':
        merged.toolResults.push({
          toolCallId: obj.toolCallId,
          content: obj.content ?? '',
          incomplete: false,
        });
        break;
      case 'tool-incomplete-result':
        merged.hasIncompleteResults = true;
        merged.toolResults.push({
          toolCallId: obj.toolCallId,
          content: obj.content ?? '',
          incomplete: true,
          reason: obj.reason,
        });
        break;
    }
  }

  return merged;
}

// --- Mobile wire (packages/communication) ---

/**
 * Wire shape for the Socket.IO `chat_chunk` event: same fields as the engine
 * chunk but `text` instead of `content` (matches the existing mobile contract
 * where chat_chunk carries `{ text }`).
 */
export interface StreamObjectWire {
  type: StreamChunkType;
  text: string;
  done: boolean;
  provider?: string;
  model?: string;
  toolCallId?: string;
  reason?: string;
  toolCalls?: ToolCallRecord[];
  usage?: AIStreamChunk['usage'];
}

export function streamObjectToWire(obj: AIStreamChunk): StreamObjectWire {
  const wire: StreamObjectWire = {
    type: streamObjectType(obj),
    text: obj.content ?? '',
    done: obj.done === true,
  };
  if (obj.provider) wire.provider = obj.provider;
  if (obj.model) wire.model = obj.model;
  if (obj.toolCallId) wire.toolCallId = obj.toolCallId;
  if (obj.reason) wire.reason = obj.reason;
  if (obj.toolCalls?.length) wire.toolCalls = obj.toolCalls;
  if (obj.usage) wire.usage = obj.usage;
  return wire;
}

export function streamObjectFromWire(wire: StreamObjectWire): AIStreamChunk {
  const chunk: AIStreamChunk = {
    content: wire.text ?? '',
    done: wire.done === true,
    type: isStreamChunkType(wire.type) ? wire.type : 'text-delta',
  };
  if (wire.provider) chunk.provider = wire.provider as AIStreamChunk['provider'];
  if (wire.model) chunk.model = wire.model;
  if (wire.toolCallId) chunk.toolCallId = wire.toolCallId;
  if (wire.reason) chunk.reason = wire.reason;
  if (wire.toolCalls?.length) chunk.toolCalls = wire.toolCalls;
  if (wire.usage) chunk.usage = wire.usage;
  return chunk;
}
