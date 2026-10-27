import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore, type ThemeMode } from '../stores/appStore';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from '../i18n';
import { isWindows, isLinux } from '@ghita/shared';
import { Button, Badge, Input } from '../components/ui';

import { isLocaleCode, type LocaleCode } from '../i18n/types';

// The local `Select` component is a generic UI primitive that types its
// options as `string`. We keep the array typed as `Array<{ value: string; ... }>`
// for compatibility but every `value` is a known LocaleCode, and we cast
// at the boundary in the onChange handler so the store still receives
// strongly-typed values.
const LANGUAGE_OPTIONS: Array<{ value: LocaleCode; label: string }> = [
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: '简体中文' },
  { value: 'ru', label: 'Русский' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h3 className="text-base font-semibold text-[var(--text-primary)] mb-4 pb-2 border-b border-[var(--border-subtle)]">
        {title}
      </h3>
      {children}
    </div>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-[var(--border-subtle)]">
      <div>
        <div className="text-sm text-[var(--text-primary)] font-medium">{label}</div>
        {description && (
          <div className="text-xs text-[var(--text-muted)] mt-0.5">{description}</div>
        )}
      </div>
      {children}
    </div>
  );
}

function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string; icon?: string }>;
  onChange: (val: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border-default)] rounded text-[13px] min-w-[140px] cursor-pointer"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.icon ? `${opt.icon} ` : ''}
          {opt.label}
        </option>
      ))}
    </select>
  );
}

