// Track S2 — StandardRequest parity guard.
//
// The canonical layer must be a pure refactor: for the same runtime input the
// rendered wire body must produce the SAME JSON bytes as the pre-existing
// inline construction (key order included). The "old reference" builders below
// mirror the pre-standardization provider code on purpose — they act as the
// regression baseline.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  toStandardRequest,
  renderOpenAIChatRequest,
  renderAnthropicMessagesRequest,
  renderGoogleGenerateContentRequest,
  renderOllamaChatRequest,
  isNonEmptyChatContent,
} from '../src/standard-request.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { GoogleProvider } from '../src/providers/google.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { CustomProvider } from '../src/providers/custom.js';
import { KimiProvider } from '../src/providers/kimi.js';
import { AzureOpenAIProvider } from '../src/providers/azure-openai.js';
import type { ChatMessage, ChatOptions } from '../src/types.js';
import { toOpenAIChatMessages, openAIToolFields } from '../src/providers/openai-tool-calling.js';
import {
  anthropicToolFields,
  toAnthropicMessages,
} from '../src/providers/anthropic-tool-calling.js';
import {
  googleSystemInstruction,
  googleToolFields,
  toGoogleContents,
} from '../src/providers/google-tool-calling.js';

// --- Shared fixtures ---

const FULL_MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are Ghita.' },
  { role: 'user', content: 'List files then summarize.' },
  {
    role: 'assistant',
    content: 'Calling a tool.',
    toolCalls: [{ id: 'call_1', name: 'list_dir', arguments: { path: '.' } }],
  },
  { role: 'tool', content: '["a.ts"]', toolCallId: 'call_1' },
  { role: 'user', content: 'Thanks, summarize now.' },
];

const FULL_OPTIONS: ChatOptions = {
  model: 'gpt-4o',
  maxTokens: 512,
  temperature: 0.3,
  topP: 0.9,
  stop: ['END'],
  tools: [
    {
      name: 'list_dir',
      description: 'List a directory',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ],
  toolChoice: 'auto',
};

/** Pre-standardization OpenAI chat body construction (parity baseline). */
function oldOpenAIChatBody(
  messages: ChatMessage[],
  options?: ChatOptions,
): Record<string, unknown> {
  return {
    model: options?.model ?? 'gpt-4o',
    messages: toOpenAIChatMessages(messages),
    ...openAIToolFields(options),
    max_tokens: options?.maxTokens ?? 4096,
    temperature: options?.temperature ?? 0.7,
    top_p: options?.topP,
    stop: options?.stop,
  };
}

/** Pre-standardization OpenAI stream body construction (parity baseline). */
function oldOpenAIStreamBody(
  messages: ChatMessage[],
  options?: ChatOptions,
): Record<string, unknown> {
  return {
    model: options?.model ?? 'gpt-4o',
    messages: toOpenAIChatMessages(messages),
    ...openAIToolFields(options),
    max_tokens: options?.maxTokens ?? 4096,
    temperature: options?.temperature ?? 0.7,
    stream: true,
  };
}

function canonical(messages: ChatMessage[], options: ChatOptions | undefined) {
  return toStandardRequest(messages, options, {
    wire: 'openai',
    model: options?.model ?? 'gpt-4o',
    maxTokens: options?.maxTokens ?? 4096,
    temperature: options?.temperature ?? 0.7,
  });
}

describe('StandardRequest canonical builder', () => {
  it('carries the resolved model and sampling parameters', () => {
    const std = canonical(FULL_MESSAGES, FULL_OPTIONS);
    expect(std.wire).toBe('openai');
    expect(std.model).toBe('gpt-4o');
    expect(std.maxTokens).toBe(512);
    expect(std.temperature).toBe(0.3);
    expect(std.topP).toBe(0.9);
    expect(std.stopSequences).toEqual(['END']);
    expect(std.tools).toHaveLength(1);
    expect(std.toolChoice).toBe('auto');
    expect(std.messages).toHaveLength(FULL_MESSAGES.length);
  });

  it('passes through Ollama extras (format/think) from options', () => {
    const std = toStandardRequest(
      [{ role: 'user', content: 'hi' }],
      {
        format: 'json',
        think: true,
      } as ChatOptions,
      { wire: 'ollama', model: 'llama3' },
    );
    expect(std.responseFormat).toBe('json');
    expect(std.reasoning).toBe(true);
  });

  it('reports non-empty content correctly', () => {
    expect(isNonEmptyChatContent('  ')).toBe(false);
    expect(isNonEmptyChatContent('')).toBe(false);
    expect(isNonEmptyChatContent('', [{ name: 't', arguments: {} }])).toBe(true);
    expect(isNonEmptyChatContent('text')).toBe(true);
  });
});

describe('OpenAI wire parity — same input, same bytes', () => {
  it('chat with full options renders byte-identical body', () => {
    const std = canonical(FULL_MESSAGES, FULL_OPTIONS);
    const rendered = renderOpenAIChatRequest(std, { samplingExtras: true });
    expect(JSON.stringify(rendered)).toBe(
      JSON.stringify(oldOpenAIChatBody(FULL_MESSAGES, FULL_OPTIONS)),
    );
  });

  it('chat without tools renders byte-identical body', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ];
    const options: ChatOptions = { maxTokens: 100, temperature: 0.5 };
    const std = canonical(messages, options);
    const rendered = renderOpenAIChatRequest(std, { samplingExtras: true });
    expect(JSON.stringify(rendered)).toBe(JSON.stringify(oldOpenAIChatBody(messages, options)));
  });

  it('stream body omits top_p/stop like the legacy stream construction', () => {
    const std = canonical(FULL_MESSAGES, FULL_OPTIONS);
    const rendered = renderOpenAIChatRequest(std, { stream: true });
    expect(JSON.stringify(rendered)).toBe(
      JSON.stringify(oldOpenAIStreamBody(FULL_MESSAGES, FULL_OPTIONS)),
    );
    expect('top_p' in rendered).toBe(false);
    expect('stop' in rendered).toBe(false);
    expect(rendered['stream']).toBe(true);
  });

  it('undefined topP/stop are dropped from serialized bytes like the legacy body', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'x' }];
    const std = canonical(messages, { maxTokens: 10, temperature: 0.2 });
    const rendered = renderOpenAIChatRequest(std, { samplingExtras: true });
    const bytes = JSON.stringify(rendered);
    expect(bytes).not.toContain('top_p');
    expect(bytes).not.toContain('"stop"');
    expect(bytes).toBe(
      JSON.stringify(oldOpenAIChatBody(messages, { maxTokens: 10, temperature: 0.2 })),
    );
  });
});

