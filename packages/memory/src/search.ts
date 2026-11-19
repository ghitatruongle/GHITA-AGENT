// Provides cross-session search with:
// - Inverted index for fast keyword lookup
// - TF-IDF scoring with time-decay
// - Optional semantic vector similarity integration
// - Merged hybrid results (keyword + vector)
// - Session metadata filtering
// - Configurable scoring weights

// Types

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface SessionRecord {
  sessionId: string;
  startTime: number;
  endTime: number;
  messages: SessionMessage[];
  summary?: string;
  metadata?: Record<string, unknown>;
  /** Optional embedding vector for the session (used in semantic search) */
  vector?: number[];
}

export interface CrossSessionResult {
  sessionId: string;
  matches: Array<{
    message: SessionMessage;
    score: number;
    context: string;
  }>;
  sessionSummary?: string;
  overallScore: number;
}

export interface SearchConfig {
  /** Maximum sessions to store (default: 1000) */
  maxSessions?: number;
  /** Weight for keyword score (default: 0.6) */
  keywordWeight?: number;
  /** Weight for semantic vector score (default: 0.4) */
  semanticWeight?: number;
  /** Half-life in days for time-decay recency bonus (default: 30) */
  recencyHalfLifeDays?: number;
  /** Minimum score threshold (default: 0.1) */
  minScore?: number;
  /** Default result limit (default: 5) */
  defaultLimit?: number;
}

export interface EnhancedSearchResult {
  sessionId: string;
  matches: Array<{
    message: SessionMessage;
    keywordScore: number;
    vectorScore: number;
    combinedScore: number;
    context: string;
  }>;
  sessionSummary?: string;
  overallScore: number;
  /** Source of the match: keyword, vector, or hybrid */
  source: 'keyword' | 'vector' | 'hybrid';
}

export interface SessionSearchOptions {
  limit?: number;
  minScore?: number;
  sessionType?: string;
  /** Optional query vector for semantic search */
  queryVector?: number[];
  /** Override keyword weight for this search */
  keywordWeight?: number;
  /** Override semantic weight for this search */
  semanticWeight?: number;
  /** Date range filter */
  afterDate?: number;
  beforeDate?: number;
}

const TOKEN_PATTERN = /[\p{L}\p{N}_-]+/gu;

// Optional Rust NAPI cosine similarity (lazy-loaded once)

import { cosineSimilarityJS, getNativeCosine } from './semantic/rustAddon.js';

// Optional durable vec0 index (v0.0.2-preview T4) — null khi addon vắng.
import { getVecStore, getVecDim, type VecStoreApi } from './hybrid-native.js';

export class CrossSessionSearch {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly index = new Map<string, Set<string>>();
  private readonly sessionTokens = new Map<string, Set<string>>();
  private readonly config: Required<SearchConfig>;
  private readonly vecIndex: VecStoreApi | null;

  constructor(maxSessionsOrConfig?: number | SearchConfig) {
    const cfg =
      typeof maxSessionsOrConfig === 'number'
        ? { maxSessions: maxSessionsOrConfig }
        : maxSessionsOrConfig;

    this.config = {
      maxSessions: cfg?.maxSessions ?? 1000,
      keywordWeight: cfg?.keywordWeight ?? 0.6,
      semanticWeight: cfg?.semanticWeight ?? 0.4,
      recencyHalfLifeDays: cfg?.recencyHalfLifeDays ?? 30,
      minScore: cfg?.minScore ?? 0.1,
      defaultLimit: cfg?.defaultLimit ?? 5,
    };
    this.vecIndex = getVecStore();
  }

  indexSession(session: SessionRecord): void {
    if (this.sessions.size >= this.config.maxSessions && !this.sessions.has(session.sessionId)) {
      const oldestId = [...this.sessions.values()].sort((a, b) => a.startTime - b.startTime)[0]
        ?.sessionId;
      if (oldestId) this.removeSession(oldestId);
    }

    this.sessions.set(session.sessionId, session);

    // Durable vec0 index (best-effort, native-optional): index session summary.
    // Vector lệch dim (env GHITA_MEMORY_VEC_DIM, default 1536) bị bỏ qua —
    // INSERT sai dim sẽ lỗi vec0 và bị nuốt im lặng (bug F6 review).
    if (this.vecIndex && session.vector && session.vector.length === getVecDim()) {
      try {
        this.vecIndex.vecStore(
          session.sessionId,
          session.summary ?? session.messages[0]?.content ?? session.sessionId,
          new Float32Array(session.vector),
          JSON.stringify({ startTime: session.startTime, endTime: session.endTime }),
        );
      } catch {
        // native index best-effort — JS cosine fallback vẫn đầy đủ.
      }
    }

    const tokens = new Set<string>();

    // Index all tokens in messages
    for (const msg of session.messages) {
      const msgTokens = this.tokenize(msg.content);
      for (const token of msgTokens) {
        tokens.add(token);
        let set = this.index.get(token);
        if (!set) {
          set = new Set<string>();
          this.index.set(token, set);
        }
        set.add(session.sessionId);
      }
    }

    // Index summary if available
    if (session.summary) {
      const summaryTokens = this.tokenize(session.summary);
      for (const token of summaryTokens) {
        tokens.add(token);
        let set = this.index.get(token);
        if (!set) {
          set = new Set<string>();
          this.index.set(token, set);
        }
        set.add(session.sessionId);
      }
    }

    this.sessionTokens.set(session.sessionId, tokens);
  }

