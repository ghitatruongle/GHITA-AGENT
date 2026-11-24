import { AI_PROVIDERS, type AIProviderType, type AIStreamChunk } from '@ghita/shared';
import type { ChatMessage, ChatOptions, ChatResponse, ProviderConfig } from '../types.js';
import { BaseProvider } from './base.js';
import { extractOpenAIToolCalls, OpenAIStreamToolAccumulator } from './openai-tool-calling.js';
import { renderOpenAIChatRequest } from '../standard-request.js';

export class CustomProvider extends BaseProvider {
  readonly type: AIProviderType;
  readonly name: string;
  readonly defaultModel: string;
  readonly models: string[] = [];

  constructor(config: ProviderConfig) {
    super(config);
    this.type = config.providerType ?? 'custom';
    this.name = config.providerName ?? 'Custom';
    this.defaultModel = config.defaultModel || AI_PROVIDERS[this.type]?.defaultModel || '';
  }

  async isReady(): Promise<boolean> {
    const needsNoKey = this.type === 'opencode-zen';
    return Boolean(this.config.baseUrl) && (needsNoKey || this.keyManager.size > 0);
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const baseUrl = this.getNormalizedBaseUrl();
    if (!baseUrl) throw new Error('Custom provider: baseUrl not configured');

    const model = this.getModel(options);
    const apiKey = this.getApiKey();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    let signal = options?.signal;
    if (
      !signal &&
      typeof AbortSignal !== 'undefined' &&
      typeof AbortSignal.timeout === 'function'
    ) {
      signal = AbortSignal.timeout(60000);
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(
        renderOpenAIChatRequest(this.buildStandardRequest(messages, options, model), {
          stream: false,
        }),
      ),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      let statusToReport = response.status;
      if (statusToReport === 401 || statusToReport === 403) {
        const lower = error.toLowerCase();
        if (
          lower.includes('modelerror') ||
          lower.includes('model error') ||
          lower.includes('not supported') ||
          lower.includes('unsupported') ||
          lower.includes('not found') ||
          lower.includes('invalid_model')
        ) {
          statusToReport = 500;
        }
      }
      this.reportKeyFailure(apiKey, statusToReport);
      throw new Error(`Custom API error (${response.status}): ${error}`);
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
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      model: string;
    };

    return {
      content: data.choices[0]?.message?.content ?? '',
      model: data.model || model,
      provider: this.type,
      toolCalls: extractOpenAIToolCalls(data.choices[0]?.message?.tool_calls),
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      finishReason: 'stop',
    };
  }

  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<AIStreamChunk> {
    const baseUrl = this.getNormalizedBaseUrl();
    if (!baseUrl) throw new Error('Custom provider: baseUrl not configured');

    const model = this.getModel(options);
    const apiKey = this.getApiKey();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    let signal = options?.signal;
    if (
      !signal &&
      typeof AbortSignal !== 'undefined' &&
      typeof AbortSignal.timeout === 'function'
    ) {
      signal = AbortSignal.timeout(60000);
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(
        renderOpenAIChatRequest(this.buildStandardRequest(messages, options, model), {
          stream: true,
          streamOptions: { include_usage: true },
        }),
      ),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      let statusToReport = response.status;
      if (statusToReport === 401 || statusToReport === 403) {
        const lower = error.toLowerCase();
        if (
          lower.includes('modelerror') ||
          lower.includes('model error') ||
          lower.includes('not supported') ||
          lower.includes('unsupported') ||
          lower.includes('not found') ||
          lower.includes('invalid_model')
        ) {
          statusToReport = 500;
        }
      }
      this.reportKeyFailure(apiKey, statusToReport);
      throw new Error(`Custom API error (${response.status}): ${error}`);
    }

    this.reportKeySuccess(apiKey);

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
    const toolAccumulator = new OpenAIStreamToolAccumulator();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

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
              provider: this.type,
              model,
              usage,
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
              }>;
              usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
            };

            if (parsed.usage) {
              usage = {
                promptTokens: parsed.usage.prompt_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
                totalTokens: parsed.usage.total_tokens ?? 0,
              };
            }

            const delta = parsed.choices[0]?.delta;
            toolAccumulator.append(delta?.tool_calls);
            const content = delta?.content;
            if (content) {
              yield { content, done: false, provider: this.type, model };
            }
          } catch {
            // skip malformed JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield {
      content: '',
      done: true,
      provider: this.type,
      model,
      usage,
      toolCalls: toolAccumulator.complete(),
    };
  }

  private getNormalizedBaseUrl(): string | undefined {
    return this.getBaseUrl()?.replace(/\/+$/, '');
  }
}
