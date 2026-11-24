// Dedicated Mistral AI provider with native API support.
// Mistral uses a La Plateforme API compatible with OpenAI format.

import type { AIStreamChunk } from '@ghita/shared';
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  EmbeddingResponse,
  EmbeddingManyResponse,
  ProviderConfig,
} from '../types.js';
import { BaseProvider } from './base.js';
import type { ProviderCapabilities } from './types.js';
import { extractOpenAIToolCalls, OpenAIStreamToolAccumulator } from './openai-tool-calling.js';
import { renderOpenAIChatRequest } from '../standard-request.js';

const MISTRAL_MODELS = [
  'mistral-large-latest',
  'mistral-medium-latest',
  'mistral-small-latest',
  'open-mistral-nemo',
  'open-mixtral-8x22b',
  'open-mixtral-8x7b',
  'open-mistral-7b',
  'codestral-latest',
  'pixtral-large-latest',
];

const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';

export class MistralProvider extends BaseProvider {
  readonly type = 'mistral' as const;
  readonly name = 'Mistral';
  readonly defaultModel = 'mistral-large-latest';
  readonly models = MISTRAL_MODELS;

  constructor(config: ProviderConfig) {
    super(config);
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      embeddings: true,
      imageGeneration: false,
      speechSynthesis: false,
      speechRecognition: false,
      videoGeneration: false,
      functionCalling: true,
      visionInput: true,
      reasoningTokens: false,
    };
  }

  async isReady(): Promise<boolean> {
    return this.keyManager.hasHealthyKey();
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const apiKey = this.getApiKey();
    const model = this.getModel(options);

    const response = await fetch(this.getChatUrl(), {
      method: 'POST',
      headers: this.buildHeaders(apiKey),
      body: JSON.stringify(
        renderOpenAIChatRequest(this.buildStandardRequest(messages, options, model), {
          samplingExtras: true,
        }),
      ),
      signal: options?.signal,
    });

    if (!response.ok) {
      this.reportKeyFailure(apiKey, response.status);
      const error = await response.text();
      throw new Error(`Mistral API error (${response.status}): ${error}`);
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
      provider: 'mistral',
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

    const response = await fetch(this.getChatUrl(), {
      method: 'POST',
      headers: this.buildHeaders(apiKey),
      body: JSON.stringify(
        renderOpenAIChatRequest(this.buildStandardRequest(messages, options, model), {
          stream: true,
        }),
      ),
      signal: options?.signal,
    });

    if (!response.ok) {
      this.reportKeyFailure(apiKey, response.status);
      const error = await response.text();
      throw new Error(`Mistral API error (${response.status}): ${error.slice(0, 200)}`);
    }

    this.reportKeySuccess(apiKey);

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    const toolAccumulator = new OpenAIStreamToolAccumulator();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          yield {
            content: '',
            done: true,
            provider: 'mistral',
            model,
            toolCalls: toolAccumulator.complete(),
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
            yield {
              content: '',
              done: true,
              provider: 'mistral',
              model,
              toolCalls: toolAccumulator.complete(),
            };
            return;
          }

          try {
            const parsed = JSON.parse(data) as {
              choices: Array<{
                delta: {
                  content?: string;
                  tool_calls?: Parameters<OpenAIStreamToolAccumulator['append']>[0];
                };
                finish_reason?: string;
              }>;
              usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
            };
            const delta = parsed.choices[0]?.delta;
            toolAccumulator.append(delta?.tool_calls);
            const content = delta?.content;
            if (content) {
              yield { content, done: false, provider: 'mistral', model };
            }
          } catch {
            // skip malformed JSON in SSE stream
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async embed(text: string, options?: { model?: string }): Promise<EmbeddingResponse> {
    const apiKey = this.getApiKey();
    const model = options?.model ?? 'mistral-embed';

    const response = await fetch(this.getEmbedUrl(), {
      method: 'POST',
      headers: this.buildHeaders(apiKey),
      body: JSON.stringify({
        model,
        input: [text],
        encoding_format: 'float',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Mistral API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
      model: string;
      usage?: { prompt_tokens: number; total_tokens: number };
    };

    return {
      embedding: data.data[0]?.embedding ?? [],
      model: data.model,
      provider: 'mistral',
      usage: data.usage
        ? { promptTokens: data.usage.prompt_tokens, totalTokens: data.usage.total_tokens }
        : undefined,
    };
  }

  async embedMany(texts: string[], options?: { model?: string }): Promise<EmbeddingManyResponse> {
    const apiKey = this.getApiKey();
    const model = options?.model ?? 'mistral-embed';

    const response = await fetch(this.getEmbedUrl(), {
      method: 'POST',
      headers: this.buildHeaders(apiKey),
      body: JSON.stringify({
        model,
        input: texts,
        encoding_format: 'float',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Mistral API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
      model: string;
      usage?: { prompt_tokens: number; total_tokens: number };
    };

    const sorted = [...data.data].sort((a, b) => a.index - b.index);
    const embeddings = sorted.map((item) => item.embedding);

    return {
      embeddings,
      model: data.model,
      provider: 'mistral',
      usage: data.usage
        ? { promptTokens: data.usage.prompt_tokens, totalTokens: data.usage.total_tokens }
        : undefined,
    };
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  }

  private getChatUrl(): string {
    const base = (this.getBaseUrl() || MISTRAL_BASE_URL).replace(/\/+$/, '');
    return `${base}/chat/completions`;
  }

  private getEmbedUrl(): string {
    const base = (this.getBaseUrl() || MISTRAL_BASE_URL).replace(/\/+$/, '');
    return `${base}/embeddings`;
  }

  private mapFinishReason(reason: string | undefined): 'stop' | 'length' | 'error' | 'aborted' {
    switch (reason) {
      case 'stop':
      case 'tool_calls':
        return 'stop';
      case 'length':
        return 'length';
      case 'model_length':
        return 'length';
      case 'error':
        return 'error';
      default:
        return 'stop';
    }
  }
}