  removeSession(sessionId: string): boolean {
    const removed = this.sessions.delete(sessionId);
    if (!removed) return false;

    // Durable vec0 index: dọn entry để session bị evict không thành phantom
    // hit (bug F7 review) — best-effort, lỗi nuốt im lặng.
    if (this.vecIndex) {
      try {
        this.vecIndex.vecDelete(sessionId);
      } catch {
        // native index best-effort.
      }
    }

    const tokens = this.sessionTokens.get(sessionId);
    if (tokens) {
      for (const token of tokens) {
        const set = this.index.get(token);
        if (set) {
          set.delete(sessionId);
          if (set.size === 0) {
            this.index.delete(token);
          }
        }
      }
      this.sessionTokens.delete(sessionId);
    }
    return true;
  }

  searchAcrossSessions(query: string, options: SessionSearchOptions = {}): CrossSessionResult[] {
    const queryTokens = this.tokenize(query);
    const limit = options.limit ?? this.config.defaultLimit;
    const minScore = options.minScore ?? this.config.minScore;

    if (queryTokens.size === 0) return [];

    const candidateSessionIds = new Set<string>();
    for (const token of queryTokens) {
      const set = this.index.get(token);
      if (set) for (const id of set) candidateSessionIds.add(id);
    }

    // Also include sessions matching by vector if queryVector provided.
    // Durable vec0 index (native) preferred — JS cosine per-session fallback.
    const vecScores = new Map<string, number>();
    if (options.queryVector) {
      if (this.vecIndex) {
        try {
          for (const hit of this.vecIndex.vecSearch(new Float32Array(options.queryVector), limit)) {
            vecScores.set(hit.id, hit.score);
            if (hit.score >= minScore) candidateSessionIds.add(hit.id);
          }
        } catch {
          // native index best-effort — fallback dưới đây vẫn chạy.
        }
      }
      if (vecScores.size === 0) {
        for (const [id, session] of this.sessions) {
          if (session.vector) {
            const vs = this.cosine(options.queryVector, session.vector);
            if (vs >= minScore) candidateSessionIds.add(id);
            vecScores.set(id, vs);
          }
        }
      }
    }

    const kwWeight = options.keywordWeight ?? this.config.keywordWeight;
    const vecWeight = options.semanticWeight ?? this.config.semanticWeight;
    const results: CrossSessionResult[] = [];

    for (const sessionId of candidateSessionIds) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;

      if (options.sessionType && session.metadata?.type !== options.sessionType) continue;
      if (options.afterDate && session.endTime < options.afterDate) continue;
      if (options.beforeDate && session.startTime > options.beforeDate) continue;

      const matches: CrossSessionResult['matches'] = [];
      let maxMsgScore = 0;

      // Session-level vector score — prefer the durable vec0 hit when present.
      const sessionVecScore = vecScores.get(sessionId)
        ?? (options.queryVector && session.vector
          ? this.cosine(options.queryVector, session.vector)
          : 0);

      for (const msg of session.messages) {
        const msgTokens = this.tokenize(msg.content);
        if (msgTokens.size === 0) continue;

        let intersection = 0;
        for (const token of queryTokens) {
          if (msgTokens.has(token)) intersection++;
        }
        const keywordScore = queryTokens.size > 0 ? intersection / queryTokens.size : 0;

        // Combined score with configurable weights
        const combinedScore = kwWeight * keywordScore + vecWeight * sessionVecScore;

        if (combinedScore >= minScore) {
          const context = this.extractContext(msg.content, queryTokens);
          matches.push({ message: msg, score: combinedScore, context });
          if (combinedScore > maxMsgScore) maxMsgScore = combinedScore;
        }
      }

      if (matches.length > 0) {
        const ageMs = Date.now() - session.endTime;
        const halfLife = this.config.recencyHalfLifeDays;
        const recencyBonus = 0.1 * Math.pow(0.5, ageMs / 86_400_000 / halfLife);
        const overallScore = Math.min(1.0, maxMsgScore + recencyBonus);

        results.push({
          sessionId,
          matches: matches.sort((a, b) => b.score - a.score),
          sessionSummary: session.summary,
          overallScore,
        });
      }
    }

