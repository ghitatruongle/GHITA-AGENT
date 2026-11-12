import { useMemo, useState, useRef, useEffect } from 'react';
import { type Socket } from 'socket.io-client';
import { getSharedSocket } from '../utils/sharedSocket';
import { McpToolsPanel } from './McpToolsPanel';
import {
  createDefaultSkillRegistry,
  type SkillDefinition,
  type SkillRegistrySnapshot,
} from '@ghita/skills';
import type { SkillCategory, SkillResult } from '@ghita/shared';
import { useTranslation } from '../i18n';

const MOCK_COMPUTER_SKILLS: SkillDefinition[] = [
  {
    id: 'computer.moveMouse',
    name: 'Move Mouse',
    description: 'Move the mouse cursor to screen coordinates.',
    category: 'computer',
    enabled: false,
    version: '0.1.0',
    scopes: ['desktop'],
    status: 'disabled',
    parameters: {
      x: { type: 'number', description: 'X coordinate', required: true },
      y: { type: 'number', description: 'Y coordinate', required: true },
    },
    run: async () => ({
      success: false,
      error: 'OS Automation adapter is only available when connected to host sidecar.',
    }),
  },
  {
    id: 'computer.click',
    name: 'Click Mouse',
    description: 'Click at the current cursor or a target coordinate.',
    category: 'computer',
    enabled: false,
    version: '0.1.0',
    scopes: ['desktop'],
    status: 'disabled',
    parameters: {
      x: { type: 'number', description: 'Optional X coordinate', required: false },
      y: { type: 'number', description: 'Optional Y coordinate', required: false },
    },
    run: async () => ({
      success: false,
      error: 'OS Automation adapter is only available when connected to host sidecar.',
    }),
  },
  {
    id: 'computer.typeText',
    name: 'Type Text',
    description: 'Type text through the keyboard adapter.',
    category: 'computer',
    enabled: false,
    version: '0.1.0',
    scopes: ['desktop'],
    status: 'disabled',
    parameters: {
      text: { type: 'string', description: 'Text to type', required: true },
    },
    run: async () => ({
      success: false,
      error: 'OS Automation adapter is only available when connected to host sidecar.',
    }),
  },
  {
    id: 'computer.screenshot',
    name: 'Computer Screenshot',
    description: 'Capture the screen through the computer-use adapter.',
    category: 'computer',
    enabled: false,
    version: '0.1.0',
    scopes: ['desktop'],
    status: 'disabled',
    run: async () => ({
      success: false,
      error: 'OS Automation adapter is only available when connected to host sidecar.',
    }),
  },
];

const MOCK_BROWSER_SKILLS: SkillDefinition[] = [
  {
    id: 'browser.open',
    name: 'Open Browser',
    description: 'Launch a controlled browser session.',
    category: 'browser',
    enabled: false,
    version: '0.1.0',
    scopes: ['browser'],
    status: 'disabled',
    run: async () => ({
      success: false,
      error: 'Browser Control adapter is only available when connected to host sidecar.',
    }),
  },
  {
    id: 'browser.navigate',
    name: 'Navigate Browser',
    description: 'Navigate the controlled browser to a URL.',
    category: 'browser',
    enabled: false,
    version: '0.1.0',
    scopes: ['browser'],
    status: 'disabled',
    parameters: {
      url: { type: 'string', description: 'URL to open', required: true },
    },
    run: async () => ({
      success: false,
      error: 'Browser Control adapter is only available when connected to host sidecar.',
    }),
  },
  {
    id: 'browser.extract',
    name: 'Extract Page Text',
    description: 'Extract text from the page or a selector.',
    category: 'browser',
    enabled: false,
    version: '0.1.0',
    scopes: ['browser'],
    status: 'disabled',
    parameters: {
      selector: { type: 'string', description: 'Optional CSS selector', required: false },
    },
    run: async () => ({
      success: false,
      error: 'Browser Control adapter is only available when connected to host sidecar.',
    }),
  },
  {
    id: 'browser.fill',
    name: 'Fill Browser Field',
    description: 'Fill a browser input field.',
    category: 'browser',
    enabled: false,
    version: '0.1.0',
    scopes: ['browser'],
    status: 'disabled',
    parameters: {
      selector: { type: 'string', description: 'CSS selector', required: true },
      value: { type: 'string', description: 'Value to enter', required: true },
    },
    run: async () => ({
      success: false,
      error: 'Browser Control adapter is only available when connected to host sidecar.',
    }),
  },
];

