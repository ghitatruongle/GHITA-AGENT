// Handles message sending, slash commands, and agent mode routing.

import { useState } from 'react';
import type { Socket } from 'socket.io-client';
import { generateUUID } from '@ghita/shared';
import { useAppStore } from '../../stores/appStore';
import { loadApiConfig } from '../../utils/apiConfig';
import type { DynamicModelOption } from '../../utils/buildModelOptions';
import type { ChatMessage } from '../../hooks/useChatSessions';

interface UseChatSendConfig {
  socketRef: React.MutableRefObject<Socket | null>;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
  modelOptions: DynamicModelOption[];
  provider: string;

  // (or Enter while the send button is disabled) emitted two identical
  // requests, double-billing and double-running tools.
  isSending: boolean;
  setIsSending: (v: boolean) => void;
  setActiveFlow: (v: 'ralph' | 'agent' | null) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export function useChatSend({
  socketRef,
  messages,
  setMessages,
  connectionStatus,
  modelOptions,
  provider,
  isSending,
  setIsSending,
  setActiveFlow,
  t,
}: UseChatSendConfig) {
  const [input, setInput] = useState('');
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashCommands] = useState<Array<{ trigger: string; name: string; description: string }>>([
    { trigger: '/compact', name: 'Compact Context', description: t('chat.compactContext') },
    { trigger: '/clear', name: 'Clear Chat', description: t('chat.clearChat') },
    { trigger: '/help', name: 'Help', description: t('chat.help') },
    { trigger: '/code-review', name: 'Code Review', description: t('chat.codeReview') },
    { trigger: '/feature-dev', name: 'Feature Dev', description: t('chat.featureDev') },
    { trigger: '/deploy-check', name: 'Deploy Check', description: t('chat.deployCheck') },
    { trigger: '/grill-me', name: 'Grill Me', description: 'Socratic docs-aware design interview' },
  ]);
  const [filteredSlashCmds, setFilteredSlashCmds] = useState<typeof slashCommands>([]);

  const [agentRole, setAgentRole] = useState<'Explore' | 'Plan' | 'UI' | 'default'>('default');
  const [ralphMode, setRalphMode] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [reviewMode, setReviewMode] = useState(false);
  const [featureMode, setFeatureMode] = useState(false);
  const [activeFlowLocal, setActiveFlowLocal] = useState<'ralph' | 'agent' | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const permissionMode = useAppStore((s) => s.permissionMode);
  const setPermissionMode = useAppStore((s) => s.setPermissionMode);
  const terminalCwd = useAppStore((s) => s.terminalCwd);

