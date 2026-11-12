import { useEffect, useRef, lazy, Suspense, useState, useCallback } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { MotionConfig } from 'framer-motion';
import { ErrorFallback } from './components/ErrorFallback';
import { isLocaleCode } from './i18n/types';

const MainLayout = lazy(() =>
  import('./layouts/MainLayout').then((m) => ({ default: m.MainLayout })),
);
import { Toast } from './components/Toast';
import { CommandPalette } from './components/CommandPalette';
import { QuickFileOpen } from './components/QuickFileOpen';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { useAppStore, type TabId } from './stores/appStore';
import { I18nProvider, useTranslation } from './i18n';
import toast from 'react-hot-toast';
import { invoke } from '@tauri-apps/api/core';

// Module-level guard to prevent duplicate sidecar server startup in React StrictMode.
// StrictMode double-invokes useEffect in development, which would cause two
// concurrent start_server calls → two Node processes → port conflicts → crash.
let serverStartupInFlight = false;

/** Returns true when running inside the Tauri WebView (not a plain browser). */
function isTauri(): boolean {
  return (
    typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  );
}

/**
 * Emits a 'ready' event to Tauri after the first React render completes.
 * This ensures the React UI is fully committed to the DOM before the
 * splash window closes and the main window becomes visible.
 */
function ReadyNotifier() {
  useEffect(() => {
    // Silently skip outside Tauri (e.g. browser-only dev) to avoid console warnings
    if (!isTauri()) return;
    // Use requestAnimationFrame to ensure the first paint has completed
    requestAnimationFrame(async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().emit('ready');
      } catch {
        // Silently ignore — emit failure is non-critical (safety timeout will show window)
      }
    });
  }, []);

  return null;
}

