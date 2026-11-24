// Thin facade that composes sub-modules: chat, tool-calling, embedding.
// Constructor initializes all modules; public methods delegate to sub-modules.

import type { AIProviderType, AIStreamChunk } from '@ghita/shared';
import { retry } from '@ghita/shared';
import type {
  AIProvider,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  OrchestratorConfig,
  OrchestratorStatus,
  EmbeddingResponse,
  EmbeddingManyResponse,
} from './types.js';
import { ProviderRegistry } from './registry.js';
import { MCPClient } from './mcp/client.js';
import type { MCPTool, MCPToolResult } from './mcp/types.js';
import { HookRunner } from './hooks/runner.js';
import type { HookConfig, HookResult } from './hooks/types.js';
import { createBuiltInTools, type BuiltInTool } from './tools/index.js';
import { ContextManager } from './context/manager.js';
import { PermissionManager } from './security/permissions.js';
import { SecurityChecker } from './hooks/security-checkers.js';
import type { z } from 'zod';
import type { GenerateObjectResponse } from './utils/structured.js';
import { SemanticCache } from './cache/semantic-cache.js';
import { CostTracker, BudgetManager, createCostMiddleware } from './cost/index.js';
import { AgentError } from './errors/index.js';
import { wrapProvider } from './utils/middleware.js';
import { SmartRouter } from './routing/smart-router.js';
import type { RoutingDecision } from './routing/types.js';
import { ModelDiscovery } from './discovery/model-discovery.js';
import type { DiscoveryResult } from './discovery/types.js';
import { EventStream } from './stream/event-stream.js';
import { streamObjectType } from './stream-protocol.js';

// Decomposed sub-modules
import type { OrchestratorContext } from './orchestrator/types.js';
import { orchestratorChat, orchestratorChatStream } from './orchestrator/chat.js';
import {
  getMCPTools,
  callMCPTool,
  loadHooks,
  runPreToolHooks,
  runPostToolHooks,
  getBuiltInTool,
  callBuiltInTool,
  needsContextCompact,
  compactContext,
  getContextUsage,
} from './orchestrator/tool-calling.js';
import {
  orchestratorEmbed,
  orchestratorEmbedMany,
  orchestratorGenerateObject,
  orchestratorGenerateImage,
  orchestratorGenerateSpeech,
  orchestratorGenerateVideo,
  orchestratorTranscribe,
} from './orchestrator/embedding.js';

// Re-export helpers for backward compatibility
export { stableMessageKey } from './orchestrator/helpers.js';

export class Orchestrator {
  private _registry: ProviderRegistry;
  private _config: OrchestratorConfig;
  private _defaultProvider: AIProviderType | null = null;
  private _fallbackOrder: AIProviderType[] = [];

  readonly mcpClient: MCPClient;
  readonly hookRunner: HookRunner;
  readonly builtInTools: BuiltInTool[];
  readonly contextManager: ContextManager;
  readonly permissionManager: PermissionManager;

  readonly costTracker: CostTracker;
  readonly budgetManager: BudgetManager;
  private costMiddleware: ReturnType<typeof createCostMiddleware>;
  readonly semanticCache: SemanticCache;

  readonly modelDiscovery: ModelDiscovery;
  readonly smartRouter: SmartRouter | null = null;

  /**
   * Track S3 P2: the (previously unwired) EventStream bus. Every streamed
   * chunk now flows through `message.delta` / `message.complete` events with
   * its StreamObject `type`, so reasoning deltas become observable downstream
   * (ring buffer + rewind are already provided by the bus).
   */
  private readonly _eventStream = new EventStream();

