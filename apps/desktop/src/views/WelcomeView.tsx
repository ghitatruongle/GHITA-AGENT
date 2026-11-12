// Shown when no workspace is open; provides Open Folder + recent workspaces

import { useCallback, useState } from 'react';
import { motion } from 'framer-motion';
import { FolderOpen, Clock, Settings, Terminal } from 'lucide-react';
import { BlurText, ShinyText } from '../components/fx';
import { fadeIn, fadeUp, listContainer, listItem } from '../lib/motion';
import { useTranslation } from '../i18n';
import { useAppStore } from '../stores/appStore';
import { open } from '@tauri-apps/plugin-dialog';

export function WelcomeView() {
  const { t } = useTranslation();
  const recentWorkspaces = useAppStore((s) => s.recentWorkspaces);
  const addRecentWorkspace = useAppStore((s) => s.addRecentWorkspace);
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const setTerminalCwd = useAppStore((s) => s.setTerminalCwd);
  const setShowWelcome = useAppStore((s) => s.setShowWelcome);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  const [isOpening, setIsOpening] = useState(false);

  const handleOpenFolder = useCallback(async () => {
    setIsOpening(true);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('welcome.openFolder'),
      });
      if (selected && typeof selected === 'string') {
        addRecentWorkspace(selected);
        setActiveWorkspace(selected);
        setTerminalCwd(selected);
        setShowWelcome(false);
        setActiveTab('code');
      }
    } catch (e) {
      console.error('[WelcomeView] Failed to open folder:', e);
    } finally {
      setIsOpening(false);
    }
  }, [t, addRecentWorkspace, setActiveWorkspace, setTerminalCwd, setShowWelcome, setActiveTab]);

  const handleOpenRecent = useCallback(
    (path: string) => {
      addRecentWorkspace(path);
      setActiveWorkspace(path);
      setTerminalCwd(path);
      setShowWelcome(false);
      setActiveTab('code');
    },
    [addRecentWorkspace, setActiveWorkspace, setTerminalCwd, setShowWelcome, setActiveTab],
  );

  const handleOpenSettings = useCallback(() => {
    setActiveTab('settings');
    setShowWelcome(false);
  }, [setActiveTab, setShowWelcome]);

  return (
    <motion.div
      variants={listContainer}
      initial="hidden"
      animate="visible"
      className="flex flex-col items-center justify-center h-full px-8 py-12 overflow-auto"
    >
      {/* Hero */}
      <div className="text-center mb-10">
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.1, duration: 0.5 }}
          className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-indigo-500/20 mb-6"
        >
          <span className="text-4xl">⚡</span>
        </motion.div>
        {/* fx: BlurText (react-bits) — word-by-word blur reveal; each word
            carries its own accent gradient so background-clip:text works
            while the spans animate. */}
        <BlurText
          as="h1"
          text={t('welcome.title')}
          animateBy="words"
          delay={80}
          startOnMount
          className="text-3xl font-bold mb-3"
          style={{ justifyContent: 'center' }}
          spanStyle={{
            background: 'var(--accent-gradient)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
        />
        <p className="text-sm max-w-md mx-auto leading-relaxed">
          {/* fx: ShinyText (react-bits) — slow theme-aware shine sweep. */}
          <ShinyText text={t('welcome.subtitle')} speed={5} delay={3} />
        </p>
      </div>

      {/* Primary actions */}
      <motion.div variants={fadeUp} className="flex flex-wrap items-center justify-center gap-3 mb-8">
        <button
          onClick={handleOpenFolder}
          disabled={isOpening}
          className="flex items-center gap-2.5 px-6 py-3 bg-indigo-500/15 border border-indigo-500/30 text-indigo-200 rounded-lg hover:bg-indigo-500/25 transition-colors font-semibold text-sm shadow-md"
        >
          <FolderOpen size={18} />
          {isOpening ? t('common.loading') : t('welcome.openFolder')}
        </button>

        <button
          onClick={handleOpenSettings}
          className="flex items-center gap-2.5 px-6 py-3 bg-bg-surface border border-border-default text-text-primary rounded-lg hover:bg-bg-hover transition-colors font-semibold text-sm"
        >
          <Settings size={18} className="text-accent-primary" />
          {t('settings.title')}
        </button>
      </motion.div>

      {/* Recent workspaces */}
      {recentWorkspaces.length > 0 ? (
        <motion.div variants={fadeUp} className="w-full max-w-lg mb-8">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3 flex items-center gap-2">
            <Clock size={12} />
            {t('welcome.recentWorkspaces')}
          </h3>
          <motion.div variants={listContainer} className="flex flex-col gap-1">
            {recentWorkspaces.map((path) => (
              <motion.button
                key={path}
                variants={listItem}
                onClick={() => handleOpenRecent(path)}
                className="flex items-center gap-3 px-4 py-2.5 rounded-lg hover:bg-bg-hover transition-colors text-left group"
              >
                <FolderOpen
                  size={16}
                  className="text-text-muted shrink-0 group-hover:text-accent-primary transition-colors"
                />
                <span className="text-sm text-text-secondary truncate flex-1">{path}</span>
                <span className="text-[10px] text-text-muted opacity-0 group-hover:opacity-100 transition-opacity">
                  Open →
                </span>
              </motion.button>
            ))}
          </motion.div>
        </motion.div>
      ) : (
        <motion.div variants={fadeUp} className="w-full max-w-lg mb-8">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3 flex items-center gap-2">
            <Clock size={12} />
            {t('welcome.recentWorkspaces')}
          </h3>
          <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-bg-hover/50">
            <FolderOpen size={16} className="text-text-muted" />
            <span className="text-sm text-text-muted">{t('welcome.noRecentWorkspaces')}</span>
          </div>
        </motion.div>
      )}

      {/* Quick tips */}
      <motion.div variants={fadeUp} className="w-full max-w-lg">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3 flex items-center gap-2">
          <Terminal size={12} />
          {t('welcome.shortcuts')}
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {[
            { key: 'Ctrl+O', label: t('welcome.shortcutOpenFolder') },
            { key: 'Ctrl+P', label: t('welcome.shortcutCommandPalette') },
            { key: 'Ctrl+`', label: t('welcome.shortcutToggleTerminal') },
            { key: 'Ctrl+Shift+C', label: t('welcome.shortcutToggleChat') },
            { key: 'Ctrl+S', label: t('welcome.shortcutSaveFile') },
            { key: '', label: t('welcome.learnMore') },
          ].map((item) => (
            <div
              key={item.key || item.label}
              className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-surface/50"
            >
              {item.key && (
                <kbd className="text-[10px] bg-bg-tertiary px-2 py-0.5 rounded border border-border-subtle text-text-muted font-mono">
                  {item.key}
                </kbd>
              )}
              <span className="text-xs text-text-muted">{item.label}</span>
            </div>
          ))}
        </div>
      </motion.div>

      {/* Settings link */}
      <motion.div variants={fadeIn} className="mt-8">
        <button
          onClick={handleOpenSettings}
          className="flex items-center gap-2 text-xs text-text-muted hover:text-accent-primary transition-colors"
        >
          <Settings size={14} />
          {t('welcome.learnMore')}
        </button>
      </motion.div>
    </motion.div>
  );
}
