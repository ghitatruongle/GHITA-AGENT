//
// The AI Engine is the central intelligence layer of Ghita Agent.
// It provides:
//
// - **Multi-Provider Support**: 10+ LLM providers (OpenAI, Anthropic, Google,
//   Ollama, Groq, Mistral, DeepSeek, Kimi, MiniMax, Custom) via a unified
//   `LLMProvider` interface.
// - **Smart Routing**: Complexity-aware routing (`AdaptiveRouter`, `SmartRouter`,
//   `UnifiedRouter`) with circuit-breaker fallback and cost optimization.
// - **Key Management**: Multi-key rotation with health monitoring, cooldown
//   periods, and configurable strategies (round-robin, failover, random).
// - **Streaming**: SSE-based streaming with encoder/decoder, response buffering,
//   and middleware pipeline for real-time token delivery.
// - **Context Management**: Token counting, context windowing, trajectory
//   compression, and automatic truncation to fit model context limits.
// - **Cost & Budget**: Per-request cost tracking, budget enforcement, and
//   model pricing tables for informed routing decisions.
// - **Security**: Permission management, content filtering, PII detection,
//   secret scanning, and security guardrails as hook middleware.
// - **MCP Integration**: Model Context Protocol client supporting Stdio, SSE,
//   and HTTP transports for tool discovery and execution.
// - **Caching**: In-memory LRU cache, Redis-backed cache, and semantic
//   deduplication for response reuse.
// - **Observability**: Hook system for pre/post model call auditing, telemetry
//   emission, and custom security checkers.
//
// @packageDocumentation
// @module @ghita/ai-engine

/**
 * Core type definitions for AI providers, chat messages, and orchestration.
 * These types form the foundation of the multi-provider architecture.
 */
export type {
  AIProvider,
  ChatMessage,
  ChatRole,
  ChatOptions,
  ChatResponse,
  TokenUsage,
  ProviderConfig,
  OrchestratorConfig,
  OrchestratorStatus,
  KeyRotationStrategy,
} from './types.js';

// --- Errors ---
export * from './errors/index.js';

/**
 * Multi-key management with health monitoring, cooldown, and rotation strategies.
 * Supports round-robin, failover, and random key selection across multiple API keys
 * per provider for load distribution and rate-limit avoidance.
 */
export { KeyManager } from './key-manager.js';
export type { KeyEntry, KeyHealthStatus, KeyUsageStats } from './key-manager.js';

/**
 * Auto-discover available models from connected providers.
 * Probes OpenAI-compatible APIs, Ollama tags, Google Generative AI,
 * and Replicate model lists with configurable cache TTL.
 */
export {
  ModelDiscovery,
  parseOpenAICompat,
  parseOllamaTags,
  parseGoogleModels,
  parseReplicateModels,
} from './discovery/model-discovery.js';
export type { ModelInfo, DiscoveryResult, DiscoveryConfig } from './discovery/types.js';

/**
 * Intelligent request routing based on task complexity, provider latency,
 * cost constraints, and availability. Supports strategies: cost-optimized,
 * quality-first, latency-first, and adaptive complexity analysis.
 */
export { SmartRouter } from './routing/smart-router.js';
export type {
  RoutingStrategy,
  RoutingDecision,
  RoutingConfig,
  ProviderMetrics,
} from './routing/types.js';

export { AdaptiveBanditRouter, betaSample, REQUEST_BUCKETS } from './routing/adaptive-router.js';
export type {
  RequestBucket,
  BanditArm,
  ArmStats,
  BanditRouterConfig,
  SelectOptions,
  SignalKind,
} from './routing/adaptive-router.js';
export {
  ModelRoleRouter,
  DEFAULT_ROLE_CHAINS,
  MODEL_ROLES,
  qualifyModelId,
} from './routing/model-roles.js';

export { ModelCatalog, createDefaultCatalog } from './routing/model-catalog.js';
export type { ModelEntry, FailoverGroup } from './routing/model-catalog.js';

export {
  classifyTier,
  tierToBuckets,
  PersistentBanditRouter,
  RouterV2,
} from './routing/router-v2.js';
export type {
  TurnTier,
  ComplexityClassifierOptions,
  RouterV2Options,
} from './routing/router-v2.js';

export {
  createExtractReasoningMiddleware,
  createSimulateStreamingMiddleware,
  createRepairedParseMiddleware,
} from './middleware/model-middleware.js';

