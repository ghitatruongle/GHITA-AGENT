// Chat completion and streaming with semantic cache, fallback, and retry logic.

import { sleep } from '@ghita/shared';
import type { AIStreamChunk } from '@ghita/shared';
import type {
  OrchestratorContext,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  AIProviderType,
} from './types.js';
import { stableMessageKey } from './helpers.js';
import {
  runChatRetryLadder,
  createRetryLadderState,
  SYNTHETIC_FOLLOW_UP_PROMPT,
  type KeySwitcher,
} from './retry-ladder.js';
import { AgentError } from '../errors/index.js';

/** Auth/validation/content-filter failures must never be retried — retrying
 * cannot fix them and only burns budget. Network/5xx/429-style failures are
 * retryable. (Track S2 ladder: content_filter joined the never-retry set.) */
function isRetryableStreamError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  if (/content[ _-]?filter|refusal|safety/.test(msg)) return false;
  return (
    !/\b(400|401|403|404|422)\b/.test(msg) &&
    !/unauthorized|forbidden|invalid[ _-]?api[ _-]?key|authentication|permission/i.test(msg)
  );
}

/** The orchestrator hands out cost-middleware-wrapped proxies that only
 * forward chat/chatStream — resolve the registry instance for key ops. */
function resolveKeySwitcher(
  ctx: OrchestratorContext,
  provider: { type: AIProviderType },
): KeySwitcher | null {
  const raw = ctx.registry.get(provider.type) ?? (provider as unknown as Partial<KeySwitcher>);
  if (raw && typeof (raw as Partial<KeySwitcher>).switchKey === 'function') {
    return raw as KeySwitcher;
  }
  return null;
}

/** Chat with provider priority, fallback on error */
export async function orchestratorChat(
  ctx: OrchestratorContext,
  messages: ChatMessage[],
  options?: ChatOptions & { provider?: AIProviderType },
): Promise<ChatResponse> {
  const cacheKey = await stableMessageKey(messages);

  try {
    const cached = await ctx.semanticCache.get(cacheKey);
    if (cached) {
      return cached as ChatResponse;
    }
  } catch (err) {
    console.warn('[SemanticCache] get error:', err);
  }

  const provider = ctx.resolveProvider(options?.provider, options?.agentRole);
  ctx.budgetManager.checkBudget(0);

  const maxAttempts = ctx.config.retryAttempts ?? 2;

  // Track S2 retry ladder (runs INSIDE the legacy retry wrapper so generic
  // errors keep their exact legacy call counts): empty → synthetic follow-up
  // (max 1), 429 → switch-key once, content_filter → never retried.
  // ladderState is shared across re-invocations (once-per-request caps), but
  // the key switcher resolves per invocation so a post-failover 429 switches
  // the CURRENT provider's keys, not the primary's.
  const ladderState = createRetryLadderState();
  const response = await ctx.executeWithFallback(
    (p) => {
      const currentSwitcher = resolveKeySwitcher(ctx, p);
      return runChatRetryLadder(
        {
          call: (msgs) => p.chat(msgs, options),
          switchKey: currentSwitcher ? (exclude) => currentSwitcher.switchKey(exclude) : null,
        },
        messages,
        ladderState,
      );
    },
    provider,
    maxAttempts,
  );

  try {
    await ctx.semanticCache.set(cacheKey, response);
  } catch (err) {
    console.warn('[SemanticCache] set error:', err);
  }

  return response;
}

