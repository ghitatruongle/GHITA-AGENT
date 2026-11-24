import type { ChatMiddleware, ChatStreamMiddleware } from '../utils/middleware.js';
import type { CostTracker } from './tracker.js';
import type { BudgetManager } from './budget.js';
import { tokenUsageTracker, estimateUsageFromLength } from '../token-tracker.js';

export interface CostMiddlewareConfig {
  costTracker: CostTracker;
  budgetManager: BudgetManager;
}

export function createCostMiddleware(config: CostMiddlewareConfig): {
  chat: ChatMiddleware;
  chatStream: ChatStreamMiddleware;
} {
  const { costTracker, budgetManager } = config;

  const handleTelemetry = () => {
    const g = globalThis as Record<string, unknown>;
    if (typeof globalThis !== 'undefined' && g.broadcastCostTelemetryHandler) {
      try {
        const handler = g.broadcastCostTelemetryHandler as (data: Record<string, unknown>) => void;
        handler({
          costUsd: costTracker.getTotalCost(),
          limitUsd: budgetManager.getLimit(),
        });
      } catch (err) {
        console.warn('[CostMiddleware] Telemetry broadcast failed:', err);
      }
    }
  };

  const chatMiddleware: ChatMiddleware = async ({ messages, options, provider }, next) => {
    // Check budget before proceeding
    budgetManager.checkBudget(0);

    const response = await next(messages, options);

    const modelName = response.model || provider.defaultModel || 'default';
    const promptTokens = response.usage?.promptTokens ?? 0;
    const completionTokens = response.usage?.completionTokens ?? 0;

    const stepCost = costTracker.calculateCost(modelName, promptTokens, completionTokens);
    await costTracker.trackCost(modelName, promptTokens, completionTokens);
    budgetManager.recordSpent(stepCost);

    // Track S3 P1: attribute the step to the active TokenUsageTracker run
    // (no-op when there is no run scope). One step per non-stream chat call.
    tokenUsageTracker.recordStep({
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: response.usage?.totalTokens ?? promptTokens + completionTokens,
      },
      model: modelName,
      provider: provider.type,
      costUsd: stepCost,
    });

    handleTelemetry();

    return response;
  };

  const chatStreamMiddleware: ChatStreamMiddleware = async (
    { messages, options, provider },
    next,
  ) => {
    // Check budget before proceeding
    budgetManager.checkBudget(0);

    const gen = await next(messages, options);

    return (async function* () {
      let accumulatedContent = '';
      let resolvedModel = options?.model || provider.defaultModel || 'default';
      let finalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let success = false;

      try {
        for await (const chunk of gen) {
          if (chunk.content) {
            accumulatedContent += chunk.content;
          }
          if (chunk.model) {
            resolvedModel = chunk.model;
          }
          if (chunk.usage) {
            finalUsage = {
              promptTokens: chunk.usage.promptTokens,
              completionTokens: chunk.usage.completionTokens,
              totalTokens: chunk.usage.totalTokens,
            };
          }
          yield chunk;
        }
        success = true;
      } finally {
        if (success) {
          let estimated = false;
          if (finalUsage.totalTokens === 0) {
            // Rough estimation if provider didn't return usage — shared
            // formula with the TokenUsageTracker (ceil(len / 4)).
            const promptText = messages.map((m) => m.content).join('\n');
            finalUsage = estimateUsageFromLength(promptText, accumulatedContent);
            estimated = true;
          }

          const stepCost = costTracker.calculateCost(
            resolvedModel,
            finalUsage.promptTokens,
            finalUsage.completionTokens,
          );
          await costTracker.trackCost(
            resolvedModel,
            finalUsage.promptTokens,
            finalUsage.completionTokens,
          );
          budgetManager.recordSpent(stepCost);

          // Track S3 P1: attribute the step to the active run (no-op when no
          // run scope). Fired only on clean completion, matching `success`.
          tokenUsageTracker.recordStep({
            usage: finalUsage,
            model: resolvedModel,
            provider: provider.type,
            costUsd: stepCost,
            estimated,
          });

          handleTelemetry();
        }
      }
    })();
  };

  return {
    chat: chatMiddleware,
    chatStream: chatStreamMiddleware,
  };
}
