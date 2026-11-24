// StandardRequest canonical layer (Track S2).
//
// One canonical request shape that every provider adapter translates into its
// wire format. The four wire-format families are: openai-compat, anthropic,
// google, ollama. Renderers reproduce the EXACT request bodies the providers
// built inline before standardization (byte parity — guarded by tests), so the
// canonical layer is a pure refactor with no behavioral drift.
//
// Clean-room design: the canonical shape and the retry/pool semantics were
// written from design descriptions only (ds2api sources are AGPL and were not
// consulted while writing this code).

import type { ChatMessage, ChatOptions, ChatToolCall, ChatToolDefinition } from './types.js';
import { toOpenAIChatMessages, toOpenAITools } from './providers/openai-tool-calling.js';
import { anthropicToolFields, toAnthropicMessages } from './providers/anthropic-tool-calling.js';
import {
  googleSystemInstruction,
  googleToolFields,
  toGoogleContents,
} from './providers/google-tool-calling.js';

// --- Canonical types ---

export type StandardRole = 'user' | 'assistant' | 'system' | 'tool';

export interface StandardToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface StandardMessage {
  role: StandardRole;
  content: string;
  /** Required for a `tool` role message. */
  toolCallId?: string;
  /** Calls produced by an assistant message. */
  toolCalls?: StandardToolCall[];
}

export interface StandardToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type StandardToolChoice = 'auto' | 'none' | 'required';

/** The four wire-format families every provider adapter translates to. */
export type StandardWireFormat = 'openai' | 'anthropic' | 'google' | 'ollama';

export interface StandardRequest {
  /** Wire-format family this request renders into. */
  wire: StandardWireFormat;
  model: string;
  messages: StandardMessage[];
  tools?: StandardToolDefinition[];
  toolChoice?: StandardToolChoice;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  signal?: AbortSignal;
  /** Structured-output passthrough (Ollama `format`). */
  responseFormat?: Record<string, unknown> | 'json';
  /** Reasoning toggle passthrough (Ollama `think`). */
  reasoning?: boolean | string;
}

// Note: StandardMessage/StandardToolCall/StandardToolDefinition are
// intentionally structurally identical to ChatMessage/ChatToolCall/
// ChatToolDefinition so the existing per-provider helpers keep working and so
// callers can migrate without a mapping step. The canonical types exist so the
// wire layer can evolve (e.g. multi-part content in a future track) without
// touching every provider signature.

// --- Canonical builder ---

export interface StandardRequestConfig {
  wire: StandardWireFormat;
  model: string;
  /** Resolved max tokens (provider getter result). */
  maxTokens?: number;
  /** Resolved temperature (provider getter result). */
  temperature?: number;
}

/** Build the canonical request from the runtime message/options pair. */
export function toStandardRequest(
  messages: ChatMessage[],
  options: ChatOptions | undefined,
  config: StandardRequestConfig,
): StandardRequest {
  const extras = (options ?? {}) as Record<string, unknown>;
  return {
    wire: config.wire,
    model: config.model,
    messages: messages.map(toStandardMessage),
    tools: options?.tools,
    toolChoice: options?.toolChoice,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    topP: options?.topP,
    stopSequences: options?.stop,
    signal: options?.signal,
    responseFormat: extras['format'] as Record<string, unknown> | 'json' | undefined,
    reasoning: extras['think'] as boolean | string | undefined,
  };
}

function toStandardMessage(message: ChatMessage): StandardMessage {
  const standard: StandardMessage = { role: message.role, content: message.content };
  if (message.toolCallId !== undefined) standard.toolCallId = message.toolCallId;
  if (message.toolCalls !== undefined) standard.toolCalls = message.toolCalls;
  return standard;
}

// --- OpenAI-compatible wire (openai / custom / vendor / azure / groq / mistral) ---

export interface OpenAIWireOptions {
  /** `stream: true` in the body; omit the key entirely when undefined. */
  stream?: boolean;
  /** Emit `top_p` + `stop` (official chat-completions style APIs). */
  samplingExtras?: boolean;
  /** CustomProvider usage hint: `stream_options: { include_usage: true }`. */
  streamOptions?: { include_usage: boolean };
  /** Omit the `model` field (Azure: the deployment lives in the URL). */
  omitModel?: boolean;
}

/**
 * Render the canonical request as an OpenAI chat-completions body.
 * Key insertion order mirrors the pre-standardization bodies exactly
 * (JSON.stringify bytes must not change).
 */
