// Dedicated Groq provider with ultra-fast inference via LPU.
// Uses OpenAI-compatible API format with Groq-specific models & optimizations.

import type { AIStreamChunk } from '@ghita/shared';
import type { ChatMessage, ChatOptions, ChatResponse, ProviderConfig } from '../types.js';
import { BaseProvider } from './base.js';
import type { ProviderCapabilities } from './types.js';
import { extractOpenAIToolCalls, OpenAIStreamToolAccumulator } from './openai-tool-calling.js';
import { renderOpenAIChatRequest } from '../standard-request.js';

const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-70b-versatile',
  'llama-3.1-8b-instant',
  'llama3-70b-8192',
  'llama3-8b-8192',
  'mixtral-8x7b-32768',
  'gemma2-9b-it',
  'gemma-7b-it',
];

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export class GroqProvider extends BaseProvider {
  readonly type = 'groq' as const;
  readonly name = 'Groq';
  readonly defaultModel = 'llama-3.1-70b-versatile';
  readonly models = GROQ_MODELS;

  constructor(config: ProviderConfig) {
    super(config);
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      embeddings: false,
      imageGeneration: false,
      speechSynthesis: false,
      speechRecognition: true,
      videoGeneration: false,
      functionCalling: true,
      visionInput: false,
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
      throw new Error(`Groq API error (${response.status}): ${error}`);
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
      provider: 'groq',
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
      throw new Error(`Groq API error (${response.status}): ${error.slice(0, 200)}`);
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
            provider: 'groq',
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
              provider: 'groq',
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
            };
            const delta = parsed.choices[0]?.delta;
            toolAccumulator.append(delta?.tool_calls);
            const content = delta?.content;
            if (content) {
              yield { content, done: false, provider: 'groq', model };
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

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  }

  private getChatUrl(): string {
    const base = (this.getBaseUrl() || GROQ_BASE_URL).replace(/\/+$/, '');
    return `${base}/chat/completions`;
  }

  private mapFinishReason(reason: string | undefined): 'stop' | 'length' | 'error' | 'aborted' {
    switch (reason) {
      case 'stop':
      case 'tool_calls':
        return 'stop';
      case 'length':
      case 'max_tokens':
        return 'length';
      case 'content_filter':
        return 'error';
      default:
        return 'stop';
    }
  }
}
