import type { KeyRotationStrategy } from './types.js';

export interface KeyEntry {
  key: string;
  isActive: boolean;
  consecutiveFailures: number;
  lastUsedAt: number;
  lastFailureAt: number;
  totalRequests: number;
  totalFailures: number;
  /** Timestamp when key becomes usable again after rate-limit */
  cooldownUntil: number;
}

export interface KeyHealthStatus {
  keyPrefix: string;
  isActive: boolean;
  consecutiveFailures: number;
  lastUsedAt: number;
  totalRequests: number;
  totalFailures: number;
  isCoolingDown: boolean;
}

export interface KeyUsageStats {
  totalKeys: number;
  activeKeys: number;
  coolDownKeys: number;
  strategy: KeyRotationStrategy;
  keyStats: KeyHealthStatus[];
}

const COOLDOWN_429_MS = 60_000; // 60s for rate-limit
const MAX_CONSECUTIVE_FAILURES = 3;

export class KeyManager {
  private keys: KeyEntry[] = [];
  private strategy: KeyRotationStrategy;
  private roundRobinIndex = 0;

  constructor(keys: string[], strategy: KeyRotationStrategy = 'failover') {
    this.strategy = strategy;
    for (const key of keys) {
      if (key && key.trim()) {
        this.keys.push({
          key: key.trim(),
          isActive: true,
          consecutiveFailures: 0,
          lastUsedAt: 0,
          lastFailureAt: 0,
          totalRequests: 0,
          totalFailures: 0,
          cooldownUntil: 0,
        });
      }
    }
  }

  /** Get next healthy key based on rotation strategy.
   *
   * Track S2 (switch-key ladder): when `exclude` is provided, only keys
   * OUTSIDE the set are eligible and cooling-down keys outside the set are
   * considered (earliest expiration first); the call returns null when no
   * non-excluded key exists. Without `exclude` the behavior is unchanged. */
  getNextKey(exclude?: ReadonlySet<string>): string | null {
    const now = Date.now();
    const healthy = this.keys.filter(
      (k) =>
        k.isActive &&
        (k.cooldownUntil === 0 || k.cooldownUntil <= now) &&
        (!exclude || !exclude.has(k.key)),
    );

    if (healthy.length > 0) {
      return this.selectByStrategy(healthy);
    }

    // All eligible keys in cooldown — return the one with earliest expiration
    const coolingDown = this.keys.filter(
      (k) => k.isActive && k.cooldownUntil > now && (!exclude || !exclude.has(k.key)),
    );
    if (coolingDown.length > 0) {
      coolingDown.sort((a, b) => a.cooldownUntil - b.cooldownUntil);
      return coolingDown[0]?.key ?? null;
    }

    // All keys deactivated (or excluded) — return null
    return null;
  }

  /** Report successful use of a key */
  reportSuccess(key: string): void {
    const entry = this.findEntry(key);
    if (!entry) return;
    entry.consecutiveFailures = 0;
    entry.lastUsedAt = Date.now();
    entry.totalRequests++;
    entry.cooldownUntil = 0;
  }

  /** Report failed use of a key */
  reportFailure(key: string, statusCode?: number): void {
    const entry = this.findEntry(key);
    if (!entry) return;

    entry.consecutiveFailures++;
    entry.lastFailureAt = Date.now();
    entry.totalFailures++;
    entry.totalRequests++;

    if (statusCode === 429) {
      // Rate-limited — cooldown with exponential backoff
      const backoff = COOLDOWN_429_MS * Math.pow(2, Math.min(entry.consecutiveFailures - 1, 4));
      entry.cooldownUntil = Date.now() + backoff;
    } else if (statusCode === 401) {
      // Auth error — deactivate until user re-validates
      entry.isActive = false;
    } else if (entry.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      // Consecutive errors (like network timeouts) — place on a 30s cooldown
      // and reset consecutiveFailures count so it can retry later, instead of deactivating.
      entry.cooldownUntil = Date.now() + 30_000;
      entry.consecutiveFailures = 0;
    }
  }