    return results.sort((a, b) => b.overallScore - a.overallScore).slice(0, limit);
  }

  /** Enhanced search returning detailed keyword + vector breakdown */
  searchEnhanced(query: string, options: SessionSearchOptions = {}): EnhancedSearchResult[] {
    const queryTokens = this.tokenize(query);
    const limit = options.limit ?? this.config.defaultLimit;
    const minScore = options.minScore ?? this.config.minScore;
    if (queryTokens.size === 0) return [];

    const kwWeight = options.keywordWeight ?? this.config.keywordWeight;
    const vecWeight = options.semanticWeight ?? this.config.semanticWeight;
    const results: EnhancedSearchResult[] = [];

    for (const [sessionId, session] of this.sessions) {
      if (options.sessionType && session.metadata?.type !== options.sessionType) continue;
      if (options.afterDate && session.endTime < options.afterDate) continue;
      if (options.beforeDate && session.startTime > options.beforeDate) continue;

      const sessionVecScore =
        options.queryVector && session.vector
          ? this.cosine(options.queryVector, session.vector)
          : 0;

      const matches: EnhancedSearchResult['matches'] = [];
      let maxCombined = 0;

      for (const msg of session.messages) {
        const msgTokens = this.tokenize(msg.content);
        if (msgTokens.size === 0) continue;

        let intersection = 0;
        for (const token of queryTokens) if (msgTokens.has(token)) intersection++;
        const keywordScore = queryTokens.size > 0 ? intersection / queryTokens.size : 0;
        const vectorScore = sessionVecScore;
        const combinedScore = kwWeight * keywordScore + vecWeight * vectorScore;

        if (combinedScore >= minScore) {
          const context = this.extractContext(msg.content, queryTokens);
          matches.push({ message: msg, keywordScore, vectorScore, combinedScore, context });
          if (combinedScore > maxCombined) maxCombined = combinedScore;
        }
      }

      if (matches.length > 0) {
        const ageMs = Date.now() - session.endTime;
        const halfLife = this.config.recencyHalfLifeDays;
        const recencyBonus = 0.1 * Math.pow(0.5, ageMs / 86_400_000 / halfLife);
        const overallScore = Math.min(1.0, maxCombined + recencyBonus);

        const source: EnhancedSearchResult['source'] = options.queryVector ? 'hybrid' : 'keyword';

        results.push({
          sessionId,
          matches: matches.sort((a, b) => b.combinedScore - a.combinedScore),
          sessionSummary: session.summary,
          overallScore,
          source,
        });
      }
    }

    return results.sort((a, b) => b.overallScore - a.overallScore).slice(0, limit);
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  getConfig(): Readonly<Required<SearchConfig>> {
    return { ...this.config };
  }

  summarizeResults(results: CrossSessionResult[], maxChars = 2000): string {
    if (results.length === 0) return '';

    const lines = ['=== LỊCH SỬ PHIÊN HỘI THOẠI TRƯỚC ĐÓ ==='];

    for (const res of results) {
      lines.push(`\n[Phiên ID: ${res.sessionId}]`);
      if (res.sessionSummary) {
        lines.push(`Tóm tắt phiên: ${res.sessionSummary}`);
      }

      lines.push('Đoạn hội thoại liên quan:');
      for (const match of res.matches.slice(0, 2)) {
        
        const roleName = match.message.role === 'user' ? 'Người dùng' : 'AI';
        lines.push(
          `  - ${roleName}: "${match.context}" (Độ trùng khớp: ${Math.round(match.score * 100)}%)`,
        );
      }
    }

    const output = lines.join('\n');
    return output.length > maxChars
      ? `${output.slice(0, maxChars)  }...\n[Cắt bớt do quá dài]`
      : output;
  }

  clear(): void {
    this.sessions.clear();
    this.index.clear();
    this.sessionTokens.clear();
  }

  // Private Helpers
  
  private cosine(a: number[], b: number[]): number {
    // Prefer the SIMD native implementation; fall back to pure JS when the
    // memory addon is unavailable.
    return getNativeCosine()?.(a, b) ?? cosineSimilarityJS(a, b);
  }

  private tokenize(text: string): Set<string> {
    const matches = text.toLowerCase().match(TOKEN_PATTERN) ?? [];
    return new Set(matches.filter((token) => token.length > 1));
  }

  private extractContext(content: string, queryTokens: Set<string>, windowChars = 100): string {
    const contentLower = content.toLowerCase();
    let bestIndex = 0;
    let maxMatches = 0;

    for (let i = 0; i < content.length; i += 20) {
      const slice = contentLower.slice(i, i + windowChars);
      let matches = 0;
      for (const token of queryTokens) {
        if (slice.includes(token)) matches++;
      }
      if (matches > maxMatches) {
        maxMatches = matches;
        bestIndex = i;
      }
    }

    const start = Math.max(0, bestIndex - 20);
    const end = Math.min(content.length, bestIndex + windowChars + 20);

    let snippet = content.slice(start, end);
    if (start > 0) snippet = `...${  snippet}`;
    if (end < content.length) snippet = `${snippet  }...`;

    return snippet.trim().replace(/\s+/g, ' ');
  }
}
