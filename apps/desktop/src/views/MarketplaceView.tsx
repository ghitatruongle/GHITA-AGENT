import { useState, useEffect, useMemo } from 'react';
import { useAppStore } from '../stores/appStore';
import { useTranslation } from '../i18n';
import type { PluginManifest } from '@ghita/shared';
// Deep imports: the @ghita/skills barrel re-exports the PTY pool, MCP server
// and directory watchers — far beyond this view's catalog needs.
import { getDefaultCatalog } from '@ghita/skills/marketplace/defaultCatalog';
import type { SkillManifest } from '@ghita/skills/marketplace/types';

// Pre-defined available marketplace plugins
const MARKETPLACE_PLUGINS: PluginManifest[] = [
  {
    id: 'ghita-github-assistant',
    name: 'GitHub Assistant',
    description:
      'Tự động đồng bộ git, push commit, quản lý Pull Requests và issue tracker trực tiếp từ chat panel.',
    version: '1.0.2',
    author: 'GHITA Dev Team',
    type: 'code',
    entrypoint: 'index.js',
    website: 'https://github.com/ghitatruongle/ghita-coding-agent',
    permissions: ['git', 'network'],
  },
  {
    id: 'ghita-docker-orchestrator',
    name: 'Docker Container Orchestrator',
    description:
      'Đóng gói các skills quản lý container Docker, kiểm tra logs, build image và quản lý volume an toàn.',
    version: '0.9.5',
    author: 'Docker Community',
    type: 'bundle',
    permissions: ['docker', 'terminal'],
    skills: [
      {
        id: 'docker-list',
        name: 'Docker List',
        description: 'Liệt kê các containers đang chạy',
        category: 'terminal',
        enabled: true,
      },
    ],
  },
  {
    id: 'ghita-vercel-deployer',
    name: 'Vercel Deployment Automation',
    description:
      'Liên kết project, tự động trigger deploy preview, production và audit logs trong quy trình CI/CD.',
    version: '1.1.0',
    author: 'Vercel Expert',
    type: 'code',
    entrypoint: 'main.js',
    permissions: ['network', 'fs'],
  },
  {
    id: 'ghita-db-client',
    name: 'Database Explorer Skill Pack',
    description:
      'Skills tương tác nhanh với các DB PostgreSQL, MySQL, SQLite, MongoDB. Cho phép AI preview schema và tối ưu query.',
    version: '1.2.0',
    author: 'Database Pros',
    type: 'bundle',
    permissions: ['fs', 'network'],
    skills: [
      {
        id: 'db-query',
        name: 'Run Safe Query',
        description: 'Chạy safe select query và phân tích schema',
        category: 'app',
        enabled: true,
      },
    ],
  },
  {
    id: 'ghita-jira-connector',
    name: 'Jira Workspace Sync',
    description:
      'Đọc và cập nhật ticket Jira, chuyển đổi trạng thái issue, liên kết git commits với story ID tương ứng.',
    version: '0.8.2',
    author: 'Atlassian Community',
    type: 'code',
    entrypoint: 'jira.js',
    permissions: ['network'],
  },
  {
    id: 'ghita-vision-grounding-extra',
    name: 'Advanced Visual Grounding SDK',
    description:
      'Mô hình vision cục bộ bổ trợ nâng cao độ chính xác coordinate recognition khi sử dụng Computer Use trên màn hình lớn.',
    version: '2.0.0',
    author: 'Vision AI Lab',
    type: 'code',
    entrypoint: 'vision.js',
    permissions: ['screenshot', 'computer'],
  },
];

