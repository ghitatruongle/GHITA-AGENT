// Composition layer: compose BaseProvider via defineVendor pattern.

import type { AIProviderType, AIStreamChunk } from '@ghita/shared';
import type { ProviderConfig, ChatMessage, ChatOptions, ChatResponse } from '../types.js';
import type { ProviderCapabilities, LLMProvider } from './types.js';
import {
  extractOpenAIToolCalls,
  OpenAIStreamToolAccumulator,
  openAIToolFields,
  toOpenAIChatMessages,
} from './openai-tool-calling.js';
import { renderOpenAIChatRequest, type StandardRequest } from '../standard-request.js';

type BaseProviderClass = abstract new (config: ProviderConfig) => LLMProvider;

export interface VendorSpec {
  type: AIProviderType;
  name: string;
  defaultModel: string;
  models: string[];
  chatUrl: string;
  embedUrl?: string;
  baseUrl?: string;
  authScheme: 'bearer' | 'x-api-key' | 'none';
  authHeader?: string;
  streaming: boolean;
  capabilities: ProviderCapabilities;
  transformRequest?: (messages: ChatMessage[], options?: ChatOptions) => unknown;
  transformResponse?: (data: unknown) => ChatResponse;
}

export function defineVendor(
  spec: VendorSpec,
  BaseProvider: BaseProviderClass,
): new (config: ProviderConfig) => LLMProvider {
  return class VendorProvider extends BaseProvider {
    readonly type = spec.type;
    readonly name = spec.name;
    readonly defaultModel = spec.defaultModel;
    readonly models = spec.models;

    constructor(config: ProviderConfig) {
      super({ ...config, type: spec.type, baseUrl: config.baseUrl ?? spec.baseUrl });
    }

    getCapabilities(): ProviderCapabilities {
      return spec.capabilities;
    }

    async isReady(): Promise<boolean> {
      if (spec.authScheme === 'none') return true;
      return (
        this as unknown as { keyManager: { hasHealthyKey: () => Promise<boolean> } }
      ).keyManager.hasHealthyKey();
    }

    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
      const apiKey = (this as unknown as { getApiKey: () => string }).getApiKey();
      const model = (this as unknown as { getModel: (o?: ChatOptions) => string }).getModel(
        options,
      );
      const body = spec.transformRequest
        ? spec.transformRequest(messages, options)
        : renderOpenAIChatRequest(
            (
              this as unknown as {
                buildStandardRequest: (
                  messages: ChatMessage[],
                  options: ChatOptions | undefined,
                  model: string,
                ) => StandardRequest;
              }
            ).buildStandardRequest(messages, options, model),
            { stream: false, samplingExtras: true },
          );
      const headers = this.buildVendorHeaders(apiKey);
      const response = await fetch(spec.chatUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options?.signal,
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
        if (apiKey)
          (
            this as unknown as { reportKeyFailure: (k: string, s: number) => void }
          ).reportKeyFailure(apiKey, statusToReport);
        throw new Error(`${spec.name} API error (${response.status}): ${error}`);
      }
      if (apiKey)
        (this as unknown as { reportKeySuccess: (k: string) => void }).reportKeySuccess(apiKey);
      const data = (await response.json()) as unknown;
      if (spec.transformResponse) return spec.transformResponse(data);
      return this.defaultTransformResponse(data, model);
    }

    async *chatStream(
      messages: ChatMessage[],
      options?: ChatOptions,
    ): AsyncGenerator<AIStreamChunk> {
      if (!spec.streaming) {
        const resp = await this.chat(messages, options);
        yield { content: resp.content, done: true, provider: spec.type, model: resp.model };
        return;
      }
      const apiKey = (this as unknown as { getApiKey: () => string }).getApiKey();
      const model = (this as unknown as { getModel: (o?: ChatOptions) => string }).getModel(
        options,
      );
      const body: Record<string, unknown> = spec.transformRequest
        ? {
            ...(spec.transformRequest(messages, options) as Record<string, unknown>),
            model,
            messages: toOpenAIChatMessages(messages),
            ...openAIToolFields(options),
            max_tokens: (
              this as unknown as { getMaxTokens: (o?: ChatOptions) => number }
            ).getMaxTokens(options),
            temperature: (
              this as unknown as { getTemperature: (o?: ChatOptions) => number }
            ).getTemperature(options),
            stream: true,
          }
        : renderOpenAIChatRequest(
            (
              this as unknown as {
                buildStandardRequest: (
                  messages: ChatMessage[],
                  options: ChatOptions | undefined,
                  model: string,
                ) => StandardRequest;
              }
            ).buildStandardRequest(messages, options, model),
            { stream: true },
          );
      const response = await fetch(spec.chatUrl, {
        method: 'POST',
        headers: this.buildVendorHeaders(apiKey),
        body: JSON.stringify(body),
        signal: options?.signal,
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
        if (apiKey)
          (
            this as unknown as { reportKeyFailure: (k: string, s: number) => void }
          ).reportKeyFailure(apiKey, statusToReport);
        throw new Error(`${spec.name} API error (${response.status}): ${error}`);
      }
      if (apiKey)
        (this as unknown as { reportKeySuccess: (k: string) => void }).reportKeySuccess(apiKey);
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
              provider: spec.type,
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
                provider: spec.type,
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
                }>;
              };
              const delta = parsed.choices[0]?.delta;
              toolAccumulator.append(delta?.tool_calls);
              const content = delta?.content;
              if (content) yield { content, done: false, provider: spec.type, model };
            } catch {
              /* skip */
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    }

    private buildVendorHeaders(apiKey: string): Record<string, string> {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (spec.authScheme === 'none' || !apiKey) return headers;
      if (spec.authScheme === 'x-api-key') {
        headers[spec.authHeader ?? 'x-api-key'] = apiKey;
      } else {
        headers[spec.authHeader ?? 'Authorization'] = `Bearer ${apiKey}`;
      }
      return headers;
    }

    private defaultTransformResponse(data: unknown, model: string): ChatResponse {
      const d = data as {
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
        model?: string;
      };
      return {
        content: d.choices[0]?.message?.content ?? '',
        model: d.model ?? model,
        provider: spec.type,
        toolCalls: extractOpenAIToolCalls(d.choices[0]?.message?.tool_calls),
        usage: {
          promptTokens: d.usage?.prompt_tokens ?? 0,
          completionTokens: d.usage?.completion_tokens ?? 0,
          totalTokens: d.usage?.total_tokens ?? 0,
        },
        finishReason: 'stop',
      };
    }
  };
}