export {
  shouldUseProgressiveDisclosure,
  createBridgeTools,
  resolveToolsForContext,
  estimateToolDefinitionsTokens,
} from './tools/progressive-disclosure.js';
export type { ProgressiveDisclosureConfig } from './tools/progressive-disclosure.js';
export type {
  ModelRole,
  RoleConfig,
  ModelRoleRouterOptions,
  RoleResolution,
} from './routing/model-roles.js';

/**
 * LLM provider implementations. Each provider extends `BaseProvider`
 * and implements the unified `LLMProvider` interface for chat completion,
 * streaming, and tool calling.
 */
export { BaseProvider } from './providers/base.js';
export { OpenAIProvider } from './providers/openai.js';
export { AnthropicProvider } from './providers/anthropic.js';
export { GoogleProvider } from './providers/google.js';
export { OllamaProvider } from './providers/ollama.js';
export { CustomProvider } from './providers/custom.js';
/** Dedicated Groq API provider implementation. */
export { GroqProvider } from './providers/groq.js';
/** Dedicated Mistral API provider implementation. */
export { MistralProvider } from './providers/mistral.js';

/**
 * Unified provider types and interface definitions for all LLM backends.
 */
export type {
  LLMProvider,
  ProviderCapabilities,
  SSEEventType,
  SSEStreamEvent,
  ResponseBufferState,
  ProviderYAMLConfig,
  ProvidersYAMLRoot,
} from './providers/types.js';
/** Utility to convert parsed YAML config to structured provider config. */
export { yamlToProviderConfig } from './providers/types.js';
/** SSE encoding and decoding utilities for real-time streaming tokens. */
export { SSEEncoder, SSEDecoder, ResponseBuffer, toSSEStream } from './providers/sse-stream.js';
/** Zod schemas and loaders for YAML-based provider configuration files. */
export {
  ProviderYAMLConfigSchema,
  ProvidersYAMLRootSchema,
  ProviderConfigLoader,
  parseSimpleYAML,
} from './providers/config-schema.js';

/**
 * Provider registry for managing active providers, and the Orchestrator
 * that coordinates multi-provider request handling with fallback chains.
 */
export { ProviderRegistry } from './registry.js';
export { Orchestrator } from './orchestrator.js';

/** gRPC server for high-performance binary communication with VS Code extension. */
export { GrpcServer } from './grpc/server.js';

/**
 * Application config loader supporting JSON/YAML and environment interpolation.
 */
export { ConfigLoader } from './utils/configLoader.js';
/** Types representing local configuration settings. */
export type { LocalConfig } from './utils/configLoader.js';

/**
 * SecurityGuard scanner for screening code safety, shell inputs, and database queries.
 */
export { SecurityGuard } from './utils/security.js';
/** Results returned by security guard analysis scans. */
export type { SecurityScanResult } from './utils/security.js';

/** Cryptographic helper for secure key hashing and pairing code validation. */
export { CryptoHelper } from './utils/crypto.js';

/**
 * Manager coordinating background execution loops and agent telemetry.
 */
export { RalphLoopManager } from './utils/ralph.js';
/** Configuration and state interfaces for Ralph loops. */
export type { RalphLoopConfig, RalphLoopState } from './utils/ralph.js';

/** Helper to extract structured reasoning content and stream chunks from LLM outputs. */
export { extractReasoning, ReasoningStreamExtractor } from './utils/reasoning.js';
/** Types representing extracted reasoning results. */
export type { ExtractedReasoning, ReasoningStreamResult } from './utils/reasoning.js';

/**
 * Model Context Protocol (MCP) client for connecting to external tool servers.
 * Supports Stdio, SSE, and HTTP transports with auto-reconnection.
 */
export { MCPClient } from './mcp/client.js';
/** Client transport implementations for stdio and SSE connections. */
export { StdioTransport, SSETransport, createTransport } from './mcp/transport.js';
/** Type definitions for MCP client tools, server configs, and status states. */
export type {
  MCPServerConfig,
  MCPTool,
  MCPToolResult,
  MCPServerStatus,
  MCPConfig,
  MCPTransportType,
} from './mcp/types.js';

