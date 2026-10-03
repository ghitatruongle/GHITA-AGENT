// Quota & Rate Limiting Dashboard

import { useState, useCallback } from 'react';
import { RateLimiter } from '../../../../packages/quotas/src/index.js';
import { UsageTracker } from '../../../../packages/quotas/src/index.js';
import { BudgetManager } from '../../../../packages/ai-engine/src/index.js';
import { useActivePolling } from '../hooks/useActivePolling';
import type {
  RateLimit,
  UsageRecord,
  UsageSummary,
} from '../../../../packages/quotas/src/index.js';
import { useTranslation } from '../i18n';

let _limiter: RateLimiter | null = null;
let _tracker: UsageTracker | null = null;
let _budget: BudgetManager | null = null;

function getLimiter(): RateLimiter {
  if (!_limiter) {
    _limiter = new RateLimiter();
    _limiter.registerLimit({
      id: 'chat-default',
      window: 'minute',
      limit: 60,
      scope: 'requests',
    });
    _limiter.registerLimit({
      id: 'chat-hourly',
      window: 'hour',
      limit: 1000,
      scope: 'requests',
    });
  }
  return _limiter;
}

function getTracker(): UsageTracker {
  if (!_tracker) {
    // v0.8.0: no seeded/fake sample data. The quota gauge and usage table must
    // reflect real usage only; an empty (zero) state is honest until the
    // telemetry hook-up records actual provider calls.
    _tracker = new UsageTracker();
  }
  return _tracker;
}

function getBudget(): BudgetManager {
  if (!_budget) {
    _budget = new BudgetManager({ limit: 100, period: 'monthly' });
  }
  return _budget;
}

interface QuotaSnapshot {
  limits: RateLimit[];
  usage: UsageRecord[];
  summary: UsageSummary[];
  spent: number;
  limit: number;
}

