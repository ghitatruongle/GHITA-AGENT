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
import { extractGoogleToolCalls } from './google-tool-calling.js';
import { renderGoogleGenerateContentRequest } from '../standard-request.js';

const GOOGLE_MODELS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',
];

export class GoogleProvider extends BaseProvider {
  readonly type = 'google' as const;
  readonly name = 'Google';
  readonly defaultModel = 'gemini-3.5-flash';
  readonly models = GOOGLE_MODELS;

  constructor(config: ProviderConfig) {
    super(config);
  }

  protected override wireFormat() {
    return 'google' as const;
  }

  async isReady(): Promise<boolean> {
    return this.keyManager.hasHealthyKey();
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const apiKey = this.getApiKey();
    const model = this.getModel(options);
    const body = renderGoogleGenerateContentRequest(
      this.buildStandardRequest(messages, options, model),
    );

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: options?.signal,
      },
    );

    if (!response.ok) {
      this.reportKeyFailure(apiKey, response.status);
      const error = await response.text();
      throw new Error(`Google API error (${response.status}): ${error}`);
    }

    this.reportKeySuccess(apiKey);

    const data = (await response.json()) as {
      candidates: Array<{
        content: {
          parts: Array<{
            text?: string;
            functionCall?: {
              id?: string;
              name: string;
              args: Record<string, unknown>;
            };
          }>;
        };
        finishReason: string;
      }>;
      usageMetadata: {
        promptTokenCount: number;
        candidatesTokenCount: number;
        totalTokenCount: number;
      };
    };

    const parts = data.candidates[0]?.content?.parts ?? [];
    const content = parts.map((part) => part.text ?? '').join('');
    const toolCalls = extractGoogleToolCalls(parts);

    return {
      content,
      model,
      provider: 'google',
      usage: {
        promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
        completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        totalTokens: data.usageMetadata?.totalTokenCount ?? 0,
      },
      finishReason: this.mapFinishReason(data.candidates[0]?.finishReason),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }

  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<AIStreamChunk> {
    const apiKey = this.getApiKey();
    const model = this.getModel(options);
    const body = renderGoogleGenerateContentRequest(
      this.buildStandardRequest(messages, options, model),
    );

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: options?.signal,
      },
    );

    if (!response.ok) {
      this.reportKeyFailure(apiKey, response.status);
      const error = await response.text();
      throw new Error(`Google API error (${response.status}): ${error.slice(0, 200)}`);
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
    const streamedCalls = new Map<
      string,
      { id?: string; name: string; arguments: Record<string, unknown> }
    >();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice('data:'.length).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload) as {
              candidates?: Array<{
                content?: {
                  parts?: Array<{
                    text?: string;
                    /** Gemini marks thinking-summary parts with thought: true. */
                    thought?: boolean;
                    functionCall?: {
                      id?: string;
                      name: string;
                      args: Record<string, unknown>;
                    };
                  }>;
                };
              }>;
            };
            const parts = parsed.candidates?.[0]?.content?.parts ?? [];
            // Track S3 P2: thought parts stream as `reasoning` StreamObjects
            // instead of being flattened into the visible answer.
            const reasoningText = parts
              .filter((part) => part.thought === true)
              .map((part) => part.text ?? '')
              .join('');
            const text = parts
              .filter((part) => part.thought !== true)
              .map((part) => part.text ?? '')
              .join('');
            if (reasoningText) {
              yield {
                content: reasoningText,
                done: false,
                provider: 'google',
                model,
                type: 'reasoning',
              };
            }
            if (text) {
              yield { content: text, done: false, provider: 'google', model, type: 'text-delta' };
            }
            for (const call of extractGoogleToolCalls(parts)) {
              streamedCalls.set(call.id ?? `${call.name}:${streamedCalls.size}`, call);
            }
          } catch {
            // Ignore a malformed event without discarding subsequent SSE frames.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const terminalCalls = [...streamedCalls.values()];
    yield {
      content: '',
      done: true,
      provider: 'google',
      model,
      type: terminalCalls.length ? 'tool-call' : 'text-delta',
      toolCalls: terminalCalls,
    };
  }

  private mapFinishReason(reason: string | undefined): 'stop' | 'length' | 'error' | 'aborted' {
    switch (reason) {
      case 'STOP':
        return 'stop';
      case 'MAX_TOKENS':
        return 'length';
      // Deterministic safety/copyright blocks (Track S2 ladder rule 3):
      // retrying or nudging cannot help — surface as a blocked generation,
      // same as OpenAI's content_filter and Anthropic's refusal.
      case 'SAFETY':
      case 'RECITATION':
      case 'BLOCKLIST':
      case 'PROHIBITED_CONTENT':
      case 'SPII':
        return 'error';
      default:
        return 'stop';
    }
  }

  async embed(text: string, options?: { model?: string }): Promise<EmbeddingResponse> {
    const apiKey = this.getApiKey();
    const model = options?.model ?? 'gemini-embedding-2';

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: {
            parts: [{ text }],
          },
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as {
      embedding: { values: number[] };
    };

    return {
      embedding: data.embedding?.values ?? [],
      model,
      provider: 'google',
    };
  }

  async embedMany(texts: string[], options?: { model?: string }): Promise<EmbeddingManyResponse> {
    const apiKey = this.getApiKey();
    const model = options?.model ?? 'text-embedding-004';

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${model}`,
            content: {
              parts: [{ text }],
            },
          })),
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as {
      embeddings: Array<{ values: number[] }>;
    };

    const embeddings = data.embeddings?.map((e) => e.values) ?? [];

    return {
      embeddings,
      model,
      provider: 'google',
    };
  }
}