/** Runner coordinating pre- and post-execution hook chains. */
export { HookRunner } from './hooks/runner.js';
/** SecurityChecker that runs safety filters and detects risk indicators on hooks. */
export { SecurityChecker } from './hooks/security-checkers.js';
/** Type definitions for LLM call hooks, telemetry logging, and security risk profiling. */
export type {
  HookConfig,
  HookEvent,
  HookResult,
  HookRunnerConfig,
  HookMatcher,
  HookErrorStrategy,
  SecurityRiskLevel,
  HookHandler,
  CompositeHookResult,
  HookAuditEntry,
  HookStats,
  SecurityAnalysis,
  SecurityProfile,
} from './hooks/types.js';

/** Built-in tools for searching and fetching web pages. */
export { WebSearchTool, WebFetchTool, createBuiltInTools } from './tools/index.js';
/** Types representing search query results and web response buffers. */
export type { SearchResult, SearchResponse, FetchResponse, BuiltInTool } from './tools/index.js';

/**
 * Context window management — token counting, message truncation,
 * and trajectory compression for optimal context utilization.
 */
export { ContextManager } from './context/manager.js';
/** Configuration options for the ContextManager. */
export type { ContextConfig } from './context/manager.js';
/** Compressor that simplifies agent trajectory message lists for LLM invocation. */
export { TrajectoryCompressor } from './context/compressor.js';
/** Types representing compression strategies, configuration, and analysis. */
export type {
  CompressionResult,
  CompressorConfig,
  MessageAnalysis,
  MessageImportance,
} from './context/compressor.js';

/**
 * Permission system controlling which tools an agent can execute.
 * Supports 'auto', 'confirm', and 'deny' permission levels per tool.
 */
export { PermissionManager } from './security/permissions.js';

export {
  createReceipt,
  attachReceipt,
  filterReportable,
  partitionFindings,
  validateStatic,
} from './security/validation-ladder.js';
export type {
  ValidationReceipt,
  ValidatedFinding,
  ValidationMethod,
  FindingDisposition,
} from './security/validation-ladder.js';
export {
  buildSarifLog,
  computeClassHash,
  safeFence,
  renderFindingMarkdown,
} from './security/sarif.js';
export type { SarifLog, SarifResult, FindingForSarif } from './security/sarif.js';
export { verifyFix } from './security/fix-rescan.js';
export type { RescanResult, RescanStatus, FixRescanOptions } from './security/fix-rescan.js';
export {
  InstinctRegistry,
  scoreCommand,
  shouldBlockCommand,
  createScanManifest,
  validateManifest,
} from './security/security-quality.js';
export type {
  TaxonomyEntry,
  CommandScore,
  RiskLevel,
  ScanManifest,
  ScanFindingsArtifact,
  ScanCoverageArtifact,
} from './security/security-quality.js';
/** Types representing tool execution permission levels. */
export type { PermissionLevel, ToolPermission } from './security/permissions.js';

// SecurityChecker and security types are exported above in the Hooks section

/** Standard error classes representing LLM network, verification, and runtime faults. */
export {
  AIBaseError,
  AIAPIError,
  AIValidationError,
  AITimeoutError,
  AIRateLimitError,
  AIInvalidConfigError,
  AINoProviderError,
  AIToolCallRepairError,
  AIPermissionDeniedError,
  AISecurityGuardrailError,
  AIUnsupportedFeatureError,
  AIBudgetExceededError,
} from './errors/index.js';

/**
 * Response caching with LRU eviction (in-memory), Redis persistence,
 * and semantic deduplication via embedding similarity.
 */
export { InMemoryCache, RedisCache, SemanticCache } from './utils/cache.js';
/** Base cache interfaces and configuration profiles for semantic searches. */
export type { BaseCache, SemanticCacheOptions } from './utils/cache.js';

/** Token calculation and string clipping methods to fit context window limits. */
export {
  estimateTokens,
  estimateMessagesTokens,
  fitsInContext,
  truncateToFit,
  getContextInfo,
} from './utils/token-counter.js';
/** Type defining the bounds of a model's context window. */
export type { ContextWindow } from './utils/token-counter.js';

/**
 * Cost tracking and budget enforcement. Tracks per-request token costs
 * and enforces configurable budget limits to prevent overspend.
 */
export {
  CostTracker,
  BudgetManager,
  DEFAULT_PRICING_TABLE,
  getModelPricing,
} from './utils/cost.js';
export type { ModelPricing, BudgetOptions } from './utils/cost.js';

export { ModelPricingDB, DEFAULT_MODEL_PRICES, estimateCost } from './cost/model-prices.js';
export type { ModelPrice, PriceSyncFetcher, PriceLookup } from './cost/model-prices.js';

/**
 * Prompt formatting templates (few-shot, templates pipeline, template managers).
 */