  constructor(config: OrchestratorConfig) {
    this._config = config;
    this._registry = new ProviderRegistry();

    for (const providerConfig of config.providers) {
      this._registry.registerFromConfig(providerConfig);
    }

    this._defaultProvider = config.defaultProvider ?? null;
    this._fallbackOrder = config.fallbackOrder ?? [];

    this.mcpClient = new MCPClient();
    if (config.mcpServers) {
      for (const server of config.mcpServers) {
        this.mcpClient.addServer({
          name: server.name,
          command: server.command,
          args: server.args,
          url: server.url,
          transport: server.transport,
          env: server.env,
          enabled: server.enabled,
        });
      }
    }

    this.hookRunner = new HookRunner();
    this.hookRunner.addHook(new SecurityChecker().createPreToolHook());
    this.builtInTools = createBuiltInTools();
    this.contextManager = new ContextManager();
    this.permissionManager = new PermissionManager();

    this.costTracker = new CostTracker();
    const limit = config.costLimitUsd ?? 5.0;
    this.budgetManager = new BudgetManager({
      limit,
      period: 'monthly',
      onAlert: (spent, limit, percentage) => {
        console.warn(
          `[Orchestrator] AI budget alert: spent $${spent.toFixed(4)} of $${limit.toFixed(4)} (${(percentage * 100).toFixed(1)} percent)`,
        );
      },
    });
    this.costMiddleware = createCostMiddleware({
      costTracker: this.costTracker,
      budgetManager: this.budgetManager,
    });

    this.semanticCache = new SemanticCache(
      {
        embed: async (text) => {
          const emb = await this.embed(text);
          return { embedding: emb.embedding };
        },
      },
      {
        qdrantUrl: config.qdrantUrl,
        collectionName: config.collectionName,
        threshold: config.cacheThreshold ?? 0.95,
        fallbackToInMemory: true,
      },
    );

    this.modelDiscovery = new ModelDiscovery();
    if (config.smartRouting) {
      this.smartRouter = new SmartRouter({
        strategy: config.smartRouting.strategy,
        maxCostPerRequest: config.smartRouting.maxCostPerRequest,
        maxLatencyMs: config.smartRouting.maxLatencyMs,
        minQualityScore: config.smartRouting.minQualityScore,
      });
    }
  }

  /** Internal context for sub-modules */
  private get ctx(): OrchestratorContext {
    return {
      config: this._config,
      registry: this._registry,
      defaultProvider: this._defaultProvider,
      fallbackOrder: this._fallbackOrder,
      mcpClient: this.mcpClient,
      hookRunner: this.hookRunner,
      builtInTools: this.builtInTools,
      contextManager: this.contextManager,
      permissionManager: this.permissionManager,
      costTracker: this.costTracker,
      budgetManager: this.budgetManager,
      semanticCache: this.semanticCache,
      modelDiscovery: this.modelDiscovery,
      smartRouter: this.smartRouter,
      resolveProvider: (p, a) => this.resolveProvider(p, a),
      findFallbackProvider: (t) => this.findFallbackProvider(t),
      executeWithFallback: (fn, p, m) => this.executeWithFallback(fn, p, m),
    };
  }

  // --- Registry & Routing ---

  getRegistry(): ProviderRegistry {
    return this._registry;
  }

  async discoverModels(providerType?: AIProviderType): Promise<DiscoveryResult> {
    const config = this._config.providers.find((p) => p.type === providerType);
    if (!config) throw new Error(`Provider ${providerType} not configured`);
    return this.modelDiscovery.discoverModels({
      baseUrl: config.baseUrl ?? '',
      apiKey: config.apiKey,
      providerType: providerType as string,
      authStyle: 'bearer',
      parseResponse: (data: unknown) => {
        const d = data as { data?: { id: string }[] };
        return (d.data ?? []).map((m) => ({
          id: m.id,
          name: m.id,
          provider: providerType as string,
        }));
      },
    });
  }

  getRoutingMetrics() {
    return this.smartRouter?.getMetrics() ?? [];
  }

  getRoutingDecision(_preferred?: AIProviderType, _agentRole?: string): RoutingDecision | null {
    if (!this.smartRouter) return null;
    const available = this._registry.getAll().map((p) => ({ type: p.type, model: p.defaultModel }));
    return this.smartRouter.route(available);
  }

  // --- Chat (delegates to orchestrator/chat.ts) ---

  async chat(
    messages: ChatMessage[],
    options?: ChatOptions & { provider?: AIProviderType },
  ): Promise<ChatResponse> {
    return orchestratorChat(this.ctx, messages, options);
  }

  async *chatStream(
    messages: ChatMessage[],
    options?: ChatOptions & { provider?: AIProviderType },
  ): AsyncGenerator<AIStreamChunk> {
    // Track S3 P2: emit every chunk onto the EventStream bus (fire-and-forget
    // — subscriber errors are swallowed by the bus and must never break the
    // stream). Pure observation; the S2 retry/fallback logic is untouched.
    this.emitStreamEvent('message.start', { providerHint: options?.provider });
    for await (const chunk of orchestratorChatStream(this.ctx, messages, options)) {
      this.emitStreamEvent('message.delta', {
        type: streamObjectType(chunk),
        content: chunk.content,
        done: chunk.done === true,
        provider: chunk.provider,
        model: chunk.model,
        toolCallId: chunk.toolCallId,
        reason: chunk.reason,
        hasToolCalls: Boolean(chunk.toolCalls?.length),
      });
      if (chunk.done) {
        this.emitStreamEvent('message.complete', {
          type: streamObjectType(chunk),
          provider: chunk.provider,
          model: chunk.model,
          usage: chunk.usage,
        });
      }
      yield chunk;
    }
  }