export function SettingsView() {
  // v0.7.0 — Editor & Terminal preferences
  const editorFontSize = useAppStore((s) => s.editorFontSize);
  const setEditorFontSize = useAppStore((s) => s.setEditorFontSize);
  const editorWordWrap = useAppStore((s) => s.editorWordWrap);
  const setEditorWordWrap = useAppStore((s) => s.setEditorWordWrap);
  const editorMinimap = useAppStore((s) => s.editorMinimap);
  const setEditorMinimap = useAppStore((s) => s.setEditorMinimap);
  const editorLineNumbers = useAppStore((s) => s.editorLineNumbers);
  const setEditorLineNumbers = useAppStore((s) => s.setEditorLineNumbers);
  const editorTabSize = useAppStore((s) => s.editorTabSize);
  const setEditorTabSize = useAppStore((s) => s.setEditorTabSize);
  const terminalFontSize = useAppStore((s) => s.terminalFontSize);
  const setTerminalFontSize = useAppStore((s) => s.setTerminalFontSize);
  // v1.0.0 — Low-RAM mode toggle (S36)
  const lowRamMode = useAppStore((s) => s.lowRamMode);
  const setLowRamMode = useAppStore((s) => s.setLowRamMode);
  // v1.0.0 — Auto-save toggle (F03)
  const autoSave = useAppStore((s) => s.autoSave);
  const setAutoSave = useAppStore((s) => s.setAutoSave);
  const terminalFontFamily = useAppStore((s) => s.terminalFontFamily);
  const setTerminalFontFamily = useAppStore((s) => s.setTerminalFontFamily);
  const terminalCursorStyle = useAppStore((s) => s.terminalCursorStyle);
  const setTerminalCursorStyle = useAppStore((s) => s.setTerminalCursorStyle);
  const resetSettings = useAppStore((s) => s.resetSettings);

  const theme = useAppStore((s) => s.theme);
  const language = useAppStore((s) => s.language);
  const logLevel = useAppStore((s) => s.logLevel);
  const setTheme = useAppStore((s) => s.setTheme);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const setLogLevel = useAppStore((s) => s.setLogLevel);
  const { t } = useTranslation();

  // v1.2.0 — manual update check (wires the signature-verified check_update command)
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    setUpdateStatus(null);
    try {
      const result = await invoke<unknown>('check_update');
      setUpdateStatus(
        typeof result === 'string' ? result : JSON.stringify(result ?? 'No update info'),
      );
    } catch (e) {
      setUpdateStatus(e instanceof Error ? e.message : 'Update check failed');
    } finally {
      setCheckingUpdate(false);
    }
  };

  const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: string }> = [
    { value: 'dark', label: t('settings.themeDark'), icon: '🌙' },
    { value: 'light', label: t('settings.themeLight'), icon: '☀️' },
  ];

  const LOG_LEVEL_OPTIONS = [
    { value: 'debug', label: t('settings.logDebug') },
    { value: 'info', label: t('settings.logInfo') },
    { value: 'warn', label: t('settings.logWarn') },
    { value: 'error', label: t('settings.logError') },
  ];

  const mcpServers = useAppStore(useShallow((s) => s.mcpServers));
  const setMcpServers = useAppStore((s) => s.setMcpServers);
  const hooks = useAppStore(useShallow((s) => s.hooks));
  const setHooks = useAppStore((s) => s.setHooks);

  // MCP form
  const [mcpName, setMcpName] = useState('');
  const [mcpCommand, setMcpCommand] = useState('');
  const [mcpTransport, setMcpTransport] = useState<'stdio' | 'sse'>('stdio');

  // Hook form
  const [hookEvent, setHookEvent] = useState('post_tool');
  const [hookTool, setHookTool] = useState('');
  const [hookCommand, setHookCommand] = useState('');

  return (
    <div className="h-full overflow-auto p-8 max-w-[700px]">
      <h2 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
        ⚙️ {t('settings.title')}
      </h2>
      <p className="text-[var(--text-muted)] text-sm mb-8">{t('settings.subtitle')}</p>

      <Section title={`🎨 ${t('settings.appearance')}`}>
        <SettingRow label={t('settings.theme')} description={t('settings.themeDesc')}>
          <Select
            value={theme}
            options={THEME_OPTIONS}
            onChange={(v) => setTheme(v as ThemeMode)}
          />
        </SettingRow>
        <SettingRow label={t('settings.language')} description={t('settings.languageDesc')}>
          <Select
            value={language}
            options={LANGUAGE_OPTIONS}
            onChange={(v) => {
              // Run-time guard (review fix): the local Select is typed
              // `(val: string) => void`, so we cannot trust the cast would
              // be safe. Validate against LocaleCode before forwarding.
              // setLanguage itself also re-validates as a defence-in-depth.
              if (isLocaleCode(v)) setLanguage(v);
            }}
          />
        </SettingRow>
      </Section>

      <Section title={`📝 ${t('settings.logging')}`}>
        <SettingRow label={t('settings.logLevel')} description={t('settings.logLevelDesc')}>
          <Select value={logLevel} options={LOG_LEVEL_OPTIONS} onChange={setLogLevel} />
        </SettingRow>
      </Section>

      <Section title={`🤖 ${t('settings.aiProviders')}`}>
        <SettingRow label={t('settings.apiKeys')} description={t('settings.apiKeysDesc')}>
          <Button
            variant="primary"
            size="md"
            onClick={() => useAppStore.getState().setActiveTab('api')}
          >
            {t('settings.openApiManager')}
          </Button>
        </SettingRow>
      </Section>

      {/* Phase 5A: MCP Servers */}
      <Section title={`🔌 ${t('settings.mcpServers')}`}>
        <p className="text-[13px] text-[var(--text-muted)] mb-3">{t('settings.mcpServersDesc')}</p>
        {mcpServers.map((server) => {
          // BUG FIX: Use stable composite key (name + transport) instead of
          // array index for both React reconciliation and the filter predicate.
          const serverKey = server.id || `${server.name}::${server.transport}`;
          return (
            <SettingRow
              key={serverKey}
              label={`${server.name} (${server.transport})`}
              description={server.enabled ? t('common.enabled') : t('common.disabled')}
            >
              <div className="flex gap-2">
                <Badge variant={server.connected ? 'success' : 'neutral'} dot>
                  {server.connected ? t('common.connected') : t('common.disconnected')}
                </Badge>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setMcpServers(
                      mcpServers.map((s) =>
                        (
                          server.id
                            ? s.id === server.id
                            : s.name === server.name && s.transport === server.transport
                        )
                          ? { ...s, enabled: !s.enabled }
                          : s,
                      ),
                    );
                  }}
                >
                  {server.enabled ? t('common.disable') : t('common.enable')}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() =>
                    setMcpServers(
                      mcpServers.filter((s) =>
                        server.id
                          ? s.id !== server.id
                          : !(s.name === server.name && s.transport === server.transport),
                      ),
                    )
                  }
                >
                  {t('common.remove')}
                </Button>
              </div>
            </SettingRow>
          );
        })}
        <div className="flex gap-2 mt-3 items-center">
          <Input
            placeholder={t('settings.mcpNamePlaceholder')}
            value={mcpName}
            onChange={(e) => setMcpName(e.target.value)}
            className="flex-none w-[100px]"
          />
          <Input
            placeholder={t('settings.mcpCommandPlaceholder')}
            value={mcpCommand}
            onChange={(e) => setMcpCommand(e.target.value)}
            className="flex-1"
          />
          <select
            value={mcpTransport}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'stdio' || v === 'sse') setMcpTransport(v);
            }}
            className="px-2.5 py-1.5 text-xs rounded-md bg-slate-900/60 border border-white/10 text-slate-100"
          >
            <option value="stdio">stdio</option>
            <option value="sse">sse</option>
          </select>
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              if (mcpName && mcpCommand) {
                setMcpServers([
                  ...mcpServers,
                  {
                    id: crypto.randomUUID(),
                    name: mcpName,
                    transport: mcpTransport,
                    enabled: true,
                    connected: false,
                    command: mcpCommand,
                  },
                ]);
                setMcpName('');
                setMcpCommand('');
              }
            }}
          >
            + {t('common.add')}
          </Button>
        </div>
      </Section>

      {/* Phase 5B: Hooks */}
      <Section title={`🪝 ${t('settings.hooks')}`}>
        <p className="text-[13px] text-[var(--text-muted)] mb-3">{t('settings.hooksDesc')}</p>
        {hooks.map((hook, i) => (
          <SettingRow
            key={i}
            label={`${hook.event}: ${hook.tool || '*'}`}
            description={hook.command}
          >
            <div className="flex gap-2">
              <Badge variant={hook.enabled ? 'success' : 'neutral'} dot>
                {hook.enabled ? t('common.active') : t('common.disabled')}
              </Badge>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  const u = [...hooks];
                  const h = u[i];
                  if (h) {
                    u[i] = { ...h, enabled: !h.enabled };
                  }
                  setHooks(u);
                }}
              >
                {hook.enabled ? t('common.disable') : t('common.enable')}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => setHooks(hooks.filter((_, idx) => idx !== i))}
              >
                {t('common.remove')}
              </Button>
            </div>
          </SettingRow>
        ))}
        <div className="flex gap-2 mt-3 items-center">
          <select
            value={hookEvent}
            onChange={(e) => setHookEvent(e.target.value)}
            className="flex-none w-[100px] px-2.5 py-1.5 text-xs rounded-md bg-slate-900/60 border border-white/10 text-slate-100"
          >
            <option value="pre_tool">pre_tool</option>
            <option value="post_tool">post_tool</option>
            <option value="pre_response">pre_response</option>
          </select>
          <Input
            placeholder={t('settings.hookToolPlaceholder')}
            value={hookTool}
            onChange={(e) => setHookTool(e.target.value)}
            className="flex-none w-[120px]"
          />
          <Input
            placeholder={t('settings.hookCommandPlaceholder')}
            value={hookCommand}
            onChange={(e) => setHookCommand(e.target.value)}
            className="flex-1"
          />
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              if (hookCommand) {
                setHooks([
                  ...hooks,
                  { event: hookEvent, tool: hookTool, command: hookCommand, enabled: true },
                ]);
                setHookTool('');
                setHookCommand('');
              }
            }}
          >
            + {t('common.add')}
          </Button>
        </div>
      </Section>

      {/* v0.7.0 — Editor Preferences */}
      <Section title={`✏️ ${t('editor.editorConfig')}`}>
        <SettingRow label={t('editor.fontSize')}>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={10}
              max={32}
              value={editorFontSize}
              onChange={(e) => setEditorFontSize(Number(e.target.value))}
              className="w-16 text-center"
            />
            <span className="text-[10px] text-text-muted">px</span>
          </div>
        </SettingRow>
        <SettingRow label={t('editor.wordWrap')}>
          <select
            value={editorWordWrap ? 'on' : 'off'}
            onChange={(e) => setEditorWordWrap(e.target.value === 'on')}
            className="text-sm bg-bg-surface border border-border-default rounded-md px-2 py-1 text-text-primary outline-none"
          >
            <option value="on">{t('editor.wordWrapToggle')}</option>
            <option value="off">{t('editor.wordWrapToggle')}</option>
          </select>
        </SettingRow>
        <SettingRow label={t('editor.minimap')}>
          <select
            value={editorMinimap ? 'on' : 'off'}
            onChange={(e) => setEditorMinimap(e.target.value === 'on')}
            className="text-sm bg-bg-surface border border-border-default rounded-md px-2 py-1 text-text-primary outline-none"
          >
            <option value="on">{t('editor.minimapToggle')}</option>
            <option value="off">{t('editor.minimapToggle')}</option>
          </select>
        </SettingRow>
        <SettingRow label={t('editor.lineNumbers')}>
          <select
            value={editorLineNumbers ? 'on' : 'off'}
            onChange={(e) => setEditorLineNumbers(e.target.value === 'on')}
            className="text-sm bg-bg-surface border border-border-default rounded-md px-2 py-1 text-text-primary outline-none"
          >
            <option value="on">{t('editor.lineNumbersToggle')}</option>
            <option value="off">{t('editor.lineNumbersToggle')}</option>
          </select>
        </SettingRow>
        <SettingRow label={t('editor.tabSize')}>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={8}
              value={editorTabSize}
              onChange={(e) => setEditorTabSize(Number(e.target.value))}
              className="w-16 text-center"
            />
            <span className="text-[10px] text-text-muted">spaces</span>
          </div>
        </SettingRow>
      </Section>

      {/* v0.7.0 — Terminal Preferences */}
      <Section title={`🖥️ ${t('terminal.title')}`}>
        <SettingRow label={t('editor.fontSize')}>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={10}
              max={24}
              value={terminalFontSize}
              onChange={(e) => setTerminalFontSize(Number(e.target.value))}
              className="w-16 text-center"
            />
            <span className="text-[10px] text-text-muted">px</span>
          </div>
        </SettingRow>
        <SettingRow label="Font Family">
          <Input
            value={terminalFontFamily}
            onChange={(e) => setTerminalFontFamily(e.target.value)}
            className="flex-1"
            placeholder="Font family"
          />
        </SettingRow>
        <SettingRow label="Cursor Style">
          <select
            value={terminalCursorStyle}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'block' || v === 'underline' || v === 'bar') setTerminalCursorStyle(v);
            }}
            className="text-sm bg-bg-surface border border-border-default rounded-md px-2 py-1 text-text-primary outline-none"
          >
            <option value="block">Block</option>
            <option value="underline">Underline</option>
            <option value="bar">Bar</option>
          </select>
        </SettingRow>
      </Section>

      {/* v1.0.0 — Performance: Low-RAM mode (S36) */}
      <Section title={`⚡ ${t('settings.performance')}`}>
        <SettingRow label={t('settings.lowRamMode')} description={t('settings.lowRamModeDesc')}>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={lowRamMode}
              onChange={(e) => setLowRamMode(e.target.checked)}
              className="w-4 h-4 accent-[var(--accent-primary)]"
              data-testid="low-ram-toggle"
            />
            <span className="text-sm text-[var(--text-secondary)]">
              {lowRamMode ? t('settings.lowRamOn') : t('settings.lowRamOff')}
            </span>
          </label>
        </SettingRow>
        <SettingRow label={t('settings.autoSave')} description={t('settings.autoSaveDesc')}>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoSave}
              onChange={(e) => setAutoSave(e.target.checked)}
              className="w-4 h-4 accent-[var(--accent-primary)]"
              data-testid="auto-save-toggle"
            />
            <span className="text-sm text-[var(--text-secondary)]">
              {autoSave ? t('settings.autoSaveOn') : t('settings.autoSaveOff')}
            </span>
          </label>
        </SettingRow>
      </Section>

      {/* v0.7.0 — Keyboard Shortcuts */}
      <Section title={`⌨️ ${t('welcome.shortcuts')}`}>
        <SettingRow label="Command Palette">
          <kbd className="text-[10px] bg-bg-surface px-2 py-0.5 rounded border border-border-subtle text-text-muted">
            Ctrl+P
          </kbd>
        </SettingRow>
        <SettingRow label="Toggle Terminal">
          <kbd className="text-[10px] bg-bg-surface px-2 py-0.5 rounded border border-border-subtle text-text-muted">
            Ctrl+`
          </kbd>
        </SettingRow>
        <SettingRow label="Toggle Chat">
          <kbd className="text-[10px] bg-bg-surface px-2 py-0.5 rounded border border-border-subtle text-text-muted">
            Ctrl+Shift+C
          </kbd>
        </SettingRow>
        <SettingRow label="Keyboard Shortcuts">
          <kbd className="text-[10px] bg-bg-surface px-2 py-0.5 rounded border border-border-subtle text-text-muted">
            Ctrl+K
          </kbd>
        </SettingRow>
      </Section>

      <Section title={`ℹ ${t('settings.info')}`}>
        <SettingRow label={t('settings.version')} description="Ghita Agent">
          <span className="text-sm text-[var(--accent-primary)] font-semibold">
            {t('app.version')}
          </span>
        </SettingRow>
        <SettingRow label={t('settings.platform')} description={t('settings.platformDesc')}>
          <span className="text-sm text-[var(--text-secondary)]">
            {isWindows()
              ? `🖥️ ${t('settings.windows')}`
              : isLinux()
                ? `🖥️ ${t('settings.linux')}`
                : `🖥️ ${t('mainLayout.unknown')}`}
          </span>
        </SettingRow>
        <SettingRow label={t('settings.checkUpdate')} description={t('settings.checkUpdateDesc')}>
          <Button
            size="sm"
            variant="secondary"
            onClick={handleCheckUpdate}
            disabled={checkingUpdate}
            data-testid="check-update-btn"
          >
            {checkingUpdate ? t('settings.checkingUpdate') : t('settings.checkUpdateAction')}
          </Button>
        </SettingRow>
        {updateStatus && (
          <p className="text-xs text-[var(--text-muted)] mt-2" data-testid="update-status">
            {updateStatus}
          </p>
        )}
      </Section>

      {/* Reset */}
      <div className="flex justify-end pt-4 border-t border-[var(--border-subtle)]">
        <Button
          variant="ghost"
          onClick={() => {
            if (window.confirm('Reset all settings to defaults?')) {
              resetSettings();
            }
          }}
          className="text-sm"
        >
          {t('settings.resetDefaults')}
        </Button>
      </div>
    </div>
  );
}