export {
  PromptTemplate,
  ChatPromptTemplate,
  FewShotPromptTemplate,
  PipelinePromptTemplate,
  PromptManager,
  renderTemplate,
} from './utils/prompt.js';
/** Types representing chat prompt message templates and few-shot formatting choices. */
export type { ChatMessageTemplate, FewShotPromptOptions } from './utils/prompt.js';

/**
 * 12-Factor Prompts as Code: schema-based parsing, compilation and validation logic.
 */
export { parseYaml } from './prompts/yaml-parser.js';
/** Core prompt validator logic and input/output schema validation checks. */
export { validateInput, validateOutput, PromptValidationError } from './prompts/validator.js';
/** Registry database containing compiled, safe prompt assets. */
export { PromptRegistry } from './prompts/registry.js';
/** Type definitions for YAML prompts, constraints, safety ratings, and validations. */
export type {
  PromptInputType,
  PromptInputSpec,
  PromptConfig,
  PromptLengthValidator,
  PromptFormatValidator,
  PromptSafetyValidator,
  PromptValidator,
  PromptDefinition,
  ValidationResult,
} from './prompts/types.js';

/**
 * Vercel AI SDK wrappers and middleware composer pipelines.
 * Intercepts LLM, embedding, and image generation requests to run audit hooks.
 */
export {
  wrapLanguageModel,
  composeMiddlewares,
  wrapEmbeddingModel,
  wrapImageModel,
  wrapProvider,
} from './utils/middleware.js';
/** Types representing middleware callback signatures for chat and embeddings. */
export type {
  ChatMiddleware,
  ChatStreamMiddleware,
  EmbeddingMiddleware,
  EmbeddingManyMiddleware,
  ImageMiddleware,
  IProviderMiddlewares,
} from './utils/middleware.js';

/** Universal model adapter route that translates request schemas into provider formats. */
export { UniversalChatModel } from './utils/universal.js';
/** Options configuring universal model adaptations. */
export type { UniversalChatModelOptions } from './utils/universal.js';

/** Unified multi-provider router coordinating latency routing and latency tracking. */
export { UnifiedRouter } from './router/unifiedRouter.js';
/** Options configuring the UnifiedRouter and latency measurements. */
export type { UnifiedRouterOptions, LatencyMetric } from './router/unifiedRouter.js';

/**
 * Adaptive router selecting LLM complexity tiers dynamically based on task analysis.
 */
export { AdaptiveRouter } from './router/adaptive.js';
/** Types defining complexity tiers, score weights, and model capabilities. */
export type {
  AdaptiveRouterConfig,
  ComplexityTier,
  ComplexityAnalysis,
  ComplexityFactors,
  ModelClass,
} from './router/adaptive.js';

/** Recommendation logic pointing tasks to the best candidate provider model. */
export { ProviderRecommendationSystem } from './router/recommend.js';
/** Types representing task categories, confidence recommendations, and settings. */
export type {
  TaskType,
  ProviderRecommendation,
  RecommendationResult,
  RecommendationConfig,
} from './router/recommend.js';

/** Fallback router maintaining circuit breakers for failed LLM providers. */
export { DynamicFallbackRouter } from './router/fallback.js';
/** Types representing recovery attempts, fallback paths, and circuit-breaker thresholds. */
export type {
  DynamicFallbackConfig,
  FallbackTarget,
  FallbackResult,
  AttemptRecord,
  CircuitState,
  CircuitBreakerStatus,
  CircuitBreakerConfig,
  RetryPolicy,
} from './router/fallback.js';

/** Budget and failover manager handling model fallback execution and request token pricing. */
export { FallbackManager, MODEL_PRICING } from './gateway/fallbackManager.js';
/** Types representing billing config limits and aggregated cost trace records. */
export type { BudgetConfig, CostRecord } from './gateway/fallbackManager.js';

/** Output parsers that transform raw LLM responses into structured data formats. */
export {
  JSONOutputParser,
  XMLOutputParser,
  ListOutputParser,
  StructuredOutputParser,
} from './utils/parsers.js';
/** Abstract base class defining structural parser interfaces. */
export type { BaseOutputParser } from './utils/parsers.js';

/**
 * Enterprise features: security scanning, SSO/auth coordination, rate limiting, and observability.
 */