  /** Access the engine event bus (ring buffer, rewind, replay). */
  getEventStream(): EventStream {
    return this._eventStream;
  }

  private emitStreamEvent(
    type: 'message.start' | 'message.delta' | 'message.complete',
    data: Record<string, unknown>,
  ): void {
    this._eventStream.emit(type, 'orchestrator', data).catch((err) => {
      console.warn('[Orchestrator] EventStream emit failed:', err);
    });
  }

  // --- Embedding & Media (delegates to orchestrator/embedding.ts) ---

  async generateObject<T>(
    schema: z.ZodType<T>,
    messages: ChatMessage[],
    options?: ChatOptions & { provider?: AIProviderType },
  ): Promise<GenerateObjectResponse<T>> {
    return orchestratorGenerateObject(this.ctx, this, schema, messages, options);
  }

  async embed(
    text: string,
    options?: { model?: string; provider?: AIProviderType },
  ): Promise<EmbeddingResponse> {
    return orchestratorEmbed(this.ctx, text, options);
  }

  async embedMany(
    texts: string[],
    options?: { model?: string; provider?: AIProviderType },
  ): Promise<EmbeddingManyResponse> {
    return orchestratorEmbedMany(this.ctx, texts, options);
  }

  async generateImage(
    prompt: string,
    options?: Record<string, unknown> & { provider?: AIProviderType },
  ): Promise<{ url: string; b64?: string }> {
    return orchestratorGenerateImage(this.ctx, prompt, options);
  }

  async generateSpeech(
    text: string,
    options?: Record<string, unknown> & { provider?: AIProviderType },
  ): Promise<{ audio: Buffer; contentType: string }> {
    return orchestratorGenerateSpeech(this.ctx, text, options);
  }

  async generateVideo(
    prompt: string,
    options?: Record<string, unknown> & { provider?: AIProviderType },
  ): Promise<{ url: string }> {
    return orchestratorGenerateVideo(this.ctx, prompt, options);
  }

  async transcribe(
    audio: Buffer,
    options?: Record<string, unknown> & { provider?: AIProviderType },
  ): Promise<{ text: string }> {
    return orchestratorTranscribe(this.ctx, audio, options);
  }

  // --- Status & Config ---