describe('OpenAIProvider — end-to-end request bytes parity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('chat sends the legacy-identical body over the wire', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            model: 'gpt-4o',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider({ type: 'openai', apiKey: 'k' });
    await provider.chat(FULL_MESSAGES, FULL_OPTIONS);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect(JSON.stringify(sentBody)).toBe(
      JSON.stringify(oldOpenAIChatBody(FULL_MESSAGES, FULL_OPTIONS)),
    );
  });

  it('chatStream sends the legacy-identical body over the wire', async () => {
    const sse = ['data: {"choices":[{"delta":{"content":"hi"}}]}', 'data: [DONE]', ''].join('\n');
    const fetchMock = vi.fn(
      async () =>
        new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider({ type: 'openai', apiKey: 'k' });
    for await (const _chunk of provider.chatStream(FULL_MESSAGES, FULL_OPTIONS)) {
      void _chunk;
    }

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect(JSON.stringify(sentBody)).toBe(
      JSON.stringify(oldOpenAIStreamBody(FULL_MESSAGES, FULL_OPTIONS)),
    );
  });
});

describe('Other wire renderers — canonical shape (P2 parity baselines live beside these)', () => {
  it('Anthropic renderer lifts system messages and maps tool choice', () => {
    const std = { ...canonical(FULL_MESSAGES, FULL_OPTIONS), wire: 'anthropic' as const };
    const rendered = renderAnthropicMessagesRequest(std, { stream: false });
    expect(rendered['model']).toBe('gpt-4o');
    expect(rendered['system']).toBe('You are Ghita.');
    expect(rendered['max_tokens']).toBe(512);
    const messages = rendered['messages'] as Array<Record<string, unknown>>;
    expect(messages.every((m) => m['role'] !== 'system')).toBe(true);
    const tools = rendered['tools'] as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ name: 'list_dir' });
    expect(rendered['tool_choice']).toEqual({ type: 'auto' });
  });

  it('Google renderer maps contents/generationConfig', () => {
    const std = { ...canonical(FULL_MESSAGES, FULL_OPTIONS), wire: 'google' as const };
    const rendered = renderGoogleGenerateContentRequest(std);
    expect(rendered['systemInstruction']).toEqual({ parts: [{ text: 'You are Ghita.' }] });
    expect(rendered['generationConfig']).toEqual({
      maxOutputTokens: 512,
      temperature: 0.3,
      topP: 0.9,
      stopSequences: ['END'],
    });
    const contents = rendered['contents'] as Array<{ role: string; parts: unknown[] }>;
    expect(contents.every((c) => c.role === 'user' || c.role === 'model')).toBe(true);
  });

  it('Ollama renderer keeps the legacy passthrough bodies', () => {
    const std = toStandardRequest(
      [{ role: 'user', content: 'hi' }],
      {
        format: 'json',
        think: true,
      } as ChatOptions,
      { wire: 'ollama', model: 'llama3', maxTokens: 64, temperature: 0.1 },
    );
    const rendered = renderOllamaChatRequest(std, { stream: true });
    expect(rendered).toEqual({
      model: 'llama3',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      options: { num_predict: 64, temperature: 0.1 },
      format: 'json',
      think: true,
    });
  });
});