const CATEGORY_LABELS: Record<SkillCategory, string> = {
  file: 'File',
  terminal: 'Terminal',
  browser: 'Browser',
  computer: 'Computer',
  screenshot: 'Screenshot',
  app: 'App',
};

const CATEGORY_ACCENTS: Record<SkillCategory, string> = {
  file: '#60a5fa',
  terminal: '#22c55e',
  browser: '#38bdf8',
  computer: '#f59e0b',
  screenshot: '#a78bfa',
  app: '#f472b6',
};

function getSampleInput(skill: SkillDefinition): Record<string, unknown> {
  switch (skill.id) {
    case 'file.read':
      return { path: 'README.md' };
    case 'file.list':
      return { path: '.' };
    case 'file.write':
      return { path: 'tmp/skill-test.txt', content: 'GHITA skill test' };
    case 'terminal.run':
      return { command: 'echo GHITA terminal skill', timeoutMs: 5000 };
    case 'app.open':
      return { target: 'https://example.com' };
    case 'app.close':
      return { target: 'example.exe' };
    case 'browser.navigate':
      return { url: 'https://example.com' };
    case 'browser.extract':
      return { selector: 'body' };
    case 'browser.fill':
      return { selector: 'input[name=q]', value: 'GHITA' };
    case 'computer.moveMouse':
    case 'computer.click':
      return { x: 10, y: 10 };
    case 'computer.typeText':
      return { text: 'GHITA' };
    
    case 'git.status':
      return { porcelain: true };
    case 'git.commit':
      return { message: 'test: verify skill integration' };
    case 'git.diff':
      return { target: 'HEAD' };
    case 'git.branch':
      return { action: 'list' };
    case 'docker.run':
      return { image: 'hello-world' };
    case 'docker.build':
      return { tag: 'test:latest', context: '.' };
    case 'docker.ps':
      return { all: false };
    case 'db.query':
      return { database: 'test.db', query: 'SELECT 1' };
    case 'http.request':
      return { url: 'https://httpbin.org/get', method: 'GET' };
    case 'code.format':
      return { path: 'README.md', formatter: 'prettier' };
    case 'code.lint':
      return { path: '.', linter: 'eslint' };
    case 'test.run':
      return { framework: 'vitest' };
    case 'search.codebase':
      return { query: 'SkillRegistry', path: 'packages/skills/src' };
    case 'compress.zip':
      return { source: 'README.md', output: 'tmp/test-archive.zip' };
    case 'deploy.check':
      return {};
    default:
      return {};
  }
}

function createRegistry() {
  const registry = createDefaultSkillRegistry();
  registry.registerMany(MOCK_COMPUTER_SKILLS);
  registry.registerMany(MOCK_BROWSER_SKILLS);
  return registry;
}

function ResultLine({ result }: { result?: SkillResult }) {
  if (!result) return null;

  return (
    <div
      style={{
        marginTop: '10px',
        padding: '8px 10px',
        borderRadius: 'var(--radius-sm)',
        background: result.success ? 'var(--success-bg)' : 'var(--error-bg)',
        color: result.success ? 'var(--success)' : 'var(--error)',
        fontSize: '11px',
        lineHeight: 1.5,
      }}
    >
      {result.success
        ? (result.output ?? 'Skill ran successfully.')
        : (result.error ?? 'Skill failed.')}
    </div>
  );
}

