// Default crew task executor: compiles the CrewAI identity triplet into a
// ReAct system prompt and runs one member's turn on a fresh ReActAgent.

import { ReActAgent } from '../react/agent.js';
import type {
  CreateReActAgentInput,
  PolicyGuard,
  ReActAgentCallbacks,
} from '../react/types.js';
import type { CrewAgentSpec, CrewExecutionRequest, CrewTaskExecutor } from './types.js';

/** Compile role/goal/backstory into the member's system prompt. */
export function crewAgentSystemPrompt(agent: CrewAgentSpec): string {
  const lines = [
    `You are ${agent.name}, the ${agent.role} of a cooperative crew.`,
    '',
    '# Your goal',
    agent.goal,
  ];
  if (agent.backstory) {
    lines.push('', '# Your backstory', agent.backstory);
  }
  lines.push(
    '',
    'Complete exactly the task you are given. Do not impersonate other crew',
    'members; when delegation tools are available, use them to involve the',
    'right teammate instead of doing their job yourself.',
  );
  return lines.join('\n');
}

export interface ReActCrewExecutorOptions {
  llmCall: CreateReActAgentInput['llmCall'];
  parseToolCalls?: CreateReActAgentInput['parseToolCalls'];
  /** Optional deny-default guard applied to every member's tool calls. */
  policyGuard?: PolicyGuard;
  /** Optional per-execution callbacks (step/tool streaming for the UI). */
  callbacks?: (request: CrewExecutionRequest) => ReActAgentCallbacks | undefined;
}

/**
 * Build a `CrewTaskExecutor` that runs each turn on a dedicated ReActAgent.
 * A fresh agent per execution keeps tool sets (which vary per task) correct
 * and prevents cross-task conversation leakage.
 *
 * The lightweight (non-durable) ReAct loop does not poll `config.signal`
 * between iterations, so cancellation is enforced here: the wrapped llmCall
 * throws as soon as the signal aborts, which unwinds the loop promptly.
 */
export function createReActCrewTaskExecutor(options: ReActCrewExecutorOptions): CrewTaskExecutor {
  return async (request: CrewExecutionRequest): Promise<string> => {
    const throwIfAborted = (): void => {
      if (request.signal?.aborted) {
        throw new Error('Crew task was cancelled.');
      }
    };
    throwIfAborted();

    const abortableLlmCall: typeof options.llmCall = async (messages, config) => {
      throwIfAborted();
      try {
        const response = await options.llmCall(messages, config);
        // The signal may have aborted during the call itself — a completed
        // response must not be handed back to a cancelled run.
        throwIfAborted();
        return response;
      } catch (err) {
        throwIfAborted();
        throw err;
      }
    };

    const agent = new ReActAgent({
      config: {
        name: request.agent.name,
        systemPrompt: crewAgentSystemPrompt(request.agent),
        maxIterations: request.agent.maxIterations,
        tools: request.tools,
        policyGuard: options.policyGuard,
        signal: request.signal,
      },
      llmCall: abortableLlmCall,
      parseToolCalls: options.parseToolCalls,
    });
    const result = await agent.run(request.prompt, options.callbacks?.(request));
    return result.output;
  };
}