  async testAll(): Promise<Array<{ type: AIProviderType; ok: boolean; error?: string }>> {
    // Parallel health checks: sequential awaits made the total wait the SUM of
    // per-provider latencies.
    return Promise.all(
      this._registry.getAll().map(async (provider) => {
        try {
          return { type: provider.type, ok: await provider.test() };
        } catch (error) {
          return {
            type: provider.type,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  async getStatus(): Promise<OrchestratorStatus> {
    const allProviders = this._registry.getAll();
    const statuses = await Promise.all(
      allProviders.map(async (p) => ({ type: p.type, ready: await p.isReady() })),
    );
    const readyProviders = statuses.filter((s) => s.ready);
    return {
      availableProviders: readyProviders.map((s) => s.type),
      defaultProvider: this._defaultProvider,
      totalProviders: allProviders.length,
      readyProviders: readyProviders.length,
    };
  }

  setDefaultProvider(type: AIProviderType | null): void {
    this._defaultProvider = type;
  }
  setFallbackOrder(order: AIProviderType[]): void {
    this._fallbackOrder = order;
  }

  // --- Tool-Calling (delegates to orchestrator/tool-calling.ts) ---

  getMCPTools(): MCPTool[] {
    return getMCPTools(this.ctx);
  }
  async callMCPTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<MCPToolResult> {
    return callMCPTool(this.ctx, serverName, toolName, args);
  }
  loadHooks(hooks: HookConfig[]): void {
    loadHooks(this.ctx, hooks);
  }
  async runPreToolHooks(
    toolName: string,
    toolArgs?: Record<string, unknown>,
  ): Promise<HookResult[]> {
    return runPreToolHooks(this.ctx, toolName, toolArgs);
  }
  async runPostToolHooks(
    toolName: string,
    toolArgs?: Record<string, unknown>,
    toolResult?: string,
  ): Promise<HookResult[]> {
    return runPostToolHooks(this.ctx, toolName, toolArgs, toolResult);
  }
  getBuiltInTool(name: string): BuiltInTool | undefined {
    return getBuiltInTool(this.ctx, name);
  }
  async callBuiltInTool(name: string, args: Record<string, unknown>): Promise<string> {
    return callBuiltInTool(this.ctx, name, args);
  }
  needsContextCompact(messages: ChatMessage[]): boolean {
    return needsContextCompact(this.ctx, messages);
  }
  compactContext(messages: ChatMessage[]): ChatMessage[] {
    return compactContext(this.ctx, messages);
  }
  getContextUsage(messages: ChatMessage[]): { used: number; max: number; percentage: number } {
    return getContextUsage(this.ctx, messages);
  }

  // --- Private ---

  private mapModelKeyToProviderType(modelKey: string): AIProviderType | null {
    const key = modelKey.toLowerCase();
    const allTypes: AIProviderType[] = [
      'openai',
      'anthropic',
      'google',
      'ollama',
      'custom',
      'opengateway',
      'mimo',
      'openrouter',
      'deepseek',
      'groq',
      'mistral',
      'hicap',
      'github-models',
      'cerebras',
      'together',
      'fireworks',
      'cohere',
      'xai',
      'replicate',
      'perplexity',
      'voyage',
      'ai21',
      'sambanova',
      'novita',
      'opencode-zen',
      'nvidia-nim',
    ];
    for (const type of allTypes) {
      if (key === type || key.includes(type)) return type;
    }
    if (key.includes('claude')) return 'anthropic';
    if (key.includes('gemini')) return 'google';
    return null;
  }

  private resolveProvider(preferred?: AIProviderType, agentRole?: string): AIProvider {
    // 1. Explicit preference takes precedence
    if (preferred) {
      const p = this._registry.get(preferred);
      if (p) return this.wrapWithCostMiddleware(p);
    }

    // 2. Try Smart Router if available (cost/quality/latency optimized)
    if (this.smartRouter) {
      const available = this._registry
        .getAll()
        .map((p) => ({ type: p.type, model: p.defaultModel }));
      const decision = this.smartRouter.route(available);
      if (decision) {
        const p = this._registry.get(decision.provider);
        if (p) return this.wrapWithCostMiddleware(p);
      }
    }

    // 3. Agent role routing from config
    if (agentRole && this._config.routing) {
      const modelKey = this._config.routing[agentRole] || this._config.routing['default'];
      if (modelKey) {
        const providerType = this.mapModelKeyToProviderType(modelKey);
        if (providerType) {
          const p = this._registry.get(providerType);
          if (p) return this.wrapWithCostMiddleware(p);
        }
      }
    }

    // 4. Default provider
    if (this._defaultProvider) {
      const p = this._registry.get(this._defaultProvider);
      if (p) return this.wrapWithCostMiddleware(p);
    }

    // 5. Fallback order
    if (this._fallbackOrder.length > 0) {
      for (const type of this._fallbackOrder) {
        const p = this._registry.get(type);
        if (p) return this.wrapWithCostMiddleware(p);
      }
    }

    // 6. Any available provider
    const all = this._registry.getAll();
    if (all.length > 0 && all[0]) return this.wrapWithCostMiddleware(all[0]);
    throw new Error('No AI providers registered');
  }

  private wrapWithCostMiddleware(provider: AIProvider): AIProvider {
    return wrapProvider(provider, {
      chat: [this.costMiddleware.chat],
      chatStream: [this.costMiddleware.chatStream],
    });
  }

  private findFallbackProvider(currentType: AIProviderType): AIProvider | null {
    for (const type of this._fallbackOrder) {
      if (type === currentType) continue;
      const p = this._registry.get(type);
      if (p) return this.wrapWithCostMiddleware(p);
    }
    return null;
  }

  private async executeWithFallback<T>(
    fn: (provider: AIProvider) => Promise<T>,
    primary: AIProvider,
    maxAttempts: number,
  ): Promise<T> {
    try {
      return await retry(() => fn(primary), maxAttempts, this._config.retryDelayMs ?? 1000, {
        // Track S2 ladder: content-filter blocks are deterministic — retrying
        // only burns budget. Every other classification keeps the shared
        // default semantics (auth / hard-4xx non-retryable, rest retryable).
        isRetryable: (error) => AgentError.from(error).retryable,
      });
    } catch (primaryError) {
      const fallback = this.findFallbackProvider(primary.type);
      if (fallback) {
        try {
          return await fn(fallback);
        } catch {
          throw primaryError;
        }
      }
      throw primaryError;
    }
  }
}
