import type { AIStreamChunk } from '@ghita/shared';
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ProviderConfig,
  EmbeddingResponse,
  EmbeddingManyResponse,
} from '../types.js';
import { BaseProvider } from './base.js';
import { extractOpenAIToolCalls } from './openai-tool-calling.js';
import { renderOpenAIChatRequest } from '../standard-request.js';

const OPENAI_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-3.5-turbo',
  'o1-preview',
  'o1-mini',
];

export class OpenAIProvider extends BaseProvider {
  readonly type = 'openai' as const;
  readonly name = 'OpenAI';
  readonly defaultModel = 'gpt-4o';
  readonly models = OPENAI_MODELS;

  constructor(config: ProviderConfig) {
    super(config);
  }

  async isReady(): Promise<boolean> {
    return this.keyManager.hasHealthyKey();
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const apiKey = this.getApiKey();
    const model = this.getModel(options);
    const body = renderOpenAIChatRequest(this.buildStandardRequest(messages, options, model), {
      samplingExtras: true,
    });

    const response = await fetch(this.getChatCompletionsUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      this.reportKeyFailure(apiKey, response.status);
      const error = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${error}`);
    }

    this.reportKeySuccess(apiKey);

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason: string;
      }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      model: string;
    };

    return {
      content: data.choices[0]?.message?.content ?? '',
      model: data.model,
      provider: 'openai',
      toolCalls: extractOpenAIToolCalls(data.choices[0]?.message?.tool_calls),
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      finishReason: this.mapFinishReason(data.choices[0]?.finish_reason),
    };
  }

  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<AIStreamChunk> {
    const apiKey = this.getApiKey();
    const model = this.getModel(options);
    const body = renderOpenAIChatRequest(this.buildStandardRequest(messages, options, model), {
      stream: true,
    });

    const response = await fetch(this.getChatCompletionsUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      this.reportKeyFailure(apiKey, response.status);
      const error = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${error.slice(0, 200)}`);
    }

    this.reportKeySuccess(apiKey);

