// VS Code-inspired fuzzy file picker over open tabs + recently opened files.
// Opens the selected file in the Code tab and rehydrates its content from disk
// if its buffer was evicted by the LRU cache.

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { overlayFade, popIn } from '../lib/motion';
import { useTranslation } from '../i18n';
import { useAppStore } from '../stores/appStore';
import { fsReadText } from '../lib/native-fs';
import { fileContentCache } from '../stores/appStore';
import { useEditProposalStore } from '../stores/editProposalStore';

/** Fuzzy match: substring, path-segment, and acronym aware. */
function fuzzyScore(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900;
  // basename match is more relevant than full path
  const base = t.split(/[/\\]/).pop() ?? t;
  if (base === q) return 850;
  if (base.startsWith(q)) return 800;
  if (base.includes(q)) return 700;
  if (t.includes(q)) return 600;
  // acronym match (e.g. "sht" → "src/hooks/theme.ts")
  const acronym = (text.match(/[A-Z]?[a-z]+/g) ?? []).join('').toLowerCase();
  if (acronym.includes(q)) return 400;
  // subsequence match
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length ? 200 : 0;
}

interface QuickFileOpenProps {
  open: boolean;
  onClose: () => void;
}

export function QuickFileOpen({ open, onClose }: QuickFileOpenProps) {
  const { t } = useTranslation();
  const openFiles = useAppStore((s) => s.codeOpenFiles);
  const recentFiles = useAppStore((s) => s.recentFiles);
  const setActivePath = useAppStore((s) => s.setCodeActivePath);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const addRecentFile = useAppStore((s) => s.addRecentFile);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Build the candidate list: open tabs first, then recent files not already listed.
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const items: Array<{ path: string; name: string; isOpen: boolean; recentIdx: number }> = [];
    for (const f of openFiles) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      items.push({ path: f.path, name: f.name, isOpen: true, recentIdx: -1 });
    }
    recentFiles.forEach((p, i) => {
      if (seen.has(p)) return;
      seen.add(p);
      const name = p.split(/[/\\]/).pop() ?? p;
      items.push({ path: p, name, isOpen: false, recentIdx: i });
    });
    return items;
  }, [openFiles, recentFiles]);

  const filtered = useMemo(() => {
    if (!query.trim()) {
      return candidates.slice(0, 25).map((c) => ({ ...c, score: 0 }));
    }
    return candidates
      .map((c) => ({ ...c, score: fuzzyScore(query, c.path) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 25);
  }, [candidates, query]);

  // Reset selection when results change.
  useEffect(() => {
    setSelected(0);
  }, [filtered]);

  // Focus input on open.
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // global Ctrl+Shift+P/O listener. App.tsx owns the shortcut and toggles
  // `open`; a second capture-phase listener here fired before the parent's
  // toggle and re-closed the modal the instant it opened, making it
  // impossible to close via keyboard.

  const select = (path: string, isOpen: boolean) => {
    setActiveTab('code');
    addRecentFile(path);
    if (isOpen) {
      setActivePath(path);
    } else {
      // Rehydrate the recent file from disk, then open it.
      void (async () => {
        try {
          const { content, encoding, isTruncated, isBinary } = await fsReadText(path);
          if (isBinary) return;
          fileContentCache.set(path, {
            content,
            originalContent: content,
            encoding,
            hydrated: true,
            isTruncated,
          });
          const name = path.split(/[/\\]/).pop() ?? path;
          const openFilesNow = useAppStore.getState().codeOpenFiles;
          if (!openFilesNow.some((f) => f.path === path)) {
            useAppStore
              .getState()
              .setCodeOpenFiles([...openFilesNow, { path, name, language: '', modified: false }]);
          }
          setActivePath(path);
        } catch {
          /* File disappeared — ignore. */
        }
      })();
    }
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter' && filtered[selected]) {
      e.preventDefault();
      select(filtered[selected].path, filtered[selected].isOpen);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          variants={overlayFade}
          initial="hidden"
          animate="visible"
          exit="exit"
          className="fixed inset-0 z-[60] flex items-start justify-center pt-[18vh]"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={onClose}
        >
          <motion.div
            variants={popIn}
            className="w-[min(560px,90vw)] overflow-hidden rounded-lg border border-border-default shadow-glow"
            style={{ background: 'var(--bg-primary)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t('codeView.quickFilePlaceholder') || 'Search open and recent files...'}
              className="w-full border-b border-border-subtle bg-transparent px-4 py-3 text-sm text-text-primary outline-none placeholder:text-text-muted"
              aria-label="Quick file open"
            />
            <div className="max-h-[50vh] overflow-auto custom-scrollbar">
              {filtered.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-text-muted">
                  {t('codeView.quickFileNoResults') || 'No matching files.'}
                </div>
              ) : (
                filtered.map((c, i) => (
                  <button
                    key={c.path}
                    onClick={() => select(c.path, c.isOpen)}
                    onMouseEnter={() => setSelected(i)}
                    className="flex w-full items-center gap-3 border-b border-border-subtle/40 px-4 py-2 text-left transition-colors"
                    style={{
                      background: i === selected ? 'var(--bg-hover)' : 'transparent',
                    }}
                  >
                    <span className="text-base">{c.isOpen ? '📄' : '🕗'}</span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium text-text-primary">
                        {c.name}
                      </span>
                      <span
                        className="truncate font-mono text-[11px] text-text-muted"
                        title={c.path}
                      >
                        {c.path}
                      </span>
                    </div>
                    {c.isOpen && (
                      <span className="rounded bg-bg-surface px-1.5 py-0.5 text-[10px] text-text-muted">
                        {t('codeView.quickFileOpen') || 'open'}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
            <div className="flex items-center gap-3 border-t border-border-subtle px-4 py-2 text-[10px] text-text-muted">
              <span>↑↓ {t('codeView.quickFileNav') || 'navigate'}</span>
              <span>↵ {t('codeView.quickFileSelect') || 'open'}</span>
              <span>esc {t('codeView.quickFileClose') || 'close'}</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Reset the Antigravity proposal queue on user request (exposed for menus). */
export function _resetProposalQueueForTests() {
  useEditProposalStore.getState().clear();
}