export function SkillManager() {
  const { t } = useTranslation();
  const registryRef = useRef<ReturnType<typeof createDefaultSkillRegistry> | null>(null);
  if (!registryRef.current) {
    registryRef.current = createRegistry();
  }
  const registry = registryRef.current;
  const [snapshot, setSnapshot] = useState<SkillRegistrySnapshot>(() => registry.snapshot());
  const [lastResults, setLastResults] = useState<Record<string, SkillResult>>({});
  const [runningId, setRunningId] = useState<string | null>(null);

  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  // Use shared socket singleton instead of creating a separate connection
  useEffect(() => {
    let active = true;
    
    // are actually removed on cleanup. The previous code only flipped
    // `active = false`, leaving the two listeners permanently attached to the
    // app-lifetime socket — every visit to the Skills tab added another pair.
    let s: Socket | null = null;
    const onConnect = () => {
      if (active) setConnected(true);
    };
    const onDisconnect = () => {
      if (active) setConnected(false);
    };
    getSharedSocket().then((shared) => {
      if (active && shared) {
        s = shared;
        setSocket(shared);
        setConnected(shared.connected);
        shared.on('connect', onConnect);
        shared.on('disconnect', onDisconnect);
      }
    });
    return () => {
      active = false;
      // Unsubscribe the exact handlers we registered (mock sockets in tests
      // may not implement `off` — guard defensively).
      if (typeof s?.off === 'function') {
        s.off('connect', onConnect);
        s.off('disconnect', onDisconnect);
      }
    };
  }, []);

  const categories = useMemo(() => {
    const grouped = new Map<SkillCategory, SkillDefinition[]>();
    for (const skill of snapshot.skills) {
      const existing = grouped.get(skill.category) ?? [];
      existing.push(skill);
      grouped.set(skill.category, existing);
    }
    return [...grouped.entries()];
  }, [snapshot.skills]);

  const toggleSkill = (skill: SkillDefinition) => {
    const updated = registry.setEnabled(skill.id, !skill.enabled);
    setSnapshot(registry.snapshot());
    if (connected && socket) {
      socket.emit('set_skill_enabled', { id: updated.id, enabled: updated.enabled }, () => {});
    }
  };

  const runSkill = async (skill: SkillDefinition) => {
    setRunningId(skill.id);
    const input = getSampleInput(skill);

    if (connected && socket) {
      // Proxy skill run to Node sidecar
      try {
        
        // socket ack with no timeout — if the sidecar never answered (dead
        // handler, disconnect race), the promise never settled and the Run
        // button stayed disabled forever. Same 15s bound as the run itself.
        const syncResult = await new Promise<{ success: boolean; error?: string }>(
          (resolvePromise) => {
            let settled = false;
            const timer = setTimeout(() => {
              if (!settled) {
                settled = true;
                resolvePromise({ success: false, error: 'Sidecar sync timed out.' });
              }
            }, 15000);
            socket.emit(
              'set_skill_enabled',
              { id: skill.id, enabled: skill.enabled },
              (res: { success: boolean; error?: string }) => {
                if (!settled) {
                  settled = true;
                  clearTimeout(timer);
                  resolvePromise(res);
                }
              },
            );
          },
        );
        if (!syncResult.success) {
          throw new Error(syncResult.error ?? 'Failed to sync skill enablement on host sidecar.');
        }

        const result = await new Promise<SkillResult>((resolvePromise) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (!settled) {
              settled = true;
              resolvePromise({
                success: false,
                error: 'Skill execution timed out on host sidecar.',
              });
            }
          }, 15000);
          socket.emit('run_skill', { id: skill.id, input }, (res: SkillResult) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolvePromise(res);
            }
          });
        });
        setLastResults((current) => ({ ...current, [skill.id]: result }));
      } catch (err: unknown) {
        setLastResults((current) => ({
          ...current,
          [skill.id]: {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to proxy skill execution.',
          },
        }));
      }
    } else {
      // Fallback: local sandboxed execution (mostly will say adapter not available)
      const result = await registry.run(skill.id, { input });
      setLastResults((current) => ({ ...current, [skill.id]: result }));
    }

    setRunningId(null);
  };

  return (
    <div style={{ padding: '24px', overflow: 'auto', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: '16px',
          marginBottom: '20px',
        }}
      >
        <div>
          <h2
            style={{
              fontSize: '20px',
              fontWeight: 700,
              marginBottom: '8px',
              background: 'var(--accent-gradient)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            {t('skillManager.title')}
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
            {t('skillManager.subtitle')}
          </p>
        </div>
        <div
          style={{
            minWidth: '170px',
            padding: '12px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-subtle)',
            background: 'var(--bg-surface)',
          }}
        >
          <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--accent-secondary)' }}>
            {snapshot.enabled}/{snapshot.total}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {t('skillManager.enabledSkills')}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
        {categories.map(([category, skills]) => (
          <section key={category}>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}
            >
              <span
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: CATEGORY_ACCENTS[category],
                }}
              />
              <h3
                style={{
                  fontSize: '13px',
                  color: 'var(--text-secondary)',
                  textTransform: 'uppercase',
                }}
              >
                {CATEGORY_LABELS[category]} ({snapshot.byCategory[category]})
              </h3>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: '12px',
              }}
            >
              {skills.map((skill) => {
                const accent = CATEGORY_ACCENTS[skill.category];
                const isRunning = runningId === skill.id;
                return (
                  <article
                    key={skill.id}
                    style={{
                      borderRadius: 'var(--radius-md)',
                      border: `1px solid ${skill.enabled ? accent : 'var(--border-subtle)'}`,
                      background: skill.enabled
                        ? 'rgba(255, 255, 255, 0.055)'
                        : 'var(--bg-surface)',
                      padding: '16px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                      <div>
                        <h4
                          style={{
                            fontSize: '14px',
                            color: 'var(--text-primary)',
                            marginBottom: '4px',
                          }}
                        >
                          {skill.name}
                        </h4>
                        <div
                          style={{
                            fontSize: '11px',
                            color: 'var(--text-muted)',
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          {skill.id}
                        </div>
                      </div>
                      <span
                        style={{
                          height: '22px',
                          padding: '3px 8px',
                          borderRadius: 'var(--radius-full)',
                          background: skill.enabled ? 'var(--success-bg)' : 'var(--bg-hover)',
                          color: skill.enabled ? 'var(--success)' : 'var(--text-muted)',
                          fontSize: '11px',
                          fontWeight: 600,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {skill.enabled ? t('common.active') : t('common.off')}
                      </span>
                    </div>

                    <p
                      style={{
                        fontSize: '12px',
                        color: 'var(--text-muted)',
                        lineHeight: 1.5,
                        marginTop: '10px',
                      }}
                    >
                      {skill.description}
                    </p>

                    <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
                      <button
                        type="button"
                        onClick={() => toggleSkill(skill)}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 'var(--radius-sm)',
                          background: skill.enabled ? 'var(--warning-bg)' : 'var(--bg-active)',
                          color: skill.enabled ? 'var(--warning)' : 'var(--accent-primary)',
                          fontSize: '12px',
                          fontWeight: 600,
                        }}
                      >
                        {skill.enabled ? t('common.disable') : t('common.enable')}
                      </button>
                      <button
                        type="button"
                        disabled={!skill.enabled || isRunning}
                        onClick={() => {
                          void runSkill(skill);
                        }}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 'var(--radius-sm)',
                          background: 'var(--success-bg)',
                          color: 'var(--success)',
                          fontSize: '12px',
                          fontWeight: 600,
                        }}
                      >
                        {isRunning ? t('skillManager.running') : t('skillManager.testRun')}
                      </button>
                    </div>

                    <ResultLine result={lastResults[skill.id]} />
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {/* Track 6.3 — MCP Tools: registry sidecar (GhitaMCPServer) + test call.
          Nằm trong scroll flow của Skills view nên không phá layout hiện có. */}
      <McpToolsPanel />
    </div>
  );
}
