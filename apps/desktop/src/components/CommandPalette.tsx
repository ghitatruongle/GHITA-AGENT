// VS Code-inspired fuzzy-search command palette

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { overlayFade, popIn } from '../lib/motion';
import { useTranslation } from '../i18n';
import { useAppStore, type TabId } from '../stores/appStore';

// Types

interface CommandAction {
  id: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  shortcut?: string;
  category: string;
  execute: () => void;
}

// Simple fuzzy match (substring + camelCase-aware)

function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  // camelCase-aware: match capital letter starts
  const camelParts = text.replace(/([A-Z])/g, ' $1').split(/\s+/);
  return camelParts.some((p) => p.toLowerCase().includes(q));
}

function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 90;
  if (t.includes(q)) return 70;
  const camelParts = text.replace(/([A-Z])/g, ' $1').split(/\s+/);
  const matched = camelParts.filter((p) => p.toLowerCase().includes(q));
  if (matched.length > 0) return 50;
  return 10;
}

// Main Component

export function CommandPalette() {
  const { t } = useTranslation();
  const isOpen = useAppStore((s) => s.commandPaletteOpen);
  const setIsOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const toggleChat = useAppStore((s) => s.toggleChat);
  const toggleTerminal = useAppStore((s) => s.toggleTerminal);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const isChatOpen = useAppStore((s) => s.isChatOpen);
  const isTerminalOpen = useAppStore((s) => s.isTerminalOpen);

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Build command list
  const commands = useBuildCommands({
    t,
    setActiveTab,
    toggleChat,
    toggleTerminal,
    toggleSidebar,
    setIsOpen,
    isChatOpen,
    isTerminalOpen,
  });

  // Filter
  const filtered = useFilteredCommands(commands, query);

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      setQuery('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsOpen(false);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) =>
          filtered.length === 0 ? 0 : prev >= filtered.length - 1 ? 0 : prev + 1,
        );
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) =>
          filtered.length === 0 ? 0 : prev <= 0 ? filtered.length - 1 : prev - 1,
        );
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = filtered[selectedIndex];
        if (item) {
          item.execute();
          setIsOpen(false);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [isOpen, filtered, selectedIndex, setIsOpen]);

  // Scroll selected into view
  useEffect(() => {
    if (listRef.current) {
      const active = listRef.current.children[selectedIndex] as HTMLElement | undefined;
      active?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        variants={overlayFade}
        initial="hidden"
        animate="visible"
        exit="exit"
        className="fixed inset-0 z-[9999] flex items-start justify-center pt-[15vh] px-4"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setIsOpen(false);
        }}
      >
        <motion.div
          variants={popIn}
          className="w-full max-w-[640px] bg-bg-elevated border border-border-subtle rounded-xl shadow-2xl overflow-hidden"
          role="dialog"
          aria-modal="true"
          aria-label={t('commandPalette.title')}
        >
          {/* Search Input */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
            <span className="text-accent-primary text-lg" aria-hidden="true">
              ⌘
            </span>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('commandPalette.searchPlaceholder')}
              className="flex-1 bg-transparent text-text-primary text-sm outline-none placeholder:text-text-muted"
              aria-label={t('commandPalette.searchLabel')}
            />
            <kbd className="text-[10px] text-text-muted bg-bg-surface px-2 py-0.5 rounded border border-border-subtle">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <div
            ref={listRef}
            className="max-h-[360px] overflow-y-auto py-2"
            role="listbox"
            aria-label={t('commandPalette.resultsLabel')}
          >
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-text-muted text-sm">
                {t('commandPalette.noResults')}
              </div>
            ) : (
              filtered.map((item, idx) => (
                <button
                  key={item.id}
                  role="option"
                  aria-selected={idx === selectedIndex}
                  onClick={() => {
                    item.execute();
                    setIsOpen(false);
                  }}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                    idx === selectedIndex
                      ? 'bg-bg-active text-text-primary'
                      : 'text-text-secondary hover:bg-bg-hover'
                  }`}
                >
                  {item.icon && (
                    <span className="w-5 h-5 flex items-center justify-center text-base">
                      {item.icon}
                    </span>
                  )}
                  <span className="flex-1 text-sm">{item.label}</span>
                  {item.shortcut && (
                    <kbd className="text-[10px] text-text-muted bg-bg-surface px-1.5 py-0.5 rounded border border-border-subtle">
                      {item.shortcut}
                    </kbd>
                  )}
                  <span className="text-[10px] text-text-muted opacity-60">{item.category}</span>
                </button>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center gap-4 px-4 py-2 border-t border-border-subtle text-[10px] text-text-muted">
            <span>↑↓ navigate</span>
            <span>↵ select</span>
            <span>esc close</span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// Hooks

function useBuildCommands({
  t,
  setActiveTab,
  toggleChat,
  toggleTerminal,
  toggleSidebar,
  setIsOpen,
  isChatOpen,
  isTerminalOpen,
}: {
  t: (key: string) => string;
  setActiveTab: (tab: TabId) => void;
  toggleChat: () => void;
  toggleTerminal: () => void;
  toggleSidebar: () => void;
  setIsOpen: (v: boolean) => void;
  isChatOpen: boolean;
  isTerminalOpen: boolean;
}): CommandAction[] {
  const goToTab = (tab: TabId) => () => {
    setActiveTab(tab);
    setIsOpen(false);
  };

  return [
    {
      id: 'nav-code',
      label: t('commandPalette.navCode') || 'Go to Code',
      description: 'Open the code editor',
      category: 'Navigation',
      icon: <span>💻</span>,
      shortcut: 'Ctrl+B',
      execute: goToTab('code'),
    },
    {
      id: 'nav-api',
      label: t('commandPalette.navApi') || 'Go to API Settings',
      description: 'Manage API keys and providers',
      category: 'Navigation',
      icon: <span>🔑</span>,
      shortcut: '',
      execute: goToTab('api'),
    },
    {
      id: 'nav-skills',
      label: t('commandPalette.navSkills') || 'Go to Skills',
      description: 'Browse and manage skills',
      category: 'Navigation',
      icon: <span>⚡</span>,
      shortcut: '',
      execute: goToTab('skills'),
    },
    {
      id: 'nav-agents',
      label: t('commandPalette.navAgents') || 'Go to Agents',
      description: 'Manage agent groups',
      category: 'Navigation',
      icon: <span>👥</span>,
      shortcut: '',
      execute: goToTab('agents'),
    },
    {
      id: 'nav-dashboard',
      label: t('commandPalette.navDashboard') || 'Go to Dashboard',
      description: 'View system overview',
      category: 'Navigation',
      icon: <span>📊</span>,
      shortcut: '',
      execute: goToTab('dashboard'),
    },
    {
      id: 'nav-settings',
      label: t('commandPalette.navSettings') || 'Go to Settings',
      description: 'Open settings panel',
      category: 'Navigation',
      icon: <span>⚙️</span>,
      shortcut: 'Ctrl+,',
      execute: goToTab('settings'),
    },
    {
      id: 'action-toggle-terminal',
      label: isTerminalOpen ? t('commandPalette.terminalClose') : t('commandPalette.terminalOpen'),
      description: 'Toggle the terminal panel',
      category: 'Actions',
      icon: <span>🖥️</span>,
      shortcut: 'Ctrl+`',
      execute: () => {
        toggleTerminal();
        setIsOpen(false);
      },
    },
    {
      id: 'action-toggle-chat',
      label: isChatOpen ? t('commandPalette.chatClose') : t('commandPalette.chatOpen'),
      description: 'Toggle the chat sidebar',
      category: 'Actions',
      icon: <span>💬</span>,
      shortcut: 'Ctrl+Shift+C',
      execute: () => {
        toggleChat();
        setIsOpen(false);
      },
    },
    {
      id: 'action-toggle-sidebar',
      label: t('commandPalette.sidebarToggle'),
      description: 'Toggle the explorer sidebar',
      category: 'Actions',
      icon: <span>📁</span>,
      shortcut: 'Ctrl+B',
      execute: () => {
        toggleSidebar();
        setIsOpen(false);
      },
    },
  ];
}

function useFilteredCommands(commands: CommandAction[], query: string): CommandAction[] {
  if (!query.trim()) return commands;
  return commands
    .filter((c) => fuzzyMatch(query, c.label) || fuzzyMatch(query, c.category))
    .sort((a, b) => {
      const scoreA = fuzzyScore(query, a.label);
      const scoreB = fuzzyScore(query, b.label);
      return scoreB - scoreA;
    });
}