    const contentType = response.headers.get('content-type');
    if (!contentType?.includes('text/event-stream') && !contentType?.includes('application/json')) {
      throw new Error(`Unexpected response type: ${contentType}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    const streamedCalls = new Map<number, { id?: string; name: string; argumentsText: string }>();
    const completedToolCalls = () =>
      [...streamedCalls.entries()]
        .sort(([left], [right]) => left - right)
        .flatMap(([, call]) => {
          try {
            const args = JSON.parse(call.argumentsText || '{}') as unknown;
            if (!args || typeof args !== 'object' || Array.isArray(args) || !call.name) return [];
            return [{ id: call.id, name: call.name, arguments: args as Record<string, unknown> }];
          } catch (err) {
            // Malformed tool-call JSON must be surfaced — silently dropping it
            // makes the agent loop proceed as if no tool had been called.
            console.warn(
              `[openai] Dropping malformed tool-call arguments for "${call.name}":`,
              err instanceof Error ? err.message : err,
              call.argumentsText.slice(0, 200),
            );
            return [];
          }
        });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          const terminalCalls = completedToolCalls();
          yield {
            content: '',
            done: true,
            provider: 'openai',
            model,
            type: terminalCalls.length ? 'tool-call' : 'text-delta',
            toolCalls: terminalCalls,
          };
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            const terminalCalls = completedToolCalls();
            yield {
              content: '',
              done: true,
              provider: 'openai',
              model,
              type: terminalCalls.length ? 'tool-call' : 'text-delta',
              toolCalls: terminalCalls,
            };
            return;
          }

          try {
            const parsed = JSON.parse(data) as {
              choices: Array<{
                delta: {
                  content?: string;
                  /** Reasoning models (o-series, DeepSeek-style compat). */
                  reasoning_content?: string;
                  /** OpenRouter-style reasoning delta. */
                  reasoning?: string;
                  tool_calls?: Array<{
                    index?: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
              }>;
            };
            const delta = parsed.choices[0]?.delta;
            const content = delta?.content;
            if (content) {
              yield { content, done: false, provider: 'openai', model, type: 'text-delta' };
            }
            // Track S3 P2: reasoning deltas become first-class StreamObjects.
            const reasoningText = delta?.reasoning_content ?? delta?.reasoning;
            if (reasoningText) {
              yield {
                content: reasoningText,
                done: false,
                provider: 'openai',
                model,
                type: 'reasoning',
              };
            }
            for (const toolDelta of delta?.tool_calls ?? []) {
              const index = toolDelta.index ?? 0;
              const current = streamedCalls.get(index) ?? { name: '', argumentsText: '' };
              if (toolDelta.id) current.id = toolDelta.id;
              if (toolDelta.function?.name) current.name += toolDelta.function.name;
              if (toolDelta.function?.arguments) {
                current.argumentsText += toolDelta.function.arguments;
              }
              streamedCalls.set(index, current);
            }
          } catch {
            // Expected: skip malformed JSON chunks in SSE stream
          }
        }
      }
    } finally {
      // Cancel the HTTP body when the consumer breaks early — releaseLock()
      // alone leaves the upstream connection and stream open.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  private mapFinishReason(reason: string | undefined): 'stop' | 'length' | 'error' | 'aborted' {
    switch (reason) {
      case 'stop':
      case 'tool_calls':
      case 'function_call':
        return 'stop';
      case 'length':
      case 'max_tokens':
        return 'length';
      case 'content_filter':
      case 'safety':
        return 'error';
      default:
        return 'stop';
    }
  }

  private getChatCompletionsUrl(): string {
    const baseUrl = (this.getBaseUrl() || 'https://api.openai.com/v1').replace(/\/+$/, '');
    return `${baseUrl}/chat/completions`;
  }

  async embed(
    text: string,
    options?: { model?: string; signal?: AbortSignal },
  ): Promise<EmbeddingResponse> {
    const apiKey = this.getApiKey();
    const model = options?.model ?? 'text-embedding-3-small';
    const baseUrl = this.getBaseUrl() || 'https://api.openai.com/v1';

    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text,
      }),
      signal: options?.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as {
      model: string;
      data: Array<{ embedding: number[]; index: number }>;
      usage?: { prompt_tokens: number; total_tokens: number };
    };

    return {
      embedding: data.data[0]?.embedding ?? [],
      model: data.model,
      provider: 'openai',
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }

  async embedMany(
    texts: string[],
    options?: { model?: string; signal?: AbortSignal },
  ): Promise<EmbeddingManyResponse> {
    const apiKey = this.getApiKey();
    const model = options?.model ?? 'text-embedding-3-small';
    const baseUrl = this.getBaseUrl() || 'https://api.openai.com/v1';

    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: texts,
      }),
      signal: options?.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as {
      model: string;
      data: Array<{ embedding: number[]; index: number }>;
      usage?: { prompt_tokens: number; total_tokens: number };
    };

    const sorted = [...data.data].sort((a, b) => a.index - b.index);
    const embeddings = sorted.map((item) => item.embedding);

    return {
      embeddings,
      model: data.model,
      provider: 'openai',
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }

  async generateImage(
    prompt: string,
    options?: Record<string, unknown>,
  ): Promise<{ url: string; b64?: string }> {
    const apiKey = this.getApiKey();
    const model = options?.model ?? 'dall-e-3';
    const baseUrl = this.getBaseUrl() || 'https://api.openai.com/v1';

    const response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        prompt,
        n: options?.n ?? 1,
        size: options?.size ?? '1024x1024',
        response_format: options?.responseFormat ?? 'url',
      }),
      signal: options?.signal as AbortSignal | undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as {
      data: Array<{ url?: string; b64_json?: string }>;
    };

    const first = data.data[0];
    if (!first) throw new Error('No image returned from OpenAI');

    return {
      url: first.url ?? '',
      b64: first.b64_json,
    };
  }

  async generateSpeech(
    text: string,
    options?: Record<string, unknown>,
  ): Promise<{ audio: Buffer; contentType: string }> {
    const apiKey = this.getApiKey();
    const model = options?.model ?? 'tts-1';
    const baseUrl = this.getBaseUrl() || 'https://api.openai.com/v1';

    const response = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text,
        voice: options?.voice ?? 'alloy',
        response_format: options?.responseFormat ?? 'mp3',
        speed: options?.speed,
      }),
      signal: options?.signal as AbortSignal | undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const audio = Buffer.from(arrayBuffer);
    const contentType = response.headers.get('content-type') || 'audio/mpeg';

    return { audio, contentType };
  }

  async transcribe(audio: Buffer, options?: Record<string, unknown>): Promise<{ text: string }> {
    const apiKey = this.getApiKey();
    const model = options?.model ?? 'whisper-1';
    const baseUrl = this.getBaseUrl() || 'https://api.openai.com/v1';

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(audio)], {
      type: String(options?.contentType || 'audio/mpeg'),
    });
    formData.append('file', blob, String(options?.filename || 'audio.mp3'));
    formData.append('model', String(model));

    if (options?.language) formData.append('language', String(options.language));
    if (options?.prompt) formData.append('prompt', String(options.prompt));
    if (options?.responseFormat) formData.append('response_format', String(options.responseFormat));
    if (options?.temperature !== undefined)
      formData.append('temperature', String(options.temperature));

    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
      signal: options?.signal as AbortSignal | undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as { text: string };
    return { text: data.text };
  }
}
