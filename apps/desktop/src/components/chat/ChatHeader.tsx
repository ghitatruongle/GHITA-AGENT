// Connection status, session controls, and model selector.

import React from 'react';
import { useAppStore } from '../../stores/appStore';
import toast from 'react-hot-toast';
import { type DynamicModelOption } from '../../utils/buildModelOptions';
import { type ProviderId, PROVIDER_LABELS } from '../../types/providers';
import type { ChatMessage } from '../../hooks/useChatSessions';

interface ChatHeaderProps {
  t: (key: string, params?: Record<string, string | number>) => string;
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
  currentView: 'chat' | 'history';
  setCurrentView: React.Dispatch<React.SetStateAction<'chat' | 'history'>>;
  handleCreateSession: () => void;
  handleReconnect: () => void;
  // v1.0.0 — chat export to Markdown
  messages: ChatMessage[];
  // Model selector
  modelOptions: DynamicModelOption[];
  provider: string;
  setProvider: (v: string) => void;
  modelDropdownOpen: boolean;
  setModelDropdownOpen: (v: boolean) => void;
  modelSearch: string;
  setModelSearch: (v: string) => void;
}

export function ChatHeader({
  t,
  connectionStatus,
  currentView,
  setCurrentView,
  handleCreateSession,
  handleReconnect,
  messages,
  modelOptions,
  provider,
  setProvider,
  modelDropdownOpen,
  setModelDropdownOpen,
  modelSearch,
  setModelSearch,
}: ChatHeaderProps) {
  return (
    <div
      style={{
        padding: '14px 16px',
        borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'rgba(30, 41, 59, 0.4)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '16px' }}>💬</span>
        <span
          style={{
            fontWeight: 700,
            fontSize: '13px',
            letterSpacing: '0.5px',
            background: 'linear-gradient(135deg, #a5b4fc 0%, #818cf8 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
        >
          {t('chat.openclawEngine')}
        </span>
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            backgroundColor: connectionStatus === 'connected' ? '#10b981' : '#f59e0b',
            boxShadow: connectionStatus === 'connected' ? '0 0 8px #10b981' : 'none',
            marginLeft: '4px',
          }}
          title={connectionStatus === 'connected' ? 'Connected' : 'Offline'}
        />
        {connectionStatus !== 'connected' && (
          <button
            onClick={handleReconnect}
            disabled={connectionStatus === 'connecting'}
            style={{
              marginLeft: '8px',
              padding: '2px 8px',
              fontSize: '10px',
              fontWeight: 600,
              backgroundColor:
                connectionStatus === 'connecting'
                  ? 'rgba(255, 255, 255, 0.05)'
                  : 'rgba(245, 158, 11, 0.15)',
              border:
                connectionStatus === 'connecting'
                  ? '1px solid rgba(255, 255, 255, 0.1)'
                  : '1px solid rgba(245, 158, 11, 0.3)',
              borderRadius: '4px',
              color: connectionStatus === 'connecting' ? '#94a3b8' : '#f59e0b',
              cursor: connectionStatus === 'connecting' ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s',
            }}
          >
            {connectionStatus === 'connecting' ? t('chat.connecting') : t('chat.reconnect')}
          </button>
        )}

        {/* Session History & New Session Buttons */}
        <div style={{ display: 'flex', gap: '4px', marginLeft: '8px' }}>
          <button
            onClick={() => setCurrentView((v) => (v === 'chat' ? 'history' : 'chat'))}
            title={t('chat.chatHistory')}
            style={{
              background: currentView === 'history' ? 'rgba(99, 102, 241, 0.2)' : 'transparent',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '6px',
              width: '24px',
              height: '24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              fontSize: '12px',
              color: currentView === 'history' ? '#a5b4fc' : '#94a3b8',
              transition: 'all 0.2s',
            }}
          >
            📂
          </button>
          <button
            onClick={handleCreateSession}
            title={t('chat.newChat')}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '6px',
              width: '24px',
              height: '24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              fontSize: '12px',
              color: '#94a3b8',
              transition: 'all 0.2s',
            }}
          >
            ➕
          </button>
          {/* v1.0.0 — Export chat to Markdown */}
          <button
            onClick={() => {
              if (messages.length === 0) return;
              const md = messages
                .map((m) => {
                  const who = m.role === 'user' ? '**You**' : '**GHITA**';
                  const ts = m.timestamp
                    ? `\n<small>${new Date(m.timestamp).toLocaleString()}</small>`
                    : '';
                  return `## ${who}${ts}\n\n${m.content}`;
                })
                .join('\n\n---\n\n');
              const blob = new Blob([`# Ghita Agent — Chat Export\n\n${md}`], {
                type: 'text/markdown',
              });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `ghita-chat-${new Date().toISOString().slice(0, 10)}.md`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            title={t('chat.exportChat') || 'Export chat to Markdown'}
            disabled={messages.length === 0}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '6px',
              width: '24px',
              height: '24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: messages.length === 0 ? 'default' : 'pointer',
              fontSize: '12px',
              color: messages.length === 0 ? '#475569' : '#94a3b8',
              transition: 'all 0.2s',
              opacity: messages.length === 0 ? 0.5 : 1,
            }}
          >
            📥
          </button>
        </div>
      </div>

      {/* Model Selector - Custom Searchable Dropdown */}
      <div style={{ position: 'relative' }} data-model-dropdown>
        <button
          onClick={() => {
            if (modelOptions.length > 0) {
              setModelDropdownOpen(!modelDropdownOpen);
              setModelSearch('');
            } else {
              useAppStore.getState().setActiveTab('api');
              toast(t('chat.noProviderHint') || 'Vui lòng cấu hình API Key để bắt đầu', {
                icon: '⚙️',
                duration: 3500,
              });
            }
          }}
          title={modelOptions.length === 0 ? 'Click để mở Quản lý API Key' : 'Chọn AI Model'}
          style={{
            padding: '4px 10px',
            fontSize: '11px',
            background: 'rgba(15, 23, 42, 0.6)',
            border:
              modelOptions.length === 0
                ? '1px solid rgba(239, 68, 68, 0.5)'
                : '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '6px',
            color: modelOptions.length === 0 ? '#f87171' : '#cbd5e1',
            cursor: 'pointer',
            maxWidth: '220px',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            transition: 'border 0.2s',
          }}
        >
          {modelOptions.length === 0
            ? `⚠️ ${t('chat.noConfig')}`
            : modelOptions.find((o) => o.value === provider)?.label || provider}
          <span
            style={{
              fontSize: '8px',
              marginLeft: '2px',
              transform: modelDropdownOpen ? 'rotate(180deg)' : 'none',
              transition: 'transform 0.2s',
            }}
          >
            ▼
          </span>
        </button>

        {modelDropdownOpen && modelOptions.length > 0 && (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              right: 0,
              marginTop: '4px',
              width: '280px',
              maxHeight: '320px',
              background: 'rgba(15, 23, 42, 0.95)',
              backdropFilter: 'blur(20px)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: '8px',
              zIndex: 1000,
              overflow: 'hidden',
              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
            }}
          >
            {/* Search input */}
            <div style={{ padding: '8px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              <input
                autoFocus
                type="text"
                placeholder={t('chat.searchModel')}
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                style={{
                  width: '100%',
                  padding: '6px 10px',
                  fontSize: '12px',
                  background: 'rgba(30, 41, 59, 0.8)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '4px',
                  color: '#e2e8f0',
                  // ACCESSIBILITY (audit fix 1.3): removed outline:none;
                  // focus-ring class in globals.css handles focus indicator
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Grouped model list */}
            <div style={{ maxHeight: '260px', overflowY: 'auto', padding: '4px' }}>
              {(() => {
                const q = modelSearch.toLowerCase().trim();
                const filtered = q
                  ? modelOptions.filter(
                      (o) => o.label.toLowerCase().includes(q) || o.model.toLowerCase().includes(q),
                    )
                  : modelOptions;

                const groups = new Map<string, DynamicModelOption[]>();
                for (const opt of filtered) {
                  if (!groups.has(opt.providerId)) groups.set(opt.providerId, []);
                  groups.get(opt.providerId)?.push(opt);
                }

                return [...groups.entries()].map(([pid, opts]) => {
                  const meta = PROVIDER_LABELS[pid as ProviderId] || {
                    name: pid,
                    icon: '\uD83D\uDD37',
                  };
                  return (
                    <div key={pid}>
                      <div
                        style={{
                          fontSize: '10px',
                          fontWeight: 700,
                          color: '#64748b',
                          padding: '6px 8px 2px',
                          textTransform: 'uppercase',
                          letterSpacing: '0.5px',
                        }}
                      >
                        {meta.icon} {meta.name}
                      </div>
                      {opts.map((opt) => (
                        <div
                          key={opt.value}
                          onClick={() => {
                            setProvider(opt.value);
                            setModelDropdownOpen(false);
                            setModelSearch('');
                          }}
                          style={{
                            padding: '6px 10px',
                            fontSize: '12px',
                            color: '#e2e8f0',
                            cursor: 'pointer',
                            borderRadius: '4px',
                            background:
                              opt.value === provider ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
                            borderLeft:
                              opt.value === provider
                                ? '2px solid #818cf8'
                                : '2px solid transparent',
                            transition: 'background 0.15s',
                          }}
                        >
                          {opt.model}
                        </div>
                      ))}
                    </div>
                  );
                });
              })()}
              {modelSearch &&
                modelOptions.filter(
                  (o) =>
                    o.label.toLowerCase().includes(modelSearch.toLowerCase()) ||
                    o.model.toLowerCase().includes(modelSearch.toLowerCase()),
                ).length === 0 && (
                  <div
                    style={{
                      padding: '12px',
                      textAlign: 'center',
                      color: '#64748b',
                      fontSize: '12px',
                    }}
                  >
                    {t('chat.noModelFound')}
                  </div>
                )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