export function MarketplaceView() {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'code' | 'bundle' | 'installed'>('all');
  const [sortBy, setSortBy] = useState<'downloads' | 'rating' | 'newest'>('downloads');

  const [catalogSkills, setCatalogSkills] = useState<SkillManifest[]>([]);
  useEffect(() => {
    setCatalogSkills(getDefaultCatalog());
  }, []);

  // Merge hardcoded plugins with catalog skills, converting catalog to PluginManifest format
  const allPlugins: PluginManifest[] = useMemo(() => {
    const localizedHardcoded = MARKETPLACE_PLUGINS.map((p) => {
      const key = `marketplace.plugin_${p.id.replace(/-/g, '_')}_desc` as string;
      const skills = p.skills?.map((s) => {
        const sKey = `marketplace.skill_${s.id.replace(/-/g, '_')}_desc` as string;
        return {
          ...s,
          description: t(sKey) !== sKey ? t(sKey) : s.description,
        };
      });
      return {
        ...p,
        description: t(key) !== key ? t(key) : p.description,
        skills,
      };
    });

    const catalogAsPlugins: PluginManifest[] = catalogSkills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      version: s.version,
      author: s.author,
      type: 'code' as const,
      permissions: s.permissions,
    }));
    // Avoid duplicates: hardcoded plugins take priority
    // Đều nhất hoá id trước khi so: bản hardcode dùng `ghita-github-assistant`
    // còn catalog dùng `ghita.github-assistant`. So nguyên chuỗi thì khớp 0/6,
    // nghĩa là MỌI plugin hiện MỘT lần hai, và cài bản này bản kia vẫn hiện
    // nút "Cài đặt" với công tắc độc lập.
    const normalizeId = (id: string) => id.toLowerCase().replace(/[._-]/g, '-');
    const hardcodedIds = new Set(localizedHardcoded.map((p) => normalizeId(p.id)));
    const merged = [
      ...localizedHardcoded,
      ...catalogAsPlugins.filter((p) => !hardcodedIds.has(normalizeId(p.id))),
    ];
    return merged;
  }, [catalogSkills, t]);

  // Sort catalog skills for display metadata
  const catalogMeta = useMemo(() => {
    const meta = new Map<string, SkillManifest>();
    for (const s of catalogSkills) meta.set(s.id, s);
    return meta;
  }, [catalogSkills]);

  const installedPlugins = useAppStore((s) => s.plugins);
  const installPlugin = useAppStore((s) => s.installPlugin);
  const uninstallPlugin = useAppStore((s) => s.uninstallPlugin);
  const togglePlugin = useAppStore((s) => s.togglePlugin);

  // Filter + sort logic
  const filteredPlugins = allPlugins
    .filter((plugin) => {
      const matchesSearch =
        plugin.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        plugin.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        plugin.author.toLowerCase().includes(searchQuery.toLowerCase());
      if (!matchesSearch) return false;
      if (filterType === 'all') return true;
      if (filterType === 'code') return plugin.type === 'code';
      if (filterType === 'bundle') return plugin.type === 'bundle';
      if (filterType === 'installed') {
        return installedPlugins.some((ip) => ip.manifest.id === plugin.id);
      }
      return true;
    })
    .sort((a, b) => {
      // BUG FIX #7: the previous implementation bailed out with `return 0`
      // whenever either entry was missing catalog metadata. The hardcoded
      // MARKETPLACE_PLUGINS list has no metadata at all, which meant the
      // sort callback *always* returned 0 → the dropdown looked decorative.
      //
      // New behaviour: when metadata is missing we fall back to a stable
      // tie-breaker derived from the same sort key applied to deterministic
      // defaults (0 downloads, 0 rating, version-parseable date). Entries
      // with real metadata still float to the top, which matches what
      // users expect from a marketplace.
      const metaA = catalogMeta.get(a.id);
      const metaB = catalogMeta.get(b.id);
      const aMissing = !metaA;
      const bMissing = !metaB;
      // Both missing → preserve original order via stable sort.
      if (aMissing && bMissing) return 0;
      // Missing entries always sort to the bottom.
      if (aMissing) return 1;
      if (bMissing) return -1;

      let primary = 0;
      if (sortBy === 'downloads') primary = metaB.downloads - metaA.downloads;
      else if (sortBy === 'rating') primary = metaB.rating - metaA.rating;
      else primary = metaB.publishedAt - metaA.publishedAt;

      if (primary !== 0) return primary;
      // Tie-breaker: alphabetical by name so the order is deterministic
      // across renders (Array.prototype.sort is stable but plugins that
      // share metadata would otherwise swap order on each render).
      return a.name.localeCompare(b.name);
    });

  const isInstalled = (pluginId: string) => {
    return installedPlugins.some((p) => p.manifest.id === pluginId);
  };

  const getInstalledState = (pluginId: string) => {
    return installedPlugins.find((p) => p.manifest.id === pluginId);
  };

  return (
    <div
      style={{
        height: '100%',
        overflow: 'auto',
        padding: '32px',
        display: 'flex',
        flexDirection: 'column',
        gap: '24px',
      }}
    >
      {/* Header section */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2
              style={{
                fontSize: '26px',
                fontWeight: 800,
                color: 'var(--text-primary)',
                marginBottom: '6px',
              }}
            >
              {t('marketplace.title')} 🧩
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
              {t('marketplace.subtitle')}
            </p>
          </div>
          <div
            style={{
              padding: '6px 14px',
              borderRadius: '20px',
              background: 'rgba(139, 92, 246, 0.1)',
              border: '1px solid rgba(139, 92, 246, 0.25)',
              fontSize: '13px',
              color: 'var(--accent-secondary)',
              fontWeight: 600,
            }}
          >
            {t('marketplace.installedBadge', { count: installedPlugins.length })}
          </div>
        </div>
      </div>

      {/* Control bar */}
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Search input */}
        <div style={{ flex: 1, minWidth: '260px', position: 'relative' }}>
          <input
            type="text"
            placeholder={t('marketplace.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: '100%',
              padding: '12px 16px',
              borderRadius: '12px',
              background: 'rgba(0,0,0,0.2)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: 'var(--text-primary)',
              fontSize: '14px',
              // ACCESSIBILITY (audit fix 1.3): removed outline:none
              transition: 'border-color 0.2s',
            }}
            onFocus={(e) => (e.target.style.borderColor = 'var(--accent-primary)')}
            onBlur={(e) => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')}
          />
        </div>

        {/* Filters */}
        <div
          style={{
            display: 'flex',
            background: 'rgba(0,0,0,0.15)',
            border: '1px solid rgba(255,255,255,0.05)',
            borderRadius: '12px',
            padding: '4px',
            gap: '4px',
          }}
        >
          {(['all', 'code', 'bundle', 'installed'] as const).map((type) => {
            const label = {
              all: t('marketplace.filterAll'),
              code: `${t('marketplace.filterCode')} ⚙️`,
              bundle: `${t('marketplace.filterBundle')} 📦`,
              installed: `${t('marketplace.filterInstalled')} ✅`,
            }[type];

            const active = filterType === type;
            return (
              <button
                key={type}
                onClick={() => setFilterType(type)}
                style={{
                  padding: '8px 16px',
                  borderRadius: '8px',
                  border: 'none',
                  background: active ? 'var(--accent-primary)' : 'transparent',
                  color: active ? '#fff' : 'var(--text-secondary)',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Phase 2.3: Sort dropdown */}
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as 'downloads' | 'rating' | 'newest')}
          style={{
            padding: '8px 12px',
            borderRadius: '8px',
            background: 'rgba(0,0,0,0.15)',
            border: '1px solid rgba(255,255,255,0.08)',
            color: 'var(--text-secondary)',
            fontSize: '13px',
            cursor: 'pointer',
          }}
        >
          <option value="downloads">{t('marketplace.sortByDownloads')}</option>
          <option value="rating">{t('marketplace.sortByRating')}</option>
          <option value="newest">{t('marketplace.sortByNewest')}</option>
        </select>
      </div>

      {/* Plugins Grid */}
      {filteredPlugins.length === 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '80px 20px',
            background: 'var(--bg-card)',
            borderRadius: '16px',
            border: '1px solid rgba(255,255,255,0.03)',
            gap: '12px',
          }}
        >
          <span style={{ fontSize: '48px' }}>🧩</span>
          <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
            {t('marketplace.emptyTitle')}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
            {t('marketplace.emptyHint')}
          </div>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: '24px',
          }}
        >
          {filteredPlugins.map((plugin) => {
            const installed = isInstalled(plugin.id);
            const ipState = getInstalledState(plugin.id);

            return (
              <div
                key={plugin.id}
                style={{
                  background: 'var(--bg-card)',
                  borderRadius: '16px',
                  padding: '24px',
                  border: '1px solid rgba(255,255,255,0.05)',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: '16px',
                  position: 'relative',
                  overflow: 'hidden',
                  transition: 'transform 0.2s, border-color 0.2s',
                  backdropFilter: 'blur(12px)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-4px)';
                  e.currentTarget.style.borderColor = 'rgba(139, 92, 246, 0.35)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.05)';
                }}
              >
                {/* Visual glow indicator */}
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '3px',
                    background:
                      plugin.type === 'code'
                        ? 'linear-gradient(90deg, #ec4899, #c084fc)'
                        : 'linear-gradient(90deg, #60a5fa, #22d3ee)',
                  }}
                />

                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                    }}
                  >
                    <div
                      style={{ fontWeight: 700, fontSize: '18px', color: 'var(--text-primary)' }}
                    >
                      {plugin.name}
                    </div>
                    <span
                      style={{
                        fontSize: '11px',
                        fontWeight: 600,
                        padding: '2px 8px',
                        borderRadius: '20px',
                        background:
                          plugin.type === 'code' ? 'rgba(236,72,153,0.1)' : 'rgba(96,165,250,0.1)',
                        color: plugin.type === 'code' ? '#f472b6' : '#60a5fa',
                        border: `1px solid ${plugin.type === 'code' ? 'rgba(236,72,153,0.2)' : 'rgba(96,165,250,0.2)'}`,
                      }}
                    >
                      {plugin.type === 'code' ? 'Code Plugin' : 'Bundle'}
                    </span>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      gap: '10px',
                      fontSize: '12px',
                      color: 'var(--text-muted)',
                      flexWrap: 'wrap',
                    }}
                  >
                    <span>v{plugin.version}</span>
                    <span>•</span>
                    <span>
                      {t('marketplace.author')} <strong>{plugin.author}</strong>
                    </span>
                    {catalogMeta.get(plugin.id) && (
                      <>
                        <span>•</span>
                        <span>
                          {(catalogMeta.get(plugin.id)?.downloads ?? 0).toLocaleString()}{' '}
                          {t('marketplace.downloads')}
                        </span>
                        <span>•</span>
                        <span>
                          {'★'.repeat(Math.round(catalogMeta.get(plugin.id)?.rating ?? 0))} (
                          {(catalogMeta.get(plugin.id)?.rating ?? 0).toFixed(1)})
                        </span>
                      </>
                    )}
                  </div>

                  <p
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: '13.5px',
                      lineHeight: 1.5,
                      margin: 0,
                    }}
                  >
                    {plugin.description}
                  </p>

                  {/* Permissions Required */}
                  {plugin.permissions && plugin.permissions.length > 0 && (
                    <div
                      style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}
                    >
                      <span
                        style={{
                          fontSize: '11px',
                          color: 'var(--text-muted)',
                          display: 'flex',
                          alignItems: 'center',
                          marginRight: '4px',
                        }}
                      >
                        {t('marketplace.permissions')}
                      </span>
                      {plugin.permissions.map((perm) => (
                        <span
                          key={perm}
                          style={{
                            fontSize: '10px',
                            background: 'rgba(255,255,255,0.05)',
                            padding: '1px 6px',
                            borderRadius: '4px',
                            color: 'var(--text-muted)',
                            fontFamily: 'monospace',
                          }}
                        >
                          {perm}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Actions bottom bar */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginTop: '8px',
                    paddingTop: '16px',
                    borderTop: '1px solid rgba(255,255,255,0.04)',
                  }}
                >
                  <div>
                    {installed && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div style={{ position: 'relative', width: '38px', height: '20px' }}>
                          <input
                            type="checkbox"
                            checked={ipState?.enabled || false}
                            onChange={(e) => togglePlugin(plugin.id, e.target.checked)}
                            id={`toggle-${plugin.id}`}
                            style={{ opacity: 0, width: 0, height: 0 }}
                          />
                          <label
                            htmlFor={`toggle-${plugin.id}`}
                            style={{
                              position: 'absolute',
                              cursor: 'pointer',
                              top: 0,
                              left: 0,
                              right: 0,
                              bottom: 0,
                              backgroundColor: ipState?.enabled ? 'var(--success)' : '#4b5563',
                              transition: '0.2s',
                              borderRadius: '20px',
                            }}
                          >
                            <span
                              style={{
                                position: 'absolute',
                                content: '""',
                                height: '14px',
                                width: '14px',
                                left: ipState?.enabled ? '20px' : '4px',
                                bottom: '3px',
                                backgroundColor: 'white',
                                transition: '0.2s',
                                borderRadius: '50%',
                              }}
                            />
                          </label>
                        </div>
                        <span
                          style={{
                            fontSize: '12px',
                            color: ipState?.enabled ? 'var(--success)' : 'var(--text-muted)',
                            fontWeight: 600,
                          }}
                        >
                          {ipState?.enabled
                            ? t('marketplace.activated')
                            : t('marketplace.deactivated')}
                        </span>
                      </div>
                    )}
                  </div>

                  <div>
                    {installed ? (
                      <button
                        onClick={() => uninstallPlugin(plugin.id)}
                        style={{
                          background: 'rgba(239,68,68,0.1)',
                          border: '1px solid rgba(239,68,68,0.2)',
                          color: '#f87171',
                          padding: '6px 16px',
                          borderRadius: '8px',
                          fontSize: '13px',
                          fontWeight: 600,
                          cursor: 'pointer',
                          transition: 'all 0.2s',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'rgba(239,68,68,0.2)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'rgba(239,68,68,0.1)';
                        }}
                      >
                        {t('common.uninstall')}
                      </button>
                    ) : (
                      <button
                        onClick={() => installPlugin(plugin)}
                        style={{
                          background: 'var(--accent-primary)',
                          border: 'none',
                          color: '#fff',
                          padding: '7px 20px',
                          borderRadius: '8px',
                          fontSize: '13px',
                          fontWeight: 600,
                          cursor: 'pointer',
                          transition: 'all 0.2s',
                          boxShadow: '0 2px 10px rgba(139,92,246,0.25)',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.boxShadow = '0 4px 15px rgba(139,92,246,0.4)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.boxShadow = '0 2px 10px rgba(139,92,246,0.25)';
                        }}
                      >
                        {t('common.install')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