  const handleInputChange = (value: string) => {
    setInput(value);
    if (value.startsWith('/')) {
      const filtered = slashCommands.filter((c) => c.trigger.startsWith(value));
      setFilteredSlashCmds(filtered);
      setShowSlashMenu(filtered.length > 0 && value.length > 0);
    } else {
      setShowSlashMenu(false);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (blob) {
          const reader = new FileReader();
          reader.onload = () => setAttachedImage(reader.result as string);
          reader.readAsDataURL(blob);
        }
      }
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => setAttachedImage(reader.result as string);
        reader.readAsDataURL(file);
      }
    }
  };

  const resetComposer = () => {
    setInput('');
    setAttachedImage(null);
    setShowSlashMenu(false);
  };

  const appendLocalExchange = (userContent: string, assistantContent: string) => {
    setMessages((prev) => [
      ...prev,
      { id: generateUUID(), role: 'user', content: userContent, timestamp: Date.now() },
      { id: generateUUID(), role: 'assistant', content: assistantContent, timestamp: Date.now() },
    ]);
  };

  const handleSend = async () => {
    if (isSending) return;
    const trimmedInput = input.trim();
    if (!trimmedInput) return;

    // Slash commands
    if (/^\/clear\b/i.test(trimmedInput)) {
      setMessages([]);
      resetComposer();
      return;
    }

    if (/^\/help\b/i.test(trimmedInput)) {
      appendLocalExchange(
        trimmedInput,
        [
          '**Chat commands**',
          '- `/clear`: clear the current conversation.',
          '- `/compact`: keep the latest context and remove older messages from this chat view.',
          '- `/code-review <task>`: run the agent in review mode.',
          '- `/feature-dev <task>`: run the agent in feature mode.',
          '- `/deploy-check <task>`: run the agent against release/deploy readiness.',
        ].join('\n'),
      );
      resetComposer();
      return;
    }

    if (/^\/compact\b/i.test(trimmedInput)) {
      setMessages((prev) => {
        const kept = prev.filter((msg) => msg.id !== 'streaming-message').slice(-8);
        return [
          ...kept,
          {
            id: generateUUID(),
            role: 'assistant',
            content: `✅ ${t('chat.compactSuccess')}`,
            timestamp: Date.now(),
          },
        ];
      });
      resetComposer();
      return;
    }

    let outgoingInput = trimmedInput;
    let forcedAgentMode: 'review' | 'feature' | 'deploy' | 'grill' | null = null;
    const slashMatch = trimmedInput.match(
      /^\/(code-review|feature-dev|deploy-check|grill-me)\b\s*(.*)$/i,
    );
    if (slashMatch) {
      const command = (slashMatch[1] ?? '').toLowerCase();
      const task = (slashMatch[2] ?? '').trim();
      forcedAgentMode =
        command === 'code-review'
          ? 'review'
          : command === 'feature-dev'
            ? 'feature'
            : command === 'deploy-check'
              ? 'deploy'
              : 'grill';

      if (!task) {
        if (forcedAgentMode === 'review') {
          setReviewMode(true);
          setFeatureMode(false);
          setAgentMode(false);
          setRalphMode(false);
        } else if (forcedAgentMode === 'feature') {
          setFeatureMode(true);
          setReviewMode(false);
          setAgentMode(false);
          setRalphMode(false);
        } else {
          setAgentMode(true);
          setReviewMode(false);
          setFeatureMode(false);
          setRalphMode(false);
        }
        appendLocalExchange(
          trimmedInput,
          '✅ Đã bật mode tương ứng. Nhập yêu cầu tiếp theo để chạy.',
        );
        resetComposer();
        return;
      }

      outgoingInput = task;
    }

    // Guard: not connected
    if (!socketRef.current || connectionStatus !== 'connected') {
      appendLocalExchange(
        outgoingInput,
        `⚠️ **${t('chat.notConnected')}**\n\n${t('chat.notConnectedHint')}`,
      );
      resetComposer();
      return;
    }

    // Guard: no API keys configured
    if (modelOptions.length === 0) {
      appendLocalExchange(
        outgoingInput,
        `⚙️ **${t('chat.noProvider')}**\n\n${t('chat.noProviderHint')}`,
      );
      resetComposer();
      return;
    }

    // Auto-detect agent mode
    const agentPattern =
      /(đọc|xem|phân tích|quét|tìm|tổng quan|sửa|tạo|read|show|list|explain|analyze|explore|overview|fix|refactor|implement|create|write).*(code|file|tệp|thư mục|folder|dự\s*u?\s*án|project|workspace|codebase)/i;
    const isLongEnoughForAgent = outgoingInput.length > 10;
    const shouldUseAgent =
      forcedAgentMode !== null ||
      agentMode ||
      reviewMode ||
      featureMode ||
      (terminalCwd && isLongEnoughForAgent && agentPattern.test(outgoingInput));
    const shouldUseRalph = ralphMode && forcedAgentMode === null;

    if ((shouldUseRalph || shouldUseAgent) && !terminalCwd) {
      appendLocalExchange(outgoingInput, `⚠️ **${t('chat.noWorkspace')}**`);
      resetComposer();
      return;
    }

    const userMsg: ChatMessage = {
      id: generateUUID(),
      role: 'user',
      content: outgoingInput,
      timestamp: Date.now(),
      ...(attachedImage ? { imageAttachment: attachedImage } : {}),
    };

    setMessages((prev) => [...prev, userMsg]);
    setIsSending(true);

    // Prefix task with mode instruction
    let agentTask = outgoingInput;
    if (forcedAgentMode === 'review' || reviewMode) {
      agentTask = `[CODE REVIEW MODE] Review the following code/project and provide detailed feedback on bugs, security issues, performance, and best practices:\n\n${outgoingInput}`;
    } else if (forcedAgentMode === 'feature' || featureMode) {
      agentTask = `[FEATURE DEVELOPMENT MODE] Implement the following feature. Read the project structure first, then write the code:\n\n${outgoingInput}`;
    } else if (forcedAgentMode === 'deploy') {
      agentTask = `[DEPLOY CHECK MODE] Check build, runtime, configuration, and deployment readiness. Report concrete blockers and fixes:\n\n${outgoingInput}`;
    } else if (forcedAgentMode === 'grill') {
      agentTask = `[DOCS GRILL MODE] Ask sharp project-aware questions, identify missing assumptions, and propose next steps:\n\n${outgoingInput}`;
    }

    if (shouldUseRalph) {
      socketRef.current.emit('ralph_loop_run', {
        task: outgoingInput,
        maxIterations: 3,
        costLimitUsd: 0.15,

        // use it; previously the image was only rendered locally and silently
        // dropped from every payload.
        ...(attachedImage ? { image: attachedImage } : {}),
      });
      setActiveFlow('ralph');
      setActiveFlowLocal('ralph');
    } else if (shouldUseAgent) {
      socketRef.current.emit('set_workspace', { path: terminalCwd });

      const slashIdx = provider.indexOf('/');
      const selectedProvider = slashIdx > 0 ? provider.substring(0, slashIdx) : provider;
      const selectedModel = slashIdx > 0 ? provider.substring(slashIdx + 1) : undefined;

      let providerBaseUrl: string | undefined;
      try {
        const parsed = await loadApiConfig();
        const entry = parsed[selectedProvider];
        if (entry) {
          providerBaseUrl = (entry['baseUrl'] as string) || undefined;
        }
      } catch {
        // ignore
      }

      socketRef.current.emit('agent_run', {
        task: agentTask,
        maxIterations: 10,
        provider: selectedProvider,
        model: selectedModel,
        baseUrl: providerBaseUrl,
        permissionMode,

        ...(attachedImage ? { image: attachedImage } : {}),
      });
      setActiveFlow('agent');
      setActiveFlowLocal('agent');
    } else {
      // Regular chat
      const projectContext = terminalCwd
        ? `\n\nThe user's current working directory is: ${terminalCwd}. This is where the user is working. When the user asks "what project am I working on", tell them this path and extract the project name from it. The last folder in the path is typically the project name.`
        : '';
      const safeSystemPrompt = [
        'You are GHITA Assistant, an AI coding assistant inside the Ghita Agent desktop app.',
        'You may suggest shell commands in fenced code blocks, but the app will not run them automatically.',
        'Ask for explicit user confirmation before commands that modify files, install packages, delete data, access secrets, or change system state.',
        'Answer concisely and directly.',
      ].join('\n\n');
      const history = [
        { role: 'system' as const, content: safeSystemPrompt + projectContext },
        ...messages
          .filter((msg) => msg.id !== 'streaming-message')
          .slice(-10)
          .map((msg) => ({ role: msg.role, content: msg.content })),
      ];

      const slashIdx = provider.indexOf('/');
      const selectedProvider = slashIdx > 0 ? provider.substring(0, slashIdx) : provider;
      const selectedModel = slashIdx > 0 ? provider.substring(slashIdx + 1) : undefined;

      let providerBaseUrl: string | undefined;
      try {
        const parsed = await loadApiConfig();
        const entry = parsed[selectedProvider];
        if (entry) {
          providerBaseUrl = (entry['baseUrl'] as string) || undefined;
        }
      } catch {
        // ignore
      }

      socketRef.current.emit('chat', {
        text: outgoingInput,
        isDesktop: true,
        provider: selectedProvider,
        model: selectedModel,
        agentRole: agentRole,
        history: [...history, { role: 'user', content: outgoingInput }],
        baseUrl: providerBaseUrl,

        ...(attachedImage ? { image: attachedImage } : {}),
      });
    }

    resetComposer();
  };

  return {
    input,
    setInput,
    attachedImage,
    setAttachedImage,
    showSlashMenu,
    setShowSlashMenu,
    slashCommands,
    filteredSlashCmds,
    agentRole,
    setAgentRole,
    ralphMode,
    setRalphMode,
    agentMode,
    setAgentMode,
    reviewMode,
    setReviewMode,
    featureMode,
    setFeatureMode,
    activeFlowLocal,
    setActiveFlowLocal,
    permissionMode,
    setPermissionMode,
    showAdvanced,
    setShowAdvanced,
    handleInputChange,
    handlePaste,
    handleDrop,
    handleSend,
  };
}
