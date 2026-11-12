// A searchable reference of every keyboard shortcut, grouped by category.
// Opened with `?` (when not typing in an input) and closed with Esc.

import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { overlayFade, popIn } from '../lib/motion';
import { useTranslation } from '../i18n';

interface Shortcut {
  keys: string;
  label: string;
  category: string;
}

interface ShortcutsOverlayProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsOverlay({ open, onClose }: ShortcutsOverlayProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const shortcuts = useMemo<Shortcut[]>(
    () => [
      {
        keys: 'Ctrl+P',
        label: t('shortcuts.cmdPalette') || 'Open command palette',
        category: t('shortcuts.catGeneral') || 'General',
      },
      {
        keys: 'Ctrl+Shift+P',
        label: t('shortcuts.quickFile') || 'Quick file open',
        category: t('shortcuts.catGeneral') || 'General',
      },
      {
        keys: 'Ctrl+Shift+O',
        label: t('shortcuts.quickFile') || 'Quick file open',
        category: t('shortcuts.catGeneral') || 'General',
      },
      {
        keys: '?',
        label: t('shortcuts.showShortcuts') || 'Show this shortcuts overlay',
        category: t('shortcuts.catGeneral') || 'General',
      },
      {
        keys: 'Esc',
        label: t('shortcuts.closeOverlay') || 'Close any open overlay',
        category: t('shortcuts.catGeneral') || 'General',
      },
      {
        keys: 'Ctrl+S',
        label: t('shortcuts.save') || 'Save current file',
        category: t('shortcuts.catEditor') || 'Editor',
      },
      {
        keys: 'Ctrl+Shift+S',
        label: t('shortcuts.saveAll') || 'Save all modified files',
        category: t('shortcuts.catEditor') || 'Editor',
      },
      {
        keys: 'Ctrl+W',
        label: t('shortcuts.closeTab') || 'Close current tab',
        category: t('shortcuts.catEditor') || 'Editor',
      },
      {
        keys: 'Ctrl+O',
        label: t('shortcuts.openFolder') || 'Open a folder',
        category: t('shortcuts.catEditor') || 'Editor',
      },
      {
        keys: 'Ctrl+N',
        label: t('shortcuts.newFile') || 'Create a new file',
        category: t('shortcuts.catEditor') || 'Editor',
      },
      {
        keys: 'Ctrl+B',
        label: t('shortcuts.toggleSidebar') || 'Toggle sidebar',
        category: t('shortcuts.catPanels') || 'Panels',
      },
      {
        keys: 'Ctrl+`',
        label: t('shortcuts.toggleTerminal') || 'Toggle terminal',
        category: t('shortcuts.catPanels') || 'Panels',
      },
      {
        keys: 'Ctrl+Shift+C',
        label: t('shortcuts.toggleChat') || 'Toggle chat',
        category: t('shortcuts.catPanels') || 'Panels',
      },
      {
        keys: 'Ctrl+1..9',
        label: t('shortcuts.switchTab') || 'Switch tab',
        category: t('shortcuts.catPanels') || 'Panels',
      },
    ],
    [t],
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return shortcuts;
    const q = query.toLowerCase();
    return shortcuts.filter(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        s.keys.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q),
    );
  }, [shortcuts, query]);

  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          variants={overlayFade}
          initial="hidden"
          animate="visible"
          exit="exit"
          className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh]"
          style={{ background: 'rgba(0,0,0,0.65)' }}
          onClick={onClose}
        >
          <motion.div
            variants={popIn}
            className="w-[min(620px,92vw)] overflow-hidden rounded-lg border border-border-default shadow-glow"
            style={{ background: 'var(--bg-primary)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
              <span className="text-base">⌨️</span>
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('shortcuts.searchPlaceholder') || 'Search shortcuts...'}
                className="w-full bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
              />
              <kbd className="rounded bg-bg-surface px-2 py-0.5 text-[10px] text-text-muted">
                esc
              </kbd>
            </div>
            <div className="max-h-[60vh] overflow-auto p-4 custom-scrollbar">
              {filtered.length === 0 ? (
                <div className="py-6 text-center text-xs text-text-muted">
                  {t('shortcuts.noResults') || 'No matching shortcuts.'}
                </div>
              ) : (
                <div className="grid gap-1.5">
                  {filtered.map((s, i) => (
                    <div
                      key={`${s.keys}-${i}`}
                      className="flex items-center justify-between gap-4 rounded px-3 py-2 hover:bg-bg-hover"
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm text-text-primary">{s.label}</span>
                        <span className="text-[10px] text-text-muted">{s.category}</span>
                      </div>
                      <kbd className="whitespace-nowrap rounded bg-bg-surface px-2 py-1 font-mono text-[11px] text-text-muted">
                        {s.keys}
                      </kbd>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