/** Streaming chat with provider priority, fallback on error */
export async function* orchestratorChatStream(
  ctx: OrchestratorContext,
  messages: ChatMessage[],
  options?: ChatOptions & { provider?: AIProviderType },
): AsyncGenerator<AIStreamChunk> {
  const cacheKey = await stableMessageKey(messages);

  try {
    const cached = (await ctx.semanticCache.get(cacheKey)) as ChatResponse | null;
    if (cached) {
      yield {
        content: cached.content,
        done: true,
        provider: cached.provider,
        model: cached.model,
        usage: cached.usage,
      };
      return;
    }
  } catch (err) {
    console.warn('[SemanticCache] get stream error:', err);
  }

  const provider = ctx.resolveProvider(options?.provider, options?.agentRole);
  ctx.budgetManager.checkBudget(0);

  const maxAttempts = ctx.config.retryAttempts ?? 2;
  let accumulatedContent = '';
  let resolvedProvider = provider.type;
  let resolvedModel = options?.model || provider.defaultModel || 'default';
  let finalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let finalFinishReason: 'stop' | 'length' | 'error' | 'aborted' | undefined;
  let success = false;
  let lastError: Error | undefined;
  // Once any chunk of the current response reached the consumer, restarting
  // the stream (retry or fallback) would REPLAY that prefix — so we surface a
  // partial + error instead of duplicating output.
  let everEmitted = false;
  // Track S2 ladder: terminal chunk of an empty stream, held back so the
  // synthetic follow-up (rule 1) can replace it without a double `done`.
  let heldEmptyDone: AIStreamChunk | null = null;
  // Track S2 ladder: 429 → switch key at most once per stream request.
  let keySwitched = false;

  for (let attempt = 1; attempt <= maxAttempts && !success; attempt++) {
    let emittedThisAttempt = false;
    heldEmptyDone = null;
    try {
      accumulatedContent = '';
      const stream = provider.chatStream(messages, options);
      for await (const chunk of stream) {
        if (chunk.done && accumulatedContent === '' && !chunk.toolCalls?.length) {
          // Empty terminal chunk — hold it; the ladder may replace it with a
          // synthetic follow-up turn instead of surfacing an empty answer.
          // Metadata is still captured so an empty cached response keeps the
          // real provider/model/usage of the call that produced it.
          heldEmptyDone = chunk;
          if (chunk.provider) resolvedProvider = chunk.provider;
          if (chunk.model) resolvedModel = chunk.model;
          if (chunk.usage) {
            finalUsage = {
              promptTokens: chunk.usage.promptTokens,
              completionTokens: chunk.usage.completionTokens,
              totalTokens: chunk.usage.totalTokens,
            };
          }
          const heldFr = (chunk as { finishReason?: typeof finalFinishReason }).finishReason;
          if (heldFr) finalFinishReason = heldFr;
          continue;
        }
        emittedThisAttempt = true;
        everEmitted = true;
        accumulatedContent += chunk.content;
        if (chunk.provider) resolvedProvider = chunk.provider;
        if (chunk.model) resolvedModel = chunk.model;
        if (chunk.usage) {
          finalUsage = {
            promptTokens: chunk.usage.promptTokens,
            completionTokens: chunk.usage.completionTokens,
            totalTokens: chunk.usage.totalTokens,
          };
        }
        const fr = (chunk as { finishReason?: typeof finalFinishReason }).finishReason;
        if (fr) finalFinishReason = fr;
        yield chunk;
      }
      success = true;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (options?.signal?.aborted) {
        if (emittedThisAttempt) {
          yield {
            content: '',
            role: 'assistant' as const,
            provider: resolvedProvider,
            model: resolvedModel,
            finishReason: 'error',
            partialContent: accumulatedContent,
          } as unknown as AIStreamChunk;
        }
        throw lastError;
      }
      if (emittedThisAttempt) {
        yield {
          content: '',
          role: 'assistant' as const,
          provider: resolvedProvider,
          model: resolvedModel,
          finishReason: 'error',
          partialContent: accumulatedContent,
        } as unknown as AIStreamChunk;
        throw lastError;
      }
      // Track S2 ladder: rate-limited → explicitly switch key once so the
      // retry uses a different credential even when the provider errored
      // before reporting the failed key.
      const agentError = AgentError.from(lastError);
      if (agentError.code === 'rate_limited' && !keySwitched) {
        keySwitched = true;
        const raw = ctx.registry.get(provider.type);
        const switcher = raw as Partial<KeySwitcher> | undefined;
        if (switcher && typeof switcher.switchKey === 'function') {
          switcher.switchKey(new Set<string>());
        }
      }
      if (!isRetryableStreamError(lastError)) throw lastError;
      if (attempt < maxAttempts) {
        // Linear backoff with jitter — never a fixed sleep.
        const base = ctx.config.retryDelayMs ?? 1000;
        await sleep(base * attempt + Math.floor(Math.random() * 250));
      }
    }
  }

  if (success && heldEmptyDone) {
    if (messages.at(-1)?.content !== SYNTHETIC_FOLLOW_UP_PROMPT) {
      // Ladder rule 1: the stream completed with no text and no tool calls —
      // ONE synthetic follow-up turn before surfacing the empty result.
      const nudged: ChatMessage[] = [
        ...messages,
        { role: 'user', content: SYNTHETIC_FOLLOW_UP_PROMPT },
      ];
      let followUpHeldDone: AIStreamChunk | null = null;
      let followUpEmitted = false;
      let followUpDoneSeen = false;
      try {
        const followUpStream = provider.chatStream(nudged, options);
        for await (const chunk of followUpStream) {
          if (chunk.done && accumulatedContent === '' && !chunk.toolCalls?.length) {
            followUpHeldDone = chunk;
            followUpDoneSeen = true;
            if (chunk.provider) resolvedProvider = chunk.provider;
            if (chunk.model) resolvedModel = chunk.model;
            if (chunk.usage) {
              finalUsage = {
                promptTokens: chunk.usage.promptTokens,
                completionTokens: chunk.usage.completionTokens,
                totalTokens: chunk.usage.totalTokens,
              };
            }
            continue;
          }
          followUpEmitted = true;
          everEmitted = true;
          if (chunk.done) followUpDoneSeen = true;
          accumulatedContent += chunk.content;
          if (chunk.provider) resolvedProvider = chunk.provider;
          if (chunk.model) resolvedModel = chunk.model;
          if (chunk.usage) {
            finalUsage = {
              promptTokens: chunk.usage.promptTokens,
              completionTokens: chunk.usage.completionTokens,
              totalTokens: chunk.usage.totalTokens,
            };
          }
          const fr = (chunk as { finishReason?: typeof finalFinishReason }).finishReason;
          if (fr) finalFinishReason = fr;
          yield chunk;
        }
      } catch (err) {
        const followUpError = err instanceof Error ? err : new Error(String(err));
        if (followUpEmitted) {
          yield {
            content: '',
            role: 'assistant' as const,
            provider: resolvedProvider,
            model: resolvedModel,
            finishReason: 'error',
            partialContent: accumulatedContent,
          } as unknown as AIStreamChunk;
          throw followUpError;
        }
        // Follow-up failed before emitting anything — fall back to the legacy
        // behavior for empty streams: surface the (structurally valid) empty
        // terminal and complete normally.
        console.warn('[RetryLadder] synthetic follow-up stream failed:', followUpError);
      }
      // Exactly ONE terminal chunk must reach the consumer: the follow-up's own
      // held done, or the original held done when the follow-up never produced
      // a terminal of its own.
      if (followUpHeldDone) {
        yield followUpHeldDone;
      } else if (!followUpDoneSeen) {
        yield heldEmptyDone;
      }
    } else {
      // The nudge would be a no-op (the conversation already ends with it) —
      // but the held terminal MUST still reach the consumer, or the stream
      // ends without any `done` chunk.
      yield heldEmptyDone;
    }
  }

  if (!success) {
    if (everEmitted) {
      // A previous attempt already streamed content — falling back would
      // duplicate it in the consumer's transcript.
      throw lastError;
    }
    const fallback = ctx.findFallbackProvider(provider.type);
    if (fallback) {
      try {
        accumulatedContent = '';
        resolvedProvider = fallback.type;
        resolvedModel = options?.model || fallback.defaultModel || 'default';
        const stream = fallback.chatStream(messages, options);
        for await (const chunk of stream) {
          accumulatedContent += chunk.content;
          if (chunk.provider) resolvedProvider = chunk.provider;
          if (chunk.model) resolvedModel = chunk.model;
          if (chunk.usage) {
            finalUsage = {
              promptTokens: chunk.usage.promptTokens,
              completionTokens: chunk.usage.completionTokens,
              totalTokens: chunk.usage.totalTokens,
            };
          }
          const fr = (chunk as { finishReason?: typeof finalFinishReason }).finishReason;
          if (fr) finalFinishReason = fr;
          yield chunk;
        }
        success = true;
      } catch (err) {
        const newMsg = err instanceof Error ? err.message : String(err);
        const oldMsg = lastError?.message ?? '';
        if (newMsg !== oldMsg) {
          console.warn('[Fallback Provider] stream error:', err);
        }
        if (accumulatedContent) {
          yield {
            content: '',
            role: 'assistant' as const,
            provider: resolvedProvider,
            model: resolvedModel,
            finishReason: 'error',
            partialContent: accumulatedContent,
          } as unknown as AIStreamChunk;
        }
        throw err instanceof Error ? err : new Error(String(err));
      }
    } else {
      throw lastError;
    }
  }

  // Cache the fully compiled response with the REAL finish reason so a
  // length-capped or tool-calling answer is not replayed as a plain stop.
  const completeResponse: ChatResponse = {
    content: accumulatedContent,
    model: resolvedModel,
    provider: resolvedProvider,
    usage: finalUsage,
    finishReason: finalFinishReason ?? 'stop',
  };

  try {
    await ctx.semanticCache.set(cacheKey, completeResponse);
  } catch (err) {
    console.warn('[SemanticCache] set stream error:', err);
  }
}
