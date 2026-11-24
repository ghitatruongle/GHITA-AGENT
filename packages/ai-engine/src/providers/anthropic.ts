import type { AIStreamChunk } from '@ghita/shared';
import type { ChatMessage, ChatOptions, ChatResponse, ProviderConfig } from '../types.js';
import { BaseProvider } from './base.js';
import { extractAnthropicToolCalls } from './anthropic-tool-calling.js';
import { renderAnthropicMessagesRequest } from '../standard-request.js';

const ANTHROPIC_MODELS = [
  'claude-sonnet-4-20250514',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
];

export class AnthropicProvider extends BaseProvider {
  readonly type = 'anthropic' as const;
  readonly name = 'Anthropic';
  readonly defaultModel = 'claude-sonnet-4-20250514';
  readonly models = ANTHROPIC_MODELS;

  constructor(config: ProviderConfig) {
    super(config);
  }

  protected override wireFormat() {
    return 'anthropic' as const;
  }

  async isReady(): Promise<boolean> {
    return this.keyManager.hasHealthyKey();
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const apiKey = this.getApiKey();
    const model = this.getModel(options);
    const body = renderAnthropicMessagesRequest(
      this.buildStandardRequest(messages, options, model),
    );

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      this.reportKeyFailure(apiKey, response.status);
      const error = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${error}`);
    }

    this.reportKeySuccess(apiKey);

    const data = (await response.json()) as {
      content: Array<Record<string, unknown>>;
      model: string;
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: string;
    };

    const textContent = data.content
      .filter((c) => c.type === 'text')
      .map((c) => (typeof c['text'] === 'string' ? c['text'] : ''))
      .join('');
    const toolCalls = extractAnthropicToolCalls(data.content);

    return {
      content: textContent,
      model: data.model,
      provider: 'anthropic',
      usage: {
        promptTokens: data.usage?.input_tokens ?? 0,
        completionTokens: data.usage?.output_tokens ?? 0,
        totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      },
      finishReason: this.mapFinishReason(data.stop_reason),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }

  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<AIStreamChunk> {
    const apiKey = this.getApiKey();
    const model = this.getModel(options);
    const body = renderAnthropicMessagesRequest(
      this.buildStandardRequest(messages, options, model),
      {
        stream: true,
      },
    );

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      this.reportKeyFailure(apiKey, response.status);
      const error = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${error.slice(0, 200)}`);
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
              `[anthropic] Dropping malformed tool-call arguments for "${call.name}":`,
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
            provider: 'anthropic',
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

          try {
            const parsed = JSON.parse(data) as {
              type: string;
              index?: number;
              content_block?: {
                type?: string;
                id?: string;
                name?: string;
              };
              delta?: {
                type: string;
                text?: string;
                partial_json?: string;
                /** Extended-thinking models stream reasoning via thinking_delta. */
                thinking?: string;
              };
            };

            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              yield {
                content: parsed.delta.text,
                done: false,
                provider: 'anthropic',
                model,
                type: 'text-delta',
              };
            }

            // Track S3 P2: thinking blocks were silently dropped before —
            // emit them as `reasoning` StreamObjects.
            if (
              parsed.type === 'content_block_delta' &&
              parsed.delta?.type === 'thinking_delta' &&
              parsed.delta.thinking
            ) {
              yield {
                content: parsed.delta.thinking,
                done: false,
                provider: 'anthropic',
                model,
                type: 'reasoning',
              };
            }

            if (
              parsed.type === 'content_block_start' &&
              parsed.content_block?.type === 'tool_use'
            ) {
              streamedCalls.set(parsed.index ?? 0, {
                id: parsed.content_block.id,
                name: parsed.content_block.name ?? '',
                argumentsText: '',
              });
            }
            if (
              parsed.type === 'content_block_delta' &&
              parsed.delta?.type === 'input_json_delta'
            ) {
              const index = parsed.index ?? 0;
              const current = streamedCalls.get(index) ?? { name: '', argumentsText: '' };
              current.argumentsText += parsed.delta.partial_json ?? '';
              streamedCalls.set(index, current);
            }

            if (parsed.type === 'message_stop') {
              const terminalCalls = completedToolCalls();
              yield {
                content: '',
                done: true,
                provider: 'anthropic',
                model,
                type: terminalCalls.length ? 'tool-call' : 'text-delta',
                toolCalls: terminalCalls,
              };
              return;
            }
          } catch {
            // skip malformed JSON
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
      case 'end_turn':
      case 'stop_sequence':
      case 'tool_use':
      case 'pause_turn':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'refusal':
        return 'error';
      default:
        return 'stop';
    }
  }
}