  /** Re-activate a key */
  resetKey(key: string): void {
    const entry = this.findEntry(key);
    if (!entry) return;
    entry.isActive = true;
    entry.consecutiveFailures = 0;
    entry.cooldownUntil = 0;
  }

  /** Add a new key to the pool */
  addKey(key: string): boolean {
    const trimmed = key.trim();
    if (!trimmed || this.keys.some((k) => k.key === trimmed)) return false;
    this.keys.push({
      key: trimmed,
      isActive: true,
      consecutiveFailures: 0,
      lastUsedAt: 0,
      lastFailureAt: 0,
      totalRequests: 0,
      totalFailures: 0,
      cooldownUntil: 0,
    });
    return true;
  }

  /** Remove a key from the pool */
  removeKey(key: string): boolean {
    const idx = this.keys.findIndex((k) => k.key === key);
    if (idx < 0) return false;
    this.keys.splice(idx, 1);
    return true;
  }

  /** Check if at least one key is healthy */
  hasHealthyKey(): boolean {
    const now = Date.now();
    return this.keys.some((k) => k.isActive && (k.cooldownUntil === 0 || k.cooldownUntil <= now));
  }

  /** Get all keys (for passing to provider) */
  getKeys(): string[] {
    return this.keys.map((k) => k.key);
  }

  /** Get health status (masked keys) */
  getHealthStatus(): KeyUsageStats {
    const now = Date.now();
    return {
      totalKeys: this.keys.length,
      activeKeys: this.keys.filter((k) => k.isActive).length,
      coolDownKeys: this.keys.filter((k) => k.isActive && k.cooldownUntil > now).length,
      strategy: this.strategy,
      keyStats: this.keys.map((k) => ({
        keyPrefix: this.maskKey(k.key),
        isActive: k.isActive,
        consecutiveFailures: k.consecutiveFailures,
        lastUsedAt: k.lastUsedAt,
        totalRequests: k.totalRequests,
        totalFailures: k.totalFailures,
        isCoolingDown: k.cooldownUntil > now,
      })),
    };
  }

  /** Get total key count */
  get size(): number {
    return this.keys.length;
  }

  /** Update rotation strategy */
  setStrategy(strategy: KeyRotationStrategy): void {
    this.strategy = strategy;
  }

  // --- Private helpers ---

  private selectByStrategy(pool: KeyEntry[]): string {
    switch (this.strategy) {
      case 'round-robin': {
        // Use stable index based on full key pool size rather than the
        // healthy pool size, so the round-robin index doesn't jump when
        // the healthy pool temporarily shrinks (e.g., a key is marked
        // unhealthy and then recovers).
        const fullLen = this.keys.length || pool.length;
        this.roundRobinIndex = this.roundRobinIndex % fullLen;
        // Find the entry at this index in the full pool, then check
        // if it's in the healthy pool.
        const fullEntry = this.keys[this.roundRobinIndex];
        this.roundRobinIndex++;
        if (fullEntry && pool.some((e) => e.key === fullEntry.key)) {
          return fullEntry.key;
        }
        // If the indexed key is unhealthy, fall back to first healthy
        return pool[0]?.key ?? '';
      }
      case 'random': {
        const idx = Math.floor(Math.random() * pool.length);
        return pool[idx]?.key ?? pool[0]?.key ?? '';
      }
      case 'failover':
      default: {
        // Always return first healthy key (stable ordering)
        return pool[0]?.key ?? '';
      }
    }
  }

  private findEntry(key: string): KeyEntry | undefined {
    return this.keys.find((k) => k.key === key);
  }

  private maskKey(key: string): string {
    if (key.length <= 8) return '\u2022'.repeat(key.length);
    return key.slice(0, 4) + '\u2022'.repeat(Math.min(key.length - 8, 20)) + key.slice(-4);
  }
}
