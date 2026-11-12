// McpToolsPanel — Track 6.3: section "MCP Tools" trong Skills view.
//
// Nguồn pattern: SkillManager.tsx (inline styles + CSS variables, request qua
// shared socket ack + timeout). Danh sách tool lấy từ MCP server registry của
// sidecar (GhitaMCPServer qua useMcp); panel còn cho phép test-call một tool
// với args JSON.

import { useMemo, useState } from 'react';
import { useMcp, type McpToolInfo } from '../hooks/useMcp';

const HEALTH_COLORS: Record<string, string> = {
  healthy: 'var(--success, #34d399)',
  degraded: 'var(--warning, #fbbf24)',
  checking: 'var(--accent-secondary, #818cf8)',
  unknown: 'var(--text-muted, #9ca3af)',
};

function requiredArgNames(tool: McpToolInfo): string[] {
  const required = (tool.inputSchema as { required?: unknown } | null)?.required;
  return Array.isArray(required) ? required.filter((n) => typeof n === 'string') : [];
}

function McpToolCard({ tool }: { tool: McpToolInfo }) {
  const required = requiredArgNames(tool);
  return (
    <article
      style={{
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-surface)',
        padding: '16px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
        <h4 style={{ fontSize: '14px', color: 'var(--text-primary)', margin: 0 }}>
          {tool.name}
        </h4>
        <span
          style={{
            height: '22px',
            padding: '3px 8px',
            borderRadius: 'var(--radius-full)',
            background: 'var(--success-bg)',
            color: 'var(--success)',
            fontSize: '11px',
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          MCP
        </span>
      </div>
      <p
        style={{
          fontSize: '12px',
          color: 'var(--text-muted)',
          lineHeight: 1.5,
          marginTop: '10px',
          marginBottom: 0,
        }}
      >
        {tool.description || 'No description provided by the MCP server.'}
      </p>
      {required.length > 0 && (
        <div
          style={{
            marginTop: '10px',
            fontSize: '11px',
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          required: {required.join(', ')}
        </div>
      )}
    </article>
  );
}

// Collapsed by default: mounting the body would emit mcp_list_tools/mcp_health
// right away (useMcp auto-refresh), which SkillManager's "no socket emit when
// not connected" test (and an idle view) should not pay. Load on demand.
export function McpToolsPanel() {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <section style={{ marginTop: '26px' }}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            width: '100%',
            textAlign: 'left',
            padding: '10px 14px',
            borderRadius: 'var(--radius-md)',
            border: '1px dashed var(--border-subtle)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            fontSize: '13px',
          }}
        >
          ▶ MCP Tools — bấm để tải danh sách tool từ sidecar
        </button>
      </section>
    );
  }
  return <McpToolsPanelBody />;
}

function McpToolsPanelBody() {
  const { tools, loading, error, refresh, callTool, health, checkHealth } = useMcp();
  const [selectedTool, setSelectedTool] = useState('');
  const [argsText, setArgsText] = useState('{}');
  const [calling, setCalling] = useState(false);
  const [lastResult, setLastResult] = useState<{ ok: boolean; text: string } | null>(null);

  const parsedArgs = useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(argsText || '{}');
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }, [argsText]);

  const runCall = async () => {
    if (!selectedTool || !parsedArgs || calling) return;
    setCalling(true);
    setLastResult(null);
    const result = await callTool(selectedTool, parsedArgs);
    setLastResult({ ok: result.ok, text: result.text });
    setCalling(false);
  };

  const healthState = health?.state ?? 'unknown';

  return (
    <section style={{ marginTop: '26px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '10px',
          marginBottom: '10px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: HEALTH_COLORS[healthState] ?? 'var(--text-muted)',
            }}
          />
          <h3
            style={{
              fontSize: '13px',
              color: 'var(--text-secondary)',
              textTransform: 'uppercase',
              margin: 0,
            }}
          >
            MCP Tools {tools.length > 0 ? `(${tools.length})` : ''}
          </h3>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {health && (
            <span
              style={{
                fontSize: '10px',
                padding: '3px 8px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--bg-hover)',
                color: HEALTH_COLORS[healthState] ?? 'var(--text-muted)',
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
            >
              MCP {healthState}
              {typeof health.latencyMs === 'number' ? ` · ${health.latencyMs}ms` : ''}
            </span>
          )}
          <button
            type="button"
            disabled={loading || calling}
            onClick={() => {
              void refresh();
              void checkHealth();
            }}
            style={{
              padding: '6px 10px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-active)',
              color: 'var(--accent-primary)',
              fontSize: '12px',
              fontWeight: 600,
            }}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 12px' }}>
        Tools registered on the sidecar MCP server registry (GhitaMCPServer over an
        in-memory client). Code-graph tools index the workspace lazily on first call.
      </p>

      {error && (
        <div
          style={{
            padding: '8px 10px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--error-bg)',
            color: 'var(--error)',
            fontSize: '11px',
            lineHeight: 1.5,
            marginBottom: '10px',
          }}
        >
          {error}
        </div>
      )}

      {tools.length === 0 && !loading && !error && (
        <div
          style={{
            padding: '10px 12px',
            borderRadius: 'var(--radius-sm)',
            border: '1px dashed var(--border-subtle)',
            color: 'var(--text-muted)',
            fontSize: '12px',
          }}
        >
          No MCP tools registered yet.
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '12px',
        }}
      >
        {tools.map((tool) => (
          <McpToolCard key={tool.name} tool={tool} />
        ))}
      </div>

      {tools.length > 0 && (
        <div
          style={{
            marginTop: '14px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-subtle)',
            background: 'var(--bg-surface)',
            padding: '14px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>
            Test call
          </div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <select
              value={selectedTool}
              onChange={(e) => setSelectedTool(e.target.value)}
              style={{
                flex: '1 1 220px',
                padding: '6px 8px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-subtle)',
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                fontSize: '12px',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <option value="">— select tool —</option>
              {tools.map((tool) => (
                <option key={tool.name} value={tool.name}>
                  {tool.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!selectedTool || !parsedArgs || calling}
              onClick={() => {
                void runCall();
              }}
              style={{
                padding: '6px 12px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--success-bg)',
                color: 'var(--success)',
                fontSize: '12px',
                fontWeight: 600,
              }}
            >
              {calling ? 'Calling…' : 'Call tool'}
            </button>
          </div>
          <textarea
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder='{"pattern": "createReActAgent"}'
            style={{
              padding: '8px 10px',
              borderRadius: 'var(--radius-sm)',
              border: `1px solid ${parsedArgs ? 'var(--border-subtle)' : 'var(--error)'}`,
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              fontSize: '12px',
              fontFamily: 'var(--font-mono)',
              resize: 'vertical',
            }}
          />
          {!parsedArgs && (
            <div style={{ fontSize: '11px', color: 'var(--error)' }}>
              Arguments must be a valid JSON object.
            </div>
          )}
          {lastResult && (
            <pre
              style={{
                margin: 0,
                padding: '8px 10px',
                borderRadius: 'var(--radius-sm)',
                background: lastResult.ok ? 'var(--success-bg)' : 'var(--error-bg)',
                color: lastResult.ok ? 'var(--success)' : 'var(--error)',
                fontSize: '11px',
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: '220px',
                overflow: 'auto',
              }}
            >
              {lastResult.text}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}
