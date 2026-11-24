// v0.4.9 A5: Azure OpenAI Provider
//
// Azure exposes OpenAI models under deployment-scoped URLs with an `api-key`
// header (not Bearer) and a required `api-version` query parameter, so it needs
// a dedicated class rather than the generic OpenAI-compatible defineVendor path.
//
// URL:  {baseUrl}/openai/deployments/{deployment}/chat/completions?api-version=...
// Auth: header `api-key: <key>`
// The Azure "deployment" name is supplied as the model (options.model / config).

import type { AIProviderType, AIStreamChunk } from '@ghita/shared';
import type { ChatMessage, ChatOptions, ChatResponse, ProviderConfig } from '../types.js';
import { BaseProvider } from './base.js';
import type { ProviderCapabilities } from './types.js';
import { extractOpenAIToolCalls, OpenAIStreamToolAccumulator } from './openai-tool-calling.js';
import { renderOpenAIChatRequest } from '../standard-request.js';

const DEFAULT_API_VERSION = '2024-06-01';

export class AzureOpenAIProvider extends BaseProvider {
  readonly type: AIProviderType = 'azure-openai';
  readonly name = 'Azure OpenAI';
  readonly defaultModel: string;
  readonly models: string[] = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-35-turbo'];

  private readonly apiVersion: string;

  constructor(config: ProviderConfig) {
    super(config);
    this.defaultModel = config.defaultModel || 'gpt-4o';
    this.apiVersion = config.apiVersion || DEFAULT_API_VERSION;
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
    return Boolean(this.getBaseUrl()) && this.keyManager.size > 0;
  }

  /** Build the deployment-scoped chat completions URL. */
  private buildUrl(deployment: string): string {
    const base = (this.getBaseUrl() ?? '').replace(/\/+$/, '');
    if (!base) throw new Error('Azure OpenAI: baseUrl (resource endpoint) not configured');
    return `${base}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const apiKey = this.getApiKey();
    const deployment = this.getModel(options);
    const response = await fetch(this.buildUrl(deployment), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify(
        renderOpenAIChatRequest(this.buildStandardRequest(messages, options, deployment), {
          stream: false,
          samplingExtras: true,
          omitModel: true,
        }),
      ),
      signal: options?.signal,
    });

    if (!response.ok) {
      this.reportKeyFailure(apiKey, response.status);
      const error = await response.text();
      throw new Error(`Azure OpenAI API error (${response.status}): ${error}`);
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
      model?: string;
    };
    return {
      content: data.choices[0]?.message?.content ?? '',
      model: data.model ?? deployment,
      provider: 'azure-openai',
      toolCalls: extractOpenAIToolCalls(data.choices[0]?.message?.tool_calls),
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      finishReason: mapFinishReason(data.choices[0]?.finish_reason),
    };
  }

  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<AIStreamChunk> {
    const apiKey = this.getApiKey();
    const deployment = this.getModel(options);
    const response = await fetch(this.buildUrl(deployment), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify(
        renderOpenAIChatRequest(this.buildStandardRequest(messages, options, deployment), {
          stream: true,
          omitModel: true,
        }),
      ),
      signal: options?.signal,
    });

    if (!response.ok) {
      this.reportKeyFailure(apiKey, response.status);
      const error = await response.text();
      throw new Error(`Azure OpenAI API error (${response.status}): ${error}`);
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
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);
          if (payload === '[DONE]') {
            yield {
              content: '',
              done: true,
              provider: this.type,
              model: deployment,
              toolCalls: toolAccumulator.complete(),
            };
            return;
          }
          try {
            const parsed = JSON.parse(payload) as {
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
            if (content) yield { content, done: false, provider: this.type, model: deployment };
          } catch {
            // skip malformed chunk
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
      model: deployment,
      toolCalls: toolAccumulator.complete(),
    };
  }
}

function mapFinishReason(reason?: string): ChatResponse['finishReason'] {
  switch (reason) {
    case 'stop':
    case 'tool_calls':
    case 'function_call':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'error';
    default:
      return 'stop';
  }
}