export function QuotaView() {
  const { t } = useTranslation();
  const [snap, setSnap] = useState<QuotaSnapshot>({
    limits: [],
    usage: [],
    summary: [],
    spent: 0,
    limit: 0,
  });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    const limiter = getLimiter();
    const tracker = getTracker();
    const budget = getBudget();

    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const usage = tracker.query('local', dayAgo, now);
    const summary: UsageSummary = tracker.summary('local', dayAgo, now);

    setSnap({
      limits: limiter.listLimits(),
      usage: usage.slice(-50),
      // `summary` là MỘT object, bọc vào mảng làm `summary.length` luôn = 1,
      // nên nhánh "chưa có dữ liệu" ở dưới không bao giờ chạy.
      summary: summary.totalRequests > 0 ? [summary] : [],
      spent: budget.getCurrentSpent(),
      limit: budget.getLimit(),
    });
    setLoading(false);
  }, []);

  // useActivePolling fires immediately on mount (when eligible) and then keeps
  // polling only while the app window is visible (no background polling).
  useActivePolling(10_000, refresh, 'quota');

  const pct = snap.limit > 0 ? Math.min(100, (snap.spent / snap.limit) * 100) : 0;
  const remaining = Math.max(0, snap.limit - snap.spent);
  const gaugeColor = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#10b981';

  if (loading) {
    return (
      <div style={{ padding: '24px', color: 'var(--text-secondary)' }}>{t('quota.loading')}</div>
    );
  }

  return (
    <div style={{ padding: '24px', maxWidth: '1000px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '24px', margin: '0 0 24px' }}>{t('quota.title')}</h1>

      {/* Budget gauge */}
      <section
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '8px',
          padding: '24px',
          marginBottom: '32px',
        }}
      >
        <h2 style={{ fontSize: '16px', margin: '0 0 16px' }}>{t('quota.monthlyBudget')}</h2>

        <div
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          aria-label={t('quota.budgetUsage')}
          style={{
            width: '100%',
            height: '20px',
            background: 'rgba(255,255,255,0.06)',
            borderRadius: '10px',
            overflow: 'hidden',
            marginBottom: '12px',
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              background: gaugeColor,
              transition: 'width 0.3s ease',
            }}
          />
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '13px',
          }}
        >
          <span>
            <strong>{t('quota.spent')}:</strong> ${snap.spent.toFixed(4)}
          </span>
          <span>
            <strong>{t('quota.cap')}:</strong> ${snap.limit.toFixed(2)}
          </span>
          <span>
            <strong>{t('quota.remaining')}:</strong> ${remaining.toFixed(4)}
          </span>
        </div>
      </section>

      {/* Rate limits */}
      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '16px', margin: '0 0 12px', color: 'var(--text-secondary)' }}>
          {t('quota.activeRateLimits')}
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '12px',
          }}
        >
          {snap.limits.length === 0 ? (
            <div
              style={{
                padding: '16px',
                color: 'var(--text-muted)',
                background: 'var(--bg-secondary)',
                border: '1px dashed var(--border-subtle)',
                borderRadius: '6px',
              }}
            >
              {t('quota.noRateLimits')}
            </div>
          ) : (
            snap.limits.map((l) => (
              <div
                key={l.id}
                style={{
                  padding: '12px 16px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '6px',
                }}
              >
                <strong style={{ fontSize: '13px' }}>{l.id}</strong>
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '4px 0' }}>
                  {t('quota.rateLimitRequests', { limit: l.limit, window: l.window })}
                </p>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Usage summary by model */}
      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '16px', margin: '0 0 12px', color: 'var(--text-secondary)' }}>
          {t('quota.usageByModel')}
        </h2>
        {snap.summary.length === 0 ? (
          <Empty msg={t('quota.noUsage24h')} />
        ) : (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '12px',
            }}
          >
            <thead>
              <tr>
                <th style={th}>{t('quota.period')}</th>
                <th style={th}>{t('quota.totalRequests')}</th>
                <th style={th}>{t('quota.totalTokens')}</th>
                <th style={th}>{t('quota.totalCost')}</th>
              </tr>
            </thead>
            <tbody>
              {snap.summary.map((s, i) => (
                <tr key={i}>
                  <td style={td}>
                    {new Date(s.periodStart).toLocaleTimeString()} —{' '}
                    {new Date(s.periodEnd).toLocaleTimeString()}
                  </td>
                  <td style={td}>{s.totalRequests.toLocaleString()}</td>
                  <td style={td}>{s.totalTokens.toLocaleString()}</td>
                  <td style={td}>${s.totalCost.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Recent usage log */}
      <section>
        <h2 style={{ fontSize: '16px', margin: '0 0 12px', color: 'var(--text-secondary)' }}>
          {t('quota.recentUsage')}
        </h2>
        {snap.usage.length === 0 ? (
          <Empty msg={t('quota.noRecentUsage')} />
        ) : (
          <div
            style={{
              maxHeight: '300px',
              overflowY: 'auto',
              fontSize: '11px',
              fontFamily: 'monospace',
            }}
          >
            {snap.usage.slice(-30).map((r, i) => (
              <div
                key={i}
                style={{
                  padding: '4px 8px',
                  borderBottom: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)',
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <span>
                  {new Date(r.timestamp).toLocaleTimeString()} · {r.provider}/{r.model}
                </span>
                <span>
                  {(r.promptTokens ?? 0) + (r.completionTokens ?? 0)} tok · ${r.costUsd.toFixed(4)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  borderBottom: '1px solid var(--border-subtle)',
  fontSize: '11px',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};
const td: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid var(--border-subtle)',
};

function Empty({ msg }: { msg: string }) {
  return (
    <div
      style={{
        padding: '24px',
        textAlign: 'center',
        color: 'var(--text-muted)',
        background: 'var(--bg-secondary)',
        border: '1px dashed var(--border-subtle)',
        borderRadius: '6px',
      }}
    >
      {msg}
    </div>
  );
}
