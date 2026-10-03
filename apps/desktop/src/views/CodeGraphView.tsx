// Code Knowledge Graph View

import { useState, useCallback, useMemo } from 'react';
import type { CodeNode, CodeKnowledgeGraph } from '../../../../packages/code-graph/src/index.js';
import { useTranslation } from '../i18n';

// Lazy-load the heavy code-graph module (it pulls tree-sitter WASM ~3MB).
// The view itself stays lightweight; the heavy work is fetched on demand.
async function loadGraphModule() {
  return import('../../../../packages/code-graph/src/index.js');
}

// Use a runtime `require` style import to bypass the lint rule on type imports
// of dynamically-imported modules (they are intentionally lazy to keep the
// main bundle small).
type CodeGraphModule = Awaited<ReturnType<typeof loadGraphModule>>;
let _graph: CodeKnowledgeGraph | null = null;
async function getGraph() {
  if (!_graph) {
    const mod = await loadGraphModule();
    _graph = new mod.CodeKnowledgeGraph();
  }
  return _graph;
}

interface Snapshot {
  nodes: CodeNode[];
  totalFiles: number;
  buildDuration: number;
}

export function CodeGraphView() {
  const { t } = useTranslation();
  const [workspacePath, setWorkspacePath] = useState<string>('');
  const [snap, setSnap] = useState<Snapshot>({
    nodes: [],
    totalFiles: 0,
    buildDuration: 0,
  });
  const [filter, setFilter] = useState('');
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const build = useCallback(async () => {
    if (!workspacePath) {
      setError(t('codeGraph.errorEnterPath'));
      return;
    }
    setBuilding(true);
    setError(null);
    try {
      const start = performance.now();
      const mod = await loadGraphModule();
      const graph = await getGraph();
      const files = await discoverAndIndex(mod, graph, workspacePath);
      const nodes = graph
        .getNodesByKind('function')
        .concat(graph.getNodesByKind('class'))
        .concat(graph.getNodesByKind('variable'))
        .concat(graph.getNodesByKind('module'));
      setSnap({
        nodes,
        totalFiles: files,
        buildDuration: performance.now() - start,
      });
    } catch (e) {
      setError(t('codeGraph.errorBuildFailed', { error: String(e) }));
    } finally {
      setBuilding(false);
    }
  }, [workspacePath, t]);

  const filtered = useMemo(() => {
    if (!filter) return snap.nodes;
    const q = filter.toLowerCase();
    return snap.nodes.filter(
      (n) => n.name.toLowerCase().includes(q) || n.filePath.toLowerCase().includes(q),
    );
  }, [snap.nodes, filter]);

  const stats = useMemo(() => {
    const byKind = new Map<string, number>();
    for (const n of snap.nodes) byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);
    return byKind;
  }, [snap.nodes]);

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '24px', margin: '0 0 16px' }}>{t('codeGraph.title')}</h1>

      <div
        style={{
          display: 'flex',
          gap: '8px',
          marginBottom: '16px',
          flexWrap: 'wrap',
        }}
      >
        <input
          type="text"
          value={workspacePath}
          onChange={(e) => setWorkspacePath(e.target.value)}
          placeholder={t('codeGraph.workspacePathPlaceholder')}
          aria-label={t('codeGraph.workspacePath')}
          style={{
            flex: 1,
            minWidth: '300px',
            padding: '8px 12px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '6px',
            color: 'var(--text-primary)',
            fontSize: '13px',
          }}
        />
        <button
          type="button"
          onClick={build}
          disabled={building || !workspacePath}
          style={{
            padding: '8px 16px',
            background: 'var(--accent-primary)',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: building ? 'wait' : 'pointer',
            fontSize: '13px',
          }}
        >
          {building ? t('codeGraph.building') : t('codeGraph.build')}
        </button>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            padding: '12px 16px',
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid #ef4444',
            borderRadius: '6px',
            color: '#ef4444',
            fontSize: '13px',
            marginBottom: '16px',
          }}
        >
          {error}
        </div>
      )}

      {snap.nodes.length > 0 && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: '12px',
              marginBottom: '16px',
            }}
          >
            {Array.from(stats.entries()).map(([kind, count]) => (
              <div
                key={kind}
                style={{
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '6px',
                  padding: '12px',
                }}
              >
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{kind}</div>
                <div style={{ fontSize: '20px', fontWeight: 600 }}>{count}</div>
              </div>
            ))}
            <div
              style={{
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '6px',
                padding: '12px',
              }}
            >
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {t('codeGraph.buildDuration')}
              </div>
              <div style={{ fontSize: '20px', fontWeight: 600 }}>
                {Math.round(snap.buildDuration)}ms
              </div>
            </div>
          </div>

          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('codeGraph.filterPlaceholder')}
            aria-label={t('codeGraph.filterAriaLabel')}
            style={{
              width: '100%',
              padding: '8px 12px',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '6px',
              color: 'var(--text-primary)',
              fontSize: '13px',
              marginBottom: '16px',
            }}
          />

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr>
                  <th style={th}>{t('codeGraph.columnName')}</th>
                  <th style={th}>{t('codeGraph.columnKind')}</th>
                  <th style={th}>{t('codeGraph.columnFile')}</th>
                  <th style={th}>{t('codeGraph.columnLine')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map((n) => (
                  <tr key={n.id}>
                    <td style={td}>
                      <code style={{ fontSize: '11px' }}>{n.name}</code>
                    </td>
                    <td style={td}>
                      <span
                        style={{
                          fontSize: '10px',
                          padding: '2px 6px',
                          borderRadius: '8px',
                          background: kindColor(n.kind),
                          color: 'white',
                          textTransform: 'uppercase',
                        }}
                      >
                        {n.kind}
                      </span>
                    </td>
                    <td style={td}>
                      <code style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        {n.filePath}
                      </code>
                    </td>
                    <td style={td}>{n.startLine}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > 200 && (
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
                {t('codeGraph.showingNofM', { shown: 200, total: filtered.length })}
              </p>
            )}
          </div>
        </>
      )}

      {snap.nodes.length === 0 && !building && !error && (
        <div
          style={{
            padding: '32px',
            textAlign: 'center',
            color: 'var(--text-muted)',
            background: 'var(--bg-secondary)',
            border: '1px dashed var(--border-subtle)',
            borderRadius: '6px',
          }}
        >
          {t('codeGraph.empty')}
        </div>
      )}
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

function kindColor(kind: string): string {
  switch (kind) {
    case 'function':
      return '#6366f1';
    case 'class':
      return '#ec4899';
    case 'variable':
      return '#10b981';
    case 'module':
      return '#f59e0b';
    default:
      return '#9ca3af';
  }
}

async function discoverAndIndex(
  mod: CodeGraphModule,
  graph: CodeKnowledgeGraph,
  dir: string,
): Promise<number> {
  // Phải xoá sạch trước khi index lại: graph là singleton cấp module, còn
  // `indexFile` chỉ gỡ file tương ứng với chính nó. Không `clear()` thì đổi
  // workspace từ A sang B, kết quả gồm node của CẢ HAI repo, trong khi
  // `totalFiles` chỉ đếm repo mới — bảng và số liệu tự mâu thuẫn.
  graph.clear();
  const files = await mod.discoverFiles(dir);
  for (const file of files) {
    graph.indexFile(file);
  }
  return files.length;
}