// --- P2: byte-parity baselines for the remaining wire variants ---

/** Pre-standardization Anthropic body construction. */
function oldAnthropicBody(
  messages: ChatMessage[],
  options: ChatOptions | undefined,
  model: string,
  maxTokens: number,
  stream: boolean,
): Record<string, unknown> {
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const systemContent = systemMsgs.map((m) => m.content).join('\n\n');
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: toAnthropicMessages(messages),
    ...anthropicToolFields(options),
  };
  if (stream) body['stream'] = true;
  if (systemContent) body['system'] = systemContent;
  return body;
}

/** Pre-standardization Google body construction. */
function oldGoogleBody(
  messages: ChatMessage[],
  options: ChatOptions | undefined,
  maxTokens: number,
  temperature: number,
): Record<string, unknown> {
  const contents = toGoogleContents(messages);
  const systemInstruction = googleSystemInstruction(messages);
  return {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...googleToolFields(options),
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
      topP: options?.topP,
      stopSequences: options?.stop,
    },
  };
}

/** Pre-standardization Ollama body construction. */
function oldOllamaBody(
  messages: ChatMessage[],
  model: string,
  stream: boolean,
  maxTokens: number,
  temperature: number,
  options?: ChatOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content ?? '' })),
    stream,
    options: { num_predict: maxTokens, temperature },
  };
  const extras = (options ?? {}) as Record<string, unknown>;
  if (extras['format']) body['format'] = extras['format'];
  const tools = extras['tools'] as unknown[] | undefined;
  if (tools && tools.length > 0) body['tools'] = tools;
  if (extras['think'] !== undefined) body['think'] = extras['think'];
  return body;
}

/** Pre-standardization CustomProvider body construction. */
function oldCustomBody(
  messages: ChatMessage[],
  options: ChatOptions | undefined,
  model: string,
  maxTokens: number,
  temperature: number,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAIChatMessages(messages),
    ...openAIToolFields(options),
    max_tokens: maxTokens,
    temperature,
  };
  if (stream) {
    body['stream'] = true;
    body['stream_options'] = { include_usage: true };
  } else {
    body['stream'] = false;
  }
  return body;
}

/** Pre-standardization defineVendor body construction (chat). */
function oldVendorChatBody(
  messages: ChatMessage[],
  options: ChatOptions | undefined,
  model: string,
  maxTokens: number,
  temperature: number,
): Record<string, unknown> {
  return {
    model,
    messages: toOpenAIChatMessages(messages),
    ...openAIToolFields(options),
    max_tokens: maxTokens,
    temperature,
    top_p: options?.topP,
    stop: options?.stop,
    stream: false,
  };
}

/** Pre-standardization Azure body construction. */
function oldAzureBody(
  messages: ChatMessage[],
  options: ChatOptions | undefined,
  maxTokens: number,
  temperature: number,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages: toOpenAIChatMessages(messages),
    ...openAIToolFields(options),
    max_tokens: maxTokens,
    temperature,
  };
  if (stream) {
    body['stream'] = true;
  } else {
    body['top_p'] = options?.topP;
    body['stop'] = options?.stop;
    body['stream'] = false;
  }
  return body;
}