export {
  /** Manager regulating API key status, creation, and metadata mappings. */
  APIKeyManager,
  /** Controller checking user request velocities against configured tier restrictions. */
  RateLimiter,
  /** Default rate-limit boundaries for free, developer, and team groups. */
  DEFAULT_RATE_LIMIT_TIERS,
  /** Manager validating single sign-on tokens and fetching user session states. */
  SSOManager,
  /** Controller managing team structures, memberships, and project workspaces. */
  TeamManager,
  /** Filter reviewing inputs/outputs for hazardous prompts, hate speech, or harassment. */
  ContentFilter,
  /** Detector identifying PII (emails, phones, credentials) inside conversation records. */
  PIIDetector,
  /** Assessor comparing model outputs against customized criteria and scoring rubrics. */
  LLMJudge,
  /** Reference evaluation guidelines for LLM-as-a-Judge test suites. */
  DEFAULT_JUDGE_RULES,
  /** Scanner checking text buffers for API keys, secret strings, and SSH private keys. */
  SecretDetector,
  /** Logger writing tamper-proof trails of client events and administrative changes. */
  AuditLogger,
  /** Telemetry exporter aggregating traces and spans for operational debugging. */
  ObservabilityManager,
  /** Router propagating system failures and budget limits to alert streams. */
  AlertingManager,
  /** Helper creating alert rules for budget exceeded conditions. */
  createBudgetAlertRule,
  /** Helper creating alert rules for elevated error thresholds. */
  createErrorRateAlertRule,
  /** Helper creating alert rules for high-latency spans. */
  createLatencyAlertRule,
  /** Helper creating alert rules for safety breaches. */
  createSecurityAlertRule,
} from './enterprise/index.js';

export type {
  // Auth types
  AuthMethod,
  APIKeyConfig,
  APIKeyEntry,
  AuthScope,
  JWTClaims,
  AuthResult,
  AuthMiddlewareOptions,
  // Rate Limiting types
  RateLimitScope,
  RateLimitConfig,
  RateLimitState,
  RateLimitResult,
  RateLimitTier,
  // SSO types
  SSOProvider,
  SSOConfig,
  SSOTokenResponse,
  SSOUserInfo,
  SSOState,
  // Teams types
  TeamRole,
  ProjectStatus,
  Team,
  TeamMember,
  Project,
  User,
  Invitation,
  // Content Filter types
  FilterAction,
  ContentDirection,
  ContentCategory,
  ContentFilterRule,
  ContentFilterResult,
  ModerationResult,
  // PII types
  PIIType,
  PIIAction,
  PIIDetectionResult,
  PIIFinding,
  PIIConfig,
  // LLM Judge types
  JudgeTask,
  JudgeConfig,
  JudgeResult,
  JudgeRule,
  // Secret Detection types
  SecretType,
  SecretProvider,
  SecretFinding,
  SecretDetectionResult,
  SecretPattern,
  // Audit types
  AuditAction,
  AuditSeverity,
  AuditEvent,
  AuditQuery,
  AuditConfig,
  AuditStats,
  // Observability types
  ObservabilityProvider,
  TraceSpan,
  TraceEvent,
  Trace,
  LLMCallMetrics,
  ObservabilityConfig,
  // Alerting types
  AlertChannel,
  AlertCategory,
  AlertRule,
  AlertContext,
  Alert,
  SlackConfig,
  EmailConfig,
  PagerDutyConfig,
  WebhookConfig,
  AlertingConfig,
} from './enterprise/index.js';

export {
  AntiSlopFilter,
  createAntiSlopStreamMiddleware,
  createAntiSlopMiddleware,
  cleanSlop,
} from './middleware/antiSlop.js';
/** Options configuring the AntiSlopFilter. */
export type { AntiSlopConfig } from './middleware/antiSlop.js';

/** Guardrails middleware implementing token, content, rate-limit, and audit interceptors. */
export {
  createContentFilterMiddleware,
  createPIIDetectorMiddleware,
  createPIIDetectorStreamMiddleware,
  createSecretDetectorMiddleware,
  createRateLimiterMiddleware,
  createAuditLoggerMiddleware,
  createGuardrailsMiddlewares,
} from './middleware/guardrails.js';
/** Types representing configuration specifications for security guardrails. */
export type {
  GuardrailsConfig,
  ContentFilterConfig,
  PIIDetectorConfig,
  SecretDetectorConfig,
  RateLimiterConfig,
  AuditLoggerConfig,
  AuditEntry,
} from './middleware/guardrails.js';