export function renderOpenAIChatRequest(
  std: StandardRequest,
  opts: OpenAIWireOptions = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (!opts.omitModel) body['model'] = std.model;
  body['messages'] = toOpenAIChatMessages(std.messages as ChatMessage[]);

  const tools = toOpenAITools(std.tools as ChatToolDefinition[] | undefined);
  if (tools) {
    body['tools'] = tools;
    body['tool_choice'] = std.toolChoice ?? 'auto';
  }

  body['max_tokens'] = std.maxTokens;
  body['temperature'] = std.temperature;
  if (opts.samplingExtras) {
    body['top_p'] = std.topP;
    body['stop'] = std.stopSequences;
  }
  if (opts.stream !== undefined) body['stream'] = opts.stream;
  if (opts.streamOptions) body['stream_options'] = opts.streamOptions;
  return body;
}

// --- Anthropic wire (messages API) ---

export interface AnthropicWireOptions {
  stream?: boolean;
}

/**
 * Render the canonical request as an Anthropic /v1/messages body.
 * Anthropic ignores temperature/top_p here (pre-standardization behavior) and
 * lifts system messages into the top-level `system` field, appended last.
 */
export function renderAnthropicMessagesRequest(
  std: StandardRequest,
  opts: AnthropicWireOptions = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: std.model,
    max_tokens: std.maxTokens,
    messages: toAnthropicMessages(std.messages as ChatMessage[]),
  };

  const toolFields = anthropicToolFields({
    tools: std.tools as ChatToolDefinition[] | undefined,
    toolChoice: std.toolChoice,
  } as ChatOptions);
  for (const [key, value] of Object.entries(toolFields)) {
    body[key] = value;
  }

  if (opts.stream) body['stream'] = true;

  const systemContent = std.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  if (systemContent) body['system'] = systemContent;

  return body;
}

// --- Google wire (generateContent) ---

export interface GoogleWireOptions {
  stream?: boolean;
}

/**
 * Render the canonical request as a Google Generative Language body.
 * The same body serves both generateContent and streamGenerateContent
 * (the streaming variant only differs in the URL).
 */
export function renderGoogleGenerateContentRequest(
  std: StandardRequest,
  _opts: GoogleWireOptions = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: toGoogleContents(std.messages as ChatMessage[]),
  };

  const systemInstruction = googleSystemInstruction(std.messages as ChatMessage[]);
  if (systemInstruction) body['systemInstruction'] = systemInstruction;

  const toolFields = googleToolFields({
    tools: std.tools as ChatToolDefinition[] | undefined,
    toolChoice: std.toolChoice,
  } as ChatOptions);
  for (const [key, value] of Object.entries(toolFields)) {
    body[key] = value;
  }

  body['generationConfig'] = {
    maxOutputTokens: std.maxTokens,
    temperature: std.temperature,
    topP: std.topP,
    stopSequences: std.stopSequences,
  };

  return body;
}

// --- Ollama wire (/api/chat) ---

export interface OllamaWireOptions {
  stream: boolean;
}

export interface OllamaWireRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream: boolean;
  format?: Record<string, unknown> | 'json';
  /** Legacy passthrough: Ollama tool defs go on the wire as-is. */
  tools?: unknown[];
  think?: boolean | string;
  options: { num_predict?: number; temperature?: number };
}

/**
 * Render the canonical request as an Ollama /api/chat body.
 * Tools are passed through untouched (pre-standardization behavior preserved
 * byte-for-byte; callers historically supplied Ollama-shaped defs here).
 */
export function renderOllamaChatRequest(
  std: StandardRequest,
  opts: OllamaWireOptions,
): OllamaWireRequest {
  const body: OllamaWireRequest = {
    model: std.model,
    messages: std.messages.map((m) => ({ role: m.role, content: m.content ?? '' })),
    stream: opts.stream,
    options: {
      num_predict: std.maxTokens,
      temperature: std.temperature,
    },
  };

  if (std.responseFormat) body.format = std.responseFormat;
  if (std.tools && std.tools.length > 0) body.tools = std.tools as unknown[];
  if (std.reasoning !== undefined) body.think = std.reasoning;

  return body;
}

// --- Shared response-side canonical helpers ---

/** A response counts as "empty" when it carries neither text nor tool calls. */
export function isNonEmptyChatContent(content: string, toolCalls?: ChatToolCall[]): boolean {
  return content.trim().length > 0 || (toolCalls?.length ?? 0) > 0;
}
