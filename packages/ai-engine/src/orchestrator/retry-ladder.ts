// Track S2 retry ladder (clean-room from a design description).
//
// Ladder rules for chat calls, applied per attempt:
//   1. empty response (no text, no tool calls, benign finish) → ONE synthetic
//      follow-up turn asking the model to answer the original request;
//   2. 429 / rate-limited → switch-key EXACTLY once per request (KeyManager
//      cooldown is the backbone; exclude-set rules out keys already tried);
//   3. content_filter → never retried (deterministic block — retrying only
//      burns budget); surfaced as a non-retryable AgentError;
//   4. everything else → rethrown untouched so the caller's legacy retry +
//      provider-fallback semantics keep their exact call counts.
//
// The ladder runs INSIDE the legacy retry wrapper: `state` is shared across
// re-invocations so the once-only guarantees hold for the whole request.

import type { ChatMessage, ChatResponse } from '../types.js';
import { AgentError } from '../errors/index.js';
import { isNonEmptyChatContent } from '../standard-request.js';

export const SYNTHETIC_FOLLOW_UP_PROMPT =
  '[ladder] Your previous reply was empty. Respond to the original request now.';

export const MAX_SYNTHETIC_FOLLOW_UPS = 1;
export const MAX_KEY_SWITCHES = 1;

export interface KeySwitcher {
  /** Returns a different healthy key for the next attempt, or null. */
  switchKey(exclude?: ReadonlySet<string>): string | null;
}

/** Per-request ladder state — shared across legacy retry re-invocations. */
export interface RetryLadderState {
  syntheticFollowUps: number;
  keySwitchAttempts: number;
}

export function createRetryLadderState(): RetryLadderState {
  return { syntheticFollowUps: 0, keySwitchAttempts: 0 };
}

export interface RetryLadderDeps {
  /** Primary provider chat call (already includes any middleware). */
  call: (messages: ChatMessage[]) => Promise<ChatResponse>;
  /** Key switch capability (already capped to MAX_KEY_SWITCHES), or null. */
  switchKey: ((exclude?: ReadonlySet<string>) => string | null) | null;
}

/** One chat attempt, including the empty-response synthetic follow-up (max 1
 * per request, shared across retry re-invocations). */
async function attemptWithEmptyGuard(
  deps: RetryLadderDeps,
  state: RetryLadderState,
  messages: ChatMessage[],
): Promise<ChatResponse> {
  const response = await deps.call(messages);
  if (isNonEmptyChatContent(response.content, response.toolCalls)) {
    return response;
  }

  // finishReason 'error' with no content/tool calls = a blocked or hard-failed
  // generation (e.g. provider content filter), NOT an empty answer.
  // Ladder rule 3: never nudged, never retried.
  if (response.finishReason === 'error') {
    throw new AgentError(
      `${response.provider ?? 'provider'} returned an empty response with finishReason "error" (content filter or hard failure)`,
      { code: 'content_filter', provider: response.provider, retryable: false },
    );
  }

  if (state.syntheticFollowUps >= MAX_SYNTHETIC_FOLLOW_UPS) {
    return response;
  }
  // Already nudged upstream — do not stack another synthetic turn.
  if (messages.at(-1)?.content === SYNTHETIC_FOLLOW_UP_PROMPT) {
    return response;
  }

  state.syntheticFollowUps++;
  return deps.call([...messages, { role: 'user', content: SYNTHETIC_FOLLOW_UP_PROMPT }]);
}

export async function runChatRetryLadder(
  deps: RetryLadderDeps,
  messages: ChatMessage[],
  state: RetryLadderState = createRetryLadderState(),
): Promise<ChatResponse> {
  try {
    return await attemptWithEmptyGuard(deps, state, messages);
  } catch (error) {
    const agentError = AgentError.from(error);

    // Ladder rule 3: content filter is deterministic — surface immediately.
    if (agentError.code === 'content_filter') {
      throw agentError;
    }

    // Ladder rule 2: 429 → switch key exactly once, then a single retry.
    if (
      agentError.code === 'rate_limited' &&
      deps.switchKey &&
      state.keySwitchAttempts < MAX_KEY_SWITCHES
    ) {
      state.keySwitchAttempts++;
      const nextKey = deps.switchKey(new Set<string>());
      if (nextKey) {
        try {
          return await attemptWithEmptyGuard(deps, state, messages);
        } catch (retryError) {
          throw AgentError.from(retryError);
        }
      }
      // No alternative key: rethrow into the legacy retry, whose KeyManager
      // cooldown rotation keeps single-key setups retrying as before.
    }

    // Ladder rule 4: everything else keeps legacy semantics.
    throw error instanceof Error ? error : new Error(String(error));
  }
}