describe('P2 wire parity — renderer vs legacy construction (same bytes)', () => {
  const anthropicModel = 'claude-sonnet-4-20250514';

  it('Anthropic chat + stream bodies match the legacy construction', () => {
    const std = toStandardRequest(FULL_MESSAGES, FULL_OPTIONS, {
      wire: 'anthropic',
      model: anthropicModel,
      maxTokens: 512,
      temperature: 0.3,
    });
    const chat = renderAnthropicMessagesRequest(std);
    const stream = renderAnthropicMessagesRequest(std, { stream: true });
    expect(JSON.stringify(chat)).toBe(
      JSON.stringify(oldAnthropicBody(FULL_MESSAGES, FULL_OPTIONS, anthropicModel, 512, false)),
    );
    expect(JSON.stringify(stream)).toBe(
      JSON.stringify(oldAnthropicBody(FULL_MESSAGES, FULL_OPTIONS, anthropicModel, 512, true)),
    );
  });

  it('Google body matches the legacy construction', () => {
    const std = toStandardRequest(FULL_MESSAGES, FULL_OPTIONS, {
      wire: 'google',
      model: 'gemini-3.5-flash',
      maxTokens: 512,
      temperature: 0.3,
    });
    const rendered = renderGoogleGenerateContentRequest(std);
    expect(JSON.stringify(rendered)).toBe(
      JSON.stringify(oldGoogleBody(FULL_MESSAGES, FULL_OPTIONS, 512, 0.3)),
    );
  });

  it('Ollama body matches the legacy construction (incl. format/think passthrough)', () => {
    const ollamaOptions = {
      maxTokens: 64,
      temperature: 0.1,
      format: 'json',
      think: true,
    } as ChatOptions;
    const std = toStandardRequest([{ role: 'user', content: 'hi' }], ollamaOptions, {
      wire: 'ollama',
      model: 'llama3',
      maxTokens: 64,
      temperature: 0.1,
    });
    const rendered = renderOllamaChatRequest(std, { stream: true });
    expect(JSON.stringify(rendered)).toBe(
      JSON.stringify(
        oldOllamaBody([{ role: 'user', content: 'hi' }], 'llama3', true, 64, 0.1, ollamaOptions),
      ),
    );
  });

  it('CustomProvider chat + stream bodies match the legacy construction', () => {
    const std = toStandardRequest(FULL_MESSAGES, FULL_OPTIONS, {
      wire: 'openai',
      model: 'deepseek-chat',
      maxTokens: 512,
      temperature: 0.3,
    });
    const chat = renderOpenAIChatRequest(std, { stream: false });
    const stream = renderOpenAIChatRequest(std, {
      stream: true,
      streamOptions: { include_usage: true },
    });
    expect(JSON.stringify(chat)).toBe(
      JSON.stringify(oldCustomBody(FULL_MESSAGES, FULL_OPTIONS, 'deepseek-chat', 512, 0.3, false)),
    );
    expect(JSON.stringify(stream)).toBe(
      JSON.stringify(oldCustomBody(FULL_MESSAGES, FULL_OPTIONS, 'deepseek-chat', 512, 0.3, true)),
    );
  });

  it('defineVendor chat + stream bodies match the legacy construction', () => {
    const std = toStandardRequest(FULL_MESSAGES, FULL_OPTIONS, {
      wire: 'openai',
      model: 'moonshot-v1-8k',
      maxTokens: 512,
      temperature: 0.3,
    });
    const chat = renderOpenAIChatRequest(std, { stream: false, samplingExtras: true });
    const stream = renderOpenAIChatRequest(std, { stream: true });
    expect(JSON.stringify(chat)).toBe(
      JSON.stringify(oldVendorChatBody(FULL_MESSAGES, FULL_OPTIONS, 'moonshot-v1-8k', 512, 0.3)),
    );
    const legacyStream = oldVendorChatBody(FULL_MESSAGES, FULL_OPTIONS, 'moonshot-v1-8k', 512, 0.3);
    delete legacyStream['top_p'];
    delete legacyStream['stop'];
    legacyStream['stream'] = true;
    expect(JSON.stringify(stream)).toBe(JSON.stringify(legacyStream));
  });

  it('Azure bodies match the legacy construction (model omitted, deployment in URL)', () => {
    const std = toStandardRequest(FULL_MESSAGES, FULL_OPTIONS, {
      wire: 'openai',
      model: 'gpt-4o-deploy',
      maxTokens: 512,
      temperature: 0.3,
    });
    const chat = renderOpenAIChatRequest(std, {
      stream: false,
      samplingExtras: true,
      omitModel: true,
    });
    const stream = renderOpenAIChatRequest(std, { stream: true, omitModel: true });
    expect(JSON.stringify(chat)).toBe(
      JSON.stringify(oldAzureBody(FULL_MESSAGES, FULL_OPTIONS, 512, 0.3, false)),
    );
    expect(JSON.stringify(stream)).toBe(
      JSON.stringify(oldAzureBody(FULL_MESSAGES, FULL_OPTIONS, 512, 0.3, true)),
    );
  });
});