/** SCTI: Self-Correcting Trajectory Injection for automatic crash recovery in agent flows. */
export {
  SCTIEngine,
  injectSctiTrajectories,
  createSctiMiddleware,
  createSctiStreamMiddleware,
  extractErrorCode,
  getJaccardSimilarity,
  compressDiff,
} from './middleware/sctiCalibrator.js';
/** Type definition for structured SCTI agent trajectories. */
export type { SCTITrajectory } from './middleware/sctiCalibrator.js';

/** Fine-tuning supervisor handling model tuning uploads, datasets, and status events. */
export { FineTuningManager } from './platform/fine-tuning.js';
/** Workspace controllers handling batch requests and file storage uploads. */
export { FilesManager, BatchesManager } from './platform/files-batches.js';
/** SSE and HTTP proxy translating local model streams for external telemetry relays. */
export { RealtimeProxy } from './platform/realtime.js';
/** Model accuracy evaluator and integrated web testing clients. */
export { LLMEvaluator, IntegratedSearchClient } from './platform/evals.js';
/** Result structure containing test scores and evaluation metrics. */
export type { EvalResult } from './platform/evals.js';
/** Express-based local proxy server for central API routing and cost enforcement. */
export { AIGatewayServer } from './platform/gateway.js';
/** Configurations controlling AI gateway behaviors. */
export type { GatewayConfig } from './platform/gateway.js';
/** OCR text and video analyzer parsing visual payloads during computer use tasks. */
export { OCRProcessor, VideoContentAnalyzer } from './platform/ocr-video.js';
/** Controller organizing telemetry reporting and workspace dashboard stats. */
export { DashboardController } from './platform/dashboard-controller.js';
/** Interface representing dashboard performance statistics. */
export type { DashboardStats } from './platform/dashboard-controller.js';
/** @deprecated Unused export. Reserved for future deployment config generation. */
export { DeployConfigGenerator } from './platform/prometheus.js';

/** Memory caching systems with local LRU, embedding deduplication, and pre-warming. */
export { LRUCache, SemanticDedup, CacheWarmer, ResponseCacheEngine } from './cache/index.js';

export { DistributedCache, ObjectStoreCache, DualModeCache } from './cache/distributed.js';
export type { ObjectStore, DualCacheOptions } from './cache/distributed.js';

export { ToolApprovalManager, canExecute } from './tool-calling/approvals.js';
export type {
  ApprovalDecision,
  SessionDefault,
  PendingToolCall,
  ApprovalRequest,
  ToolApprovalManagerOptions,
} from './tool-calling/approvals.js';
export {
  parseToolArguments,
  repairToolCallArguments,
  isRetryableRepair,
} from './tool-calling/repair.js';
export type { ToolArgSchema, RepairResult } from './tool-calling/repair.js';
/** Type definitions for response cache options, warm sources, and stats counters. */
export type {
  CacheEntry,
  EvictionPolicy,
  CacheInvalidationEvent,
  CacheEventListener,
  LRUCacheConfig,
  SemanticDedupConfig,
  CacheWarmerConfig,
  ResponseCacheConfig,
  CacheStats,
  EmbeddingProvider,
  WarmSource,
} from './cache/index.js';

/** Factory dynamically instantiating and configuring StdIO or SSE MCP servers. */
export { MCPServersFactory } from './mcp/servers.js';

/** GUI control, action spaces, and status variables for screen control agents. */
export * from './gui-agent/index.js';

/** Request batching logic for combining multiple model requests. */
export * from './batch/index.js';

/** Provider load balancing logic with round-robin and performance routing rules. */
export * from './loadbalancer/index.js';

// --- OpenClaude, LiteLLM & Claude Code Integration (v0.2.5) ---
export {
  QueryEngine,
  type CompactionConfig,
  type CompactionResult,
} from './compact/query-engine.js';
export { LiteLLMGateway, type ProviderKeyPair } from './gateway/litellm-gateway.js';
export { ClaudeCodeTerminalLoop, type TerminalFramingConfig } from './claude-code/terminal-loop.js';

export {
  AdaptiveReasoningController,
  type ReasoningBudgetRequest,
  type ReasoningBudgetResult,
} from './context/reasoning-budget.js';
export {
  MultiEnginePipeline,
  type PipelineSelectOptions,
  type PipelineModelSelection,
  type DynamicFallbackOptions,
} from './routing/multi-engine-pipeline.js';
export { repairIncompleteJson, accumulateToolStream } from './tool-calling/repair.js';