function AppContent() {
  const theme = useAppStore((s) => s.theme);
  const language = useAppStore((s) => s.language);
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  // v1.0.0 — Quick File Open modal (Ctrl+Shift+P / Ctrl+Shift+O).
  const [quickFileOpen, setQuickFileOpen] = useState(false);
  // v1.0.0 — Shortcuts overlay (press `?`).
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const lastSyncedLangRef = useRef(language);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  // Sync language changes from desktop React state to the Node sidecar server
  useEffect(() => {
    const syncLanguageToServer = async () => {
      if (language === lastSyncedLangRef.current) return;
      if (!isTauri()) return;
      lastSyncedLangRef.current = language;

      try {
        const status = await invoke<{ port: number }>('get_server_status');
        const port = status.port || 39001;
        await fetch(`http://127.0.0.1:${port}/sync-language`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ language }),
        });
        if (import.meta.env.DEV) console.info('[AppContent] Language synced to server:', language);
      } catch {
        // Silently ignore — language sync is best-effort
      }
    };
    void syncLanguageToServer();
  }, [language]);

  // Auto-start the sidecar server if it is offline on startup
  useEffect(() => {
    const autoStartServer = async () => {
      // Skip outside Tauri to avoid console errors in browser-only dev
      if (!isTauri()) return;
      
      // invocation. The flag must be set to `true` BEFORE the async work so
      // the second flush sees it; the previous code read the flag, reset it to
      // `false`, then checked it — which could never be true, so two
      // concurrent start_server calls raced. The flag is cleared again by the
      // tauri://update-status listener when the sidecar stops, so a later
      // reconnect (e.g. after an in-place update) can re-trigger startup.
      if (serverStartupInFlight) return;
      serverStartupInFlight = true;

      try {
        const result = await invoke<{ status?: string }>('get_server_status');
        if (result?.status !== 'ok') {
          if (import.meta.env.DEV)
            console.info('[AppContent] Server is offline on startup, invoking start_server...');
          await invoke('start_server');
        } else {
          if (import.meta.env.DEV) console.info('[AppContent] Server is already running.');
        }
      } catch {
        // Silently retry once on first failure
        try {
          await invoke('start_server');
        } catch {
          // Sidecar not available — non-critical in dev
        }
      }
    };
    autoStartServer();
  }, []);

  // Listen for server-stop events so the frontend can reconnect after
  // an in-place update kills the sidecar. Clears the startup guard and
  // triggers one reconnection attempt.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      if (!isTauri()) return;
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<{ event: string }>('tauri://update-status', (e) => {
          if (e.payload.event === 'sidecar-stopped' || e.payload.event === 'update-applied') {
            serverStartupInFlight = false;
            if (import.meta.env.DEV)
              console.info('[AppContent] Sidecar stopped; startup guard reset for reconnect.');
          }
        });
      } catch {
        /* not in Tauri or event not emitted */
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let unlistenFn: (() => void) | undefined;

    const setupListener = async () => {
      // Skip outside Tauri to avoid console errors in browser-only dev
      if (!isTauri()) return;
      try {
        const { listen } = await import('@tauri-apps/api/event');
        if (!active) return;

        const cleanup = await listen<{ event: string; data: Record<string, unknown> }>(
          'sidecar-event',
          (eventPayload) => {
            const { event, data } = eventPayload.payload;

            const tr = tRef.current;
            switch (event) {
              case 'sync_language': {
                // Guard (debug fix): the sidecar contract specifies
                // `data: { language: string }`, but a misbehaving or older
                // sidecar can send `{ event: 'sync_language' }` with no
                // `data` at all. Accessing `data.language` directly would
                // throw a TypeError and tear down the listener.
                const dataObj = (data ?? {}) as { language?: unknown };
                const lang = dataObj.language;
                // Validate the incoming language is a supported LocaleCode.
                // The sidecar may be running on an older install that still
                // sends `es`/`fr`/`pt` which were removed in v0.0.5; those
                // are dropped (review fix: now logged for diagnosability
                // instead of silently swallowed).
                if (typeof lang !== 'string' || !isLocaleCode(lang)) {
                  if (import.meta.env.DEV) {
                    console.warn(
                      '[AppContent] Ignoring sync_language — unsupported or missing locale:',
                      lang,
                    );
                  }
                  break;
                }
                if (import.meta.env.DEV)
                  console.info('[AppContent] Sync language received from sidecar:', lang);
                lastSyncedLangRef.current = lang;
                useAppStore.getState().setLanguage(lang);
                break;
              }
              case 'pair_confirm': {
                const name = String(data.name ?? 'Mobile');
                if (data.resumed) {
                  toast.success(tr('app.deviceReconnected', { name }));
                } else {
                  toast.success(tr('app.devicePaired', { name }));
                }
                break;
              }
              case 'command': {
                const action = String(data.action ?? 'Unknown');
                toast(tr('app.commandReceived', { action }), {
                  icon: '⚡',
                });
                break;
              }
              case 'chat': {
                const text = String(data.text ?? '');
                toast(tr('app.messageFromMobile', { text }), {
                  icon: '💬',
                });
                break;
              }
              case 'approve':
                toast.success(tr('app.deviceApproved'), {
                  duration: 4000,
                });
                break;
              case 'reject':
                toast.error(tr('app.deviceRejected'), {
                  duration: 4000,
                });
                break;
              case 'disconnect': {
                const dname = String(data.name ?? 'Mobile');
                toast.error(tr('app.deviceDisconnected', { name: dname }));
                break;
              }
              default:
                if (import.meta.env.DEV)
                  console.info('[Sidecar IPC] Unhandled event:', event, data);
            }
          },
        );

        if (!active) {
          cleanup();
        } else {
          unlistenFn = cleanup;
        }
      } catch {
        // Tauri event API unavailable — sidecar events are non-critical
      }
    };

    setupListener();

    return () => {
      active = false;
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, []);

  const terminalCwd = useAppStore((s) => s.terminalCwd);
  const shortcutsEnabled = useAppStore((s) => s.shortcutsEnabled);
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const toggleTerminal = useAppStore((s) => s.toggleTerminal);
  const toggleChat = useAppStore((s) => s.toggleChat);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  // v0.7.0 — Global keyboard shortcuts (when shortcutsEnabled is true)
  useEffect(() => {
    if (!shortcutsEnabled) return;

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      
      // is open it owns the keyboard — only its own toggle shortcut works, all
      // other shortcuts are suppressed so they cannot fire underneath.
      const isQuickFileShortcut =
        (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'P' || e.key === 'O');

      if (quickFileOpen) {
        if (isQuickFileShortcut) {
          e.preventDefault();
          setQuickFileOpen(false);
        }
        return;
      }
      if (shortcutsOpen) {
        if (e.key === '?') {
          e.preventDefault();
          setShortcutsOpen(false);
        }
        return;
      }

      // Don't intercept when user is typing in an input/textarea
      const tag = (e.target as HTMLElement).tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      // Ctrl+P / Cmd+P — Command Palette
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
        return;
      }

      // Ctrl+B — Toggle sidebar / toggle terminal focus
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // Ctrl+Shift+C — Toggle chat panel
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'C') {
        e.preventDefault();
        toggleChat();
        return;
      }

      // Ctrl+` — Toggle terminal
      if ((e.ctrlKey || e.metaKey) && e.key === '`') {
        e.preventDefault();
        toggleTerminal();
        return;
      }

      // Ctrl+1..=9 — Switch to corresponding tab (skip 'welcome')
      if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const tabIndex = parseInt(e.key, 10) - 1;
        const tabOrder: Array<string> = [
          'code',
          'api',
          'skills',
          'agents',
          'devices',
          'dashboard',
          'monitoring',
          'quota',
          'settings',
        ];
        if (tabIndex < tabOrder.length) {
          setActiveTab(tabOrder[tabIndex] as TabId);
        }
      }

      // v1.0.0 — Ctrl+Shift+P / Ctrl+Shift+O: Quick File Open (fuzzy file picker)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'P' || e.key === 'O')) {
        e.preventDefault();
        setQuickFileOpen((prev) => !prev);
      }
      // v1.0.0 — `?` (Shift+/): shortcuts overlay (skip when typing in inputs)
      if (e.key === '?' && shortcutsEnabled) {
        const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
        if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
          e.preventDefault();
          setShortcutsOpen((prev) => !prev);
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, { capture: true });
  }, [
    shortcutsEnabled,
    quickFileOpen,
    shortcutsOpen,
    setCommandPaletteOpen,
    toggleTerminal,
    toggleChat,
    toggleSidebar,
    setActiveTab,
  ]);

  // v1.0.0 — When Quick File Open requests to close (via Esc / overlay click),
  // mirror that back into state so the modal hides.
  const handleQuickFileClose = useCallback(() => setQuickFileOpen(false), []);

  // Sync workspace path to sidecar when it changes
  useEffect(() => {
    let active = true;
    const syncWorkspace = async () => {
      if (!isTauri()) return;
      try {
        const { getSharedSocket } = await import('./utils/sharedSocket');
        const socket = await getSharedSocket();
        if (socket && active) {
          socket.emit('set_workspace', { path: terminalCwd || null });
        }
      } catch (err) {
        console.warn('[AppContent] Failed to sync workspace path to sidecar:', err);
      }
    };
    void syncWorkspace();
    return () => {
      active = false;
    };
  }, [terminalCwd]);

  return (
    <>
      <ReadyNotifier />
      <CommandPalette />
      <Suspense
        fallback={
          <div
            style={{
              height: '100vh',
              display: 'grid',
              placeItems: 'center',
              background: '#0f0f1a',
              color: 'var(--text-muted)',
            }}
          >
            <div
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                border: '2px solid var(--border-subtle)',
                borderTopColor: 'var(--accent-primary)',
                animation: 'spin 700ms linear infinite',
              }}
            />
          </div>
        }
      >
        <MainLayout />
      </Suspense>
      <QuickFileOpen open={quickFileOpen} onClose={handleQuickFileClose} />
      <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <Toast />
    </>
  );
}

export function App() {
  return (
    <I18nProvider>
      <ErrorBoundary FallbackComponent={ErrorFallback}>
        {/* reducedMotion="user" makes every framer-motion animation in the
            desktop UI respect the OS `prefers-reduced-motion` setting:
            transform/layout animations are skipped and reduced to simple
            opacity fades. fx components additionally use useReducedMotion. */}
        <MotionConfig reducedMotion="user">
          <AppContent />
        </MotionConfig>
      </ErrorBoundary>
    </I18nProvider>
  );
}