// --- P2: end-to-end wire parity through the adapted providers ---

function jsonResponse(payload: unknown, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': contentType },
  });
}

describe('P2 providers — end-to-end request bytes parity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AnthropicProvider.chat sends the legacy-identical body', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider({ type: 'anthropic', apiKey: 'k' });
    await provider.chat(FULL_MESSAGES, FULL_OPTIONS);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect(JSON.stringify(sentBody)).toBe(
      JSON.stringify(
        oldAnthropicBody(FULL_MESSAGES, FULL_OPTIONS, FULL_OPTIONS.model!, 512, false),
      ),
    );
  });

  it('AnthropicProvider.chatStream sends the legacy-identical body', async () => {
    const sse = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const fetchMock = vi.fn(
      async () =>
        new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider({ type: 'anthropic', apiKey: 'k' });
    for await (const chunk of provider.chatStream(FULL_MESSAGES, FULL_OPTIONS)) {
      void chunk;
    }

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect(JSON.stringify(sentBody)).toBe(
      JSON.stringify(oldAnthropicBody(FULL_MESSAGES, FULL_OPTIONS, FULL_OPTIONS.model!, 512, true)),
    );
  });

  it('GoogleProvider.chat sends the legacy-identical body', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GoogleProvider({ type: 'google', apiKey: 'k' });
    await provider.chat(FULL_MESSAGES, FULL_OPTIONS);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(':generateContent?key=');
    const sentBody = JSON.parse(init.body as string);
    expect(JSON.stringify(sentBody)).toBe(
      JSON.stringify(oldGoogleBody(FULL_MESSAGES, FULL_OPTIONS, 512, 0.3)),
    );
  });

  it('OllamaProvider.chat sends the legacy-identical body', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        message: { content: 'ok' },
        model: 'llama3',
        done: true,
        eval_count: 1,
        prompt_eval_count: 1,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaProvider({ type: 'ollama', baseUrl: 'http://localhost:11434' });
    const ollamaOptions = {
      model: 'llama3',
      maxTokens: 64,
      temperature: 0.1,
      format: 'json',
      think: true,
    } as ChatOptions;
    await provider.chat([{ role: 'user', content: 'hi' }], ollamaOptions);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect(JSON.stringify(sentBody)).toBe(
      JSON.stringify(
        oldOllamaBody([{ role: 'user', content: 'hi' }], 'llama3', false, 64, 0.1, ollamaOptions),
      ),
    );
  });

  it('CustomProvider.chat sends the legacy-identical body', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        model: 'deepseek-chat',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new CustomProvider({
      type: 'deepseek',
      providerType: 'deepseek',
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      defaultModel: 'deepseek-chat',
    });
    await provider.chat(FULL_MESSAGES, FULL_OPTIONS);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect(JSON.stringify(sentBody)).toBe(
      JSON.stringify(
        oldCustomBody(FULL_MESSAGES, FULL_OPTIONS, FULL_OPTIONS.model!, 512, 0.3, false),
      ),
    );
  });

  it('KimiProvider (defineVendor) chat sends the legacy-identical body', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        model: 'moonshot-v1-8k',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new KimiProvider({ type: 'kimi', apiKey: 'k' });
    await provider.chat(FULL_MESSAGES, FULL_OPTIONS);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.moonshot.cn/v1/chat/completions');
    const sentBody = JSON.parse(init.body as string);
    expect(JSON.stringify(sentBody)).toBe(
      JSON.stringify(oldVendorChatBody(FULL_MESSAGES, FULL_OPTIONS, FULL_OPTIONS.model!, 512, 0.3)),
    );
  });

  it('AzureOpenAIProvider.chat sends the legacy-identical body', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        model: 'gpt-4o',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AzureOpenAIProvider({
      type: 'azure-openai',
      apiKey: 'k',
      baseUrl: 'https://myres.openai.azure.com',
      defaultModel: 'gpt-4o-deploy',
    });
    await provider.chat(FULL_MESSAGES, FULL_OPTIONS);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect(JSON.stringify(sentBody)).toBe(
      JSON.stringify(oldAzureBody(FULL_MESSAGES, FULL_OPTIONS, 512, 0.3, false)),
    );
  });
});
