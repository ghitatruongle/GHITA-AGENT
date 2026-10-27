import type { MemoryEntry, MemorySearchResult } from '@ghita/shared';
import { CrossSessionSearch } from './search.js';
import type { SessionRecord, CrossSessionResult } from './search.js';
import { MemoryNudgeEngine } from './nudge.js';
import type { NudgeSuggestion, NudgeConfig } from './nudge.js';
import { TieredMemoryStore } from './tieredStore.js';
import type { TieredMemoryStoreConfig } from './tieredStore.js';

export { KnowledgeEngine } from './knowledge/knowledge.js';
export type {
  KnowledgeDocument,
  KnowledgeChunk,
  KnowledgeSource,
  IngestOptions,
  SearchOptions as KnowledgeSearchOptions,
  KnowledgeSearchResult,
  EmbeddingFunction,
  GraphNode,
  GraphEdge,
  EntityExtractionProvider,
} from './knowledge/types.js';
export {
  KnowledgeGraph,
  EntityRelationExtractor,
  GraphRAGQueryCompiler,
  ContextEnrichedPromptBuilder,
} from './knowledge/graph.js';

export { LLMGuardrail } from './guardrail/guardrail.js';
export type { AuditLogEntry } from './guardrail/guardrail.js';
export type {
  GuardrailAction,
  GuardrailResult,
  GuardrailRule,
  GuardrailContext,
  PIIEntityType,
  LLMJudgeConfig,
  ContentFilterConfig,
  GuardrailConfig,
} from './guardrail/types.js';

export const MEMORY_VERSION = '0.0.0-preview';

export interface RememberInput {
  type: MemoryEntry['type'];
  content: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

export interface MemorySearchOptions {
  limit?: number;
  type?: MemoryEntry['type'];
  metadata?: Record<string, unknown>;
  minScore?: number;
}

export interface ContextInjectionOptions extends MemorySearchOptions {
  header?: string;
  maxCharacters?: number;
}

function generateMemoryId(): string {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class AgentMemory {
  private readonly tieredStore: TieredMemoryStore;
  private readonly sessionSearch: CrossSessionSearch;
  private readonly nudgeEngine: MemoryNudgeEngine;

  constructor(
    initialEntries: MemoryEntry[] = [],
    nudgeConfig?: Partial<NudgeConfig>,
    tieredConfig?: TieredMemoryStoreConfig,
  ) {
    this.tieredStore = new TieredMemoryStore(tieredConfig);
    for (const entry of initialEntries) {
      this.tieredStore.add(entry);
    }
    this.sessionSearch = new CrossSessionSearch();
    this.nudgeEngine = new MemoryNudgeEngine(nudgeConfig);
  }

  remember(input: RememberInput): MemoryEntry {
    const entry: MemoryEntry = {
      id: generateMemoryId(),
      type: input.type,
      content: input.content,
      metadata: input.metadata,
      timestamp: input.timestamp ?? Date.now(),
    };

    this.tieredStore.add(entry);
    return entry;
  }

  add(entry: MemoryEntry): MemoryEntry {
    return this.tieredStore.add(entry);
  }

  get(id: string): MemoryEntry | undefined {
    return this.tieredStore.get(id);
  }

  list(type?: MemoryEntry['type']): MemoryEntry[] {
    return this.tieredStore.list(type);
  }

  forget(id: string): boolean {
    return this.tieredStore.forget(id);
  }

  clear(): void {
    this.tieredStore.clear();
  }

  search(query: string, options: MemorySearchOptions = {}): MemorySearchResult[] {
    return this.tieredStore.search(query, options);
  }

  injectContext(query: string, options: ContextInjectionOptions = {}): string {
    const header = options.header ?? 'Relevant memory';
    const maxCharacters = options.maxCharacters ?? 3000;
    const memories = this.search(query, options);
    if (memories.length === 0) return '';

    const lines = [`${header}:`];
    for (const result of memories) {
      lines.push(`- [${result.entry.type}] ${result.entry.content}`);
    }

    const context = lines.join('\n');
    return context.length > maxCharacters ? `${context.slice(0, maxCharacters)}...` : context;
  }

  indexSession(session: SessionRecord): void {
    this.sessionSearch.indexSession(session);
  }

  searchAcrossSessions(
    query: string,
    options?: { limit?: number; minScore?: number; sessionType?: string },
  ): CrossSessionResult[] {
    return this.sessionSearch.searchAcrossSessions(query, options);
  }

  analyzeForNudges(messages: Array<{ role: string; content: string }>): NudgeSuggestion[] {
    return this.nudgeEngine.analyzeForNudges(messages);
  }

  autoSaveNudges(messages: Array<{ role: string; content: string }>): MemoryEntry[] {
    const nudges = this.analyzeForNudges(messages);
    const saved: MemoryEntry[] = [];
    for (const nudge of nudges) {
      if (this.nudgeEngine.shouldAutoSave(nudge)) {
        const entry = this.nudgeEngine.toMemoryEntry(nudge);
        this.add(entry);
        saved.push(entry);
      }
    }
    return saved;
  }

  toJSON(): MemoryEntry[] {
    return this.list();
  }

  close(): void {
    this.tieredStore.close();
  }

  static fromJSON(entries: MemoryEntry[]): AgentMemory {
    return new AgentMemory(entries);
  }
}

export { TieredMemoryStore } from './tieredStore.js';
export type { TieredMemoryStoreConfig } from './tieredStore.js';

// v0.4.9 A9: Memory decay & reinforcement
export {
  decayStrength,
  reinforceStrength,
  effectiveStrength,
  reinforceMetadata,
  DEFAULT_HALF_LIFE_MS,
  DEFAULT_REINFORCE_GAIN,
} from './reinforcement.js';
export type { ReinforcementOptions } from './reinforcement.js';

export { CrossSessionSearch } from './search.js';
export type {
  SessionRecord,
  SessionMessage,
  CrossSessionResult,
  SearchConfig,
  EnhancedSearchResult,
  SessionSearchOptions,
} from './search.js';
export { MemoryNudgeEngine } from './nudge.js';
export type { NudgeSuggestion, NudgeConfig, NudgePattern } from './nudge.js';

export { RustMemoryAddon, cosineSimilarityJS } from './semantic/rustAddon.js';
export type {
  ChatLogEntry,
  CacheEntry,
  RustAddonConfig,
  VectorEntry,
  SemanticSearchResult,
  HybridSearchResult,
  AddonStats,
} from './semantic/rustAddon.js';

export { MemoryCompactor } from './semantic/compact.js';
export type {
  CompactableEntry,
  CompactConfig,
  CompactResult,
  ImportanceScore,
  SessionSummary,
  CompactSchedule,
} from './semantic/compact.js';

export {
  calculateDecayScore,
  getNamespaceOverview,
  getTimeline,
  retrieveEnhanced,
  MemoryFreshnessTracker,
} from './freshness.js';

export { createMemoryMCPServer } from './mcp-server.js';
export type { MemoryLike, MemoryMCPServerConfig } from './mcp-server.js';
export type {
  NamespaceFreshness,
  FreshnessTrackerOptions,
  TimelineOptions,
  MultiSignalRetrievalOptions,
} from './freshness.js';

export * from './compression/index.js';

export * from './track6/index.js';
