// Manages Socket.IO connection, event listeners, and stream buffering.

import { useState, useEffect, useRef, useCallback } from 'react';
import type { Socket } from 'socket.io-client';
import { invoke } from '@tauri-apps/api/core';
import { getSharedSocket } from '../../utils/sharedSocket';
import { generateUUID, type AgentEvent } from '@ghita/shared';
import { useAppStore, fileContentCache } from '../../stores/appStore';
import {
  useEditProposalStore,
  type RemoteEditProposalPayload,
} from '../../stores/editProposalStore';
import { fsReadText } from '../../lib/native-fs';
import type { ChatMessage } from '../../hooks/useChatSessions';
import { loadApiConfig } from '../../utils/apiConfig';

export interface ToolApprovalRequest {
  toolCallId: string;
  name: string;
  arguments: string;
  warningMessage?: string;
  approvalKind?: 'tool' | 'command';
}

export interface FileApprovalRequest {
  id: string;
  operation: string;
  filePath: string;
}

export interface ResumeApprovalRequest {
  runId: string;
  pendingTools: string[];
  message: string;
}

export interface AgentRunSummary {
  runId: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'exhausted';
  task: string;
  agentName?: string;
  nextIteration: number;
  stepsCount: number;
  pendingActionsCount: number;
  outputPreview: string;
  error: string;
  updatedAt: number;
}

export interface RalphProgress {
  iteration: number;
  cost: number;
  message: string;
  code?: string;
}

interface UseChatSocketConfig {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  tRef: React.MutableRefObject<(key: string, params?: Record<string, string | number>) => string>;
  reconnectTrigger: number;
}

// v1.0.0 RAM optimization (O02): cap the in-memory chat history so a long
// session cannot grow without bound. Older messages live on in the session
// store (useChatSessions) and reload when the session is reopened.

// cannot reference a temporal-dead-zone binding.
const CHAT_MESSAGE_LIMIT = 200;

export function useChatSocket({
  setMessages: setMessagesRaw,
  tRef,
  reconnectTrigger,
}: UseChatSocketConfig) {
  const [connectionStatus, setConnectionStatus] = useState<
    'connecting' | 'connected' | 'disconnected'
  >('disconnected');
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [approvalRequest, setApprovalRequest] = useState<ToolApprovalRequest | null>(null);
  const [fileApprovalRequest, setFileApprovalRequest] = useState<FileApprovalRequest | null>(null);
  const [resumeApprovalRequest, setResumeApprovalRequest] = useState<ResumeApprovalRequest | null>(
    null,
  );
  const [agentRuns, setAgentRuns] = useState<AgentRunSummary[]>([]);
  const [ralphProgress, setRalphProgress] = useState<RalphProgress | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [activeFlow, setActiveFlow] = useState<'ralph' | 'agent' | null>(null);

  // Wrap the incoming setMessages so the in-memory list never exceeds the cap.
  const setMessages = useCallback(
    (updater: React.SetStateAction<ChatMessage[]>) => {
      setMessagesRaw((prev) => {
        const next =
          typeof updater === 'function'
            ? (updater as (p: ChatMessage[]) => ChatMessage[])(prev)
            : updater;
        if (next.length <= CHAT_MESSAGE_LIMIT) return next;
        return next.slice(next.length - CHAT_MESSAGE_LIMIT);
      });
    },
    [setMessagesRaw],
  );

  const terminalCwd = useAppStore((s) => s.terminalCwd);

  const socketRef = useRef<Socket | null>(null);

  const syncApiConfig = useCallback((socket: Socket) => {
    void loadApiConfig()
      .then((config) => {
        if (socket.connected) socket.emit('sync_api_config', { config });
      })
      .catch((error) => {
        console.warn('[ChatPanel] Secure API configuration could not be loaded:', error);
      });
  }, []);

  // Streaming buffer: accumulate tokens and flush every 50ms
  const streamBufferRef = useRef('');
  const streamFlushIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startStreamFlush = useCallback(() => {
    if (streamFlushIntervalRef.current) return;
    streamFlushIntervalRef.current = setInterval(() => {
      const buffered = streamBufferRef.current;
      if (!buffered) return;
      streamBufferRef.current = '';
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === 'streaming-message' ? { ...msg, content: msg.content + buffered } : msg,
        ),
      );
    }, 50);
  }, [setMessages]);

  const stopStreamFlush = useCallback(() => {
    if (streamFlushIntervalRef.current) {
      clearInterval(streamFlushIntervalRef.current);
      streamFlushIntervalRef.current = null;
    }
    const remaining = streamBufferRef.current;
    if (remaining) {
      streamBufferRef.current = '';
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === 'streaming-message' ? { ...msg, content: msg.content + remaining } : msg,
        ),
      );
    }
  }, [setMessages]);

  // Sync workspace root to server
  useEffect(() => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('set_workspace', { path: terminalCwd || null });
    }
  }, [terminalCwd]);

  // Connect to shared Socket.io singleton
  useEffect(() => {
    let active = true;

    // Handlers registered by THIS hook instance on the SHARED singleton —
    // cleanup removes only ours so other consumers keep their listeners.
    const tracked: Array<[string, (...args: never[]) => void]> = [];
    const initSocket = async () => {
      try {
        setConnectionStatus('connecting');
        const socket = await getSharedSocket();
        if (!active || !socket) {
          if (active) setConnectionStatus('disconnected');
          return;
        }

        socketRef.current = socket;

        const addTracked = (ev: string, handler: (...args: never[]) => void): void => {
          socket.on(ev, handler as never);
          tracked.push([ev, handler]);
        };

        if (socket.connected) {
          if (active) setConnectionStatus('connected');
          const cwd = useAppStore.getState().terminalCwd;
          socket.emit('set_workspace', { path: cwd || null });
          syncApiConfig(socket);
          socket.emit('list_agent_runs', { limit: 30 });
        }

        addTracked('connect', () => {
          if (active) setConnectionStatus('connected');
          const cwd = useAppStore.getState().terminalCwd;
          socket.emit('set_workspace', { path: cwd || null });
          syncApiConfig(socket);
          socket.emit('list_agent_runs', { limit: 30 });
        });

        addTracked('disconnect', () => {
          if (active) {
            setConnectionStatus('disconnected');
            setIsSending(false);
            setActiveFlow(null);
            setApprovalRequest(null);
            setFileApprovalRequest(null);
            setResumeApprovalRequest(null);
            setRalphProgress(null);
            stopStreamFlush();
            setMessages((prev) => prev.filter((msg) => msg.id !== 'streaming-message'));
          }
        });

        addTracked('connect_error', (err) => {
          console.warn('[ChatPanel] Socket connection error:', err);
          if (active) {
            setConnectionStatus('disconnected');
            setIsSending(false);
            setActiveFlow(null);
            setApprovalRequest(null);
            setFileApprovalRequest(null);
            setResumeApprovalRequest(null);
            setRalphProgress(null);
          }
        });

        // AI Streaming Event Listeners
        addTracked('chat_start', (data: { text: string; senderId: string; senderName: string }) => {
          if (!active) return;
          setIsSending(true);

          if (data.senderId !== 'desktop' && data.senderId !== 'system') {
            setMessages((prev) => [
              ...prev,
              {
                id: generateUUID(),
                role: 'user',
                content: data.text,
                timestamp: Date.now(),
              },
            ]);
          }

          setMessages((prev) => {
            const hasStreaming = prev.some((msg) => msg.id === 'streaming-message');
            if (hasStreaming) return prev;
            return [
              ...prev,
              {
                id: 'streaming-message',
                role: 'assistant',
                content: '',
                timestamp: Date.now(),
                isStreaming: true,
              },
            ];
          });
        });

        addTracked('chat_chunk', (data: { text: string }) => {
          if (!active) return;
          streamBufferRef.current += data.text;
          startStreamFlush();
        });

        addTracked(
          'chat_done',
          (data: {
            text: string;
            runId?: string;
            usage?: {
              promptTokens: number;
              completionTokens: number;
              totalTokens: number;
              costUsd?: number;
            };
          }) => {
            if (!active) return;
            stopStreamFlush();

            // may not emit `agent_run_done` — clean stale proposals here too.
            if (data.runId) {
              useEditProposalStore.getState().removeForRun(data.runId);
            }
            const finalId = generateUUID();
            setMessages((prev) => {
              const placeholder = prev.find((m) => m.id === 'streaming-message');
              if (placeholder) {
                return prev.map((msg) =>
                  msg.id === 'streaming-message'
                    ? { id: finalId, role: 'assistant', content: data.text, timestamp: Date.now() }
                    : msg,
                );
              }
              // Placeholder đã bị `chat_error` xoá (sidecar phát chat_error rồi
              // chat_done ngay sau). Trước đây `.map` là no-op nên `data.text`
              // biến mất không dấu vết. Thêm thành message mới.
              if (!data.text) return prev;
              // Nhưng nếu chat_error VỪA hiện đúng nội dung này (lỗi của sidecar
              // kèm text trùng) thì append thêm là hiện lỗi 2 lần liên tiếp.
              const last = prev[prev.length - 1];
              if (last && last.role === 'assistant' && last.content.includes(data.text)) {
                return prev;
              }
              return [
                ...prev,
                { id: finalId, role: 'assistant', content: data.text, timestamp: Date.now() },
              ];
            });
            setIsSending(false);
            setActiveFlow(null);

            if (data.usage) {
              const currentStats = useAppStore.getState().dashboardStats;
              useAppStore.getState().setDashboardStats({
                totalTokens: currentStats.totalTokens + data.usage.totalTokens,
                totalCost: currentStats.totalCost + (data.usage.costUsd ?? 0),
                activeAgents: currentStats.activeAgents,
                mcpConnections: currentStats.mcpConnections,
              });
              const raw = data.usage.totalTokens;
              const max = 128000;
              // `percentage` phải tính từ CÙNG giá trị đã chặn với `used`.
              // Trước đây `used` bị chặn còn `percentage` thì không, nên khi
              // vượt ngưỡng UI hiện đồng thời "128000/128000" (=100%) và "156%".
              const used = Math.min(raw, max);
              useAppStore.getState().setContextUsage({
                used,
                max,
                percentage: Math.round((used / max) * 100),
              });
            }
          },
        );

        addTracked('chat_error', (data: { message: string; runId?: string }) => {
          if (!active) return;
          stopStreamFlush();

          if (data.runId) {
            useEditProposalStore.getState().removeForRun(data.runId);
          }
          const errorMessage = `❌ **${tRef.current('chat.systemError')}** ${data.message}`;
          setMessages((prev) => {
            let replacedStreaming = false;
            const next = prev.map((msg) => {
              if (msg.id !== 'streaming-message') return msg;
              replacedStreaming = true;
              return {
                id: generateUUID(),
                role: 'assistant' as const,
                content: errorMessage,
                timestamp: Date.now(),
              };
            });
            return replacedStreaming
              ? next
              : [
                  ...prev,
                  {
                    id: generateUUID(),
                    role: 'assistant' as const,
                    content: errorMessage,
                    timestamp: Date.now(),
                  },
                ];
          });
          setIsSending(false);
          setActiveFlow(null);
        });

        // Human-in-the-loop: Request tool execution approval
        addTracked('action_required', (data: ToolApprovalRequest) => {
          if (active) {
            setApprovalRequest({ ...data, approvalKind: 'tool' });
            setIsSending(false);
            setActiveFlow(null);
          }
        });

        addTracked(
          'require_approval',
          (data: { id: string; command: string; warningMessage?: string }) => {
            if (active) {
              setApprovalRequest({
                toolCallId: data.id,
                name: 'run_command',
                arguments: JSON.stringify({ command: data.command }, null, 2),
                warningMessage: data.warningMessage,
                approvalKind: 'command',
              });
            }
          },
        );

        addTracked(
          'require_file_approval',
          (data: { id: string; operation: string; filePath: string }) => {
            if (active) {
              setFileApprovalRequest(data);
            }
          },
        );

        addTracked('agent_resume_confirmation_required', (data: ResumeApprovalRequest) => {
          if (active) {
            setResumeApprovalRequest(data);
            setIsSending(false);
            setActiveFlow(null);
          }
        });

        addTracked('agent_runs', (data: { runs?: AgentRunSummary[] }) => {
          if (active && Array.isArray(data.runs)) {
            setAgentRuns(data.runs);
          }
        });

        addTracked('agent_run_done', (data: { runId?: string }) => {
          socket.emit('list_agent_runs', { limit: 30 });

          // review from this run — the sidecar has drained them too, so
          // accepting one now would report a write that never happens.
          if (data?.runId) {
            useEditProposalStore.getState().removeForRun(data.runId);
          }
        });

        addTracked('agent_event', (event: AgentEvent) => {
          if (active) {
            setAgentEvents((prev) => {
              const next = [...prev, event];
              if (next.length > 15) next.shift();
              return next;
            });

            if (event.type === 'skill:learning') {
              setMessages((prev) => [
                ...prev,
                {
                  id: generateUUID(),
                  role: 'assistant',
                  content: `⚡ **${tRef.current('chat.skillLearned')}**\n\n**${event.payload?.name || 'Unnamed Skill'}**\n*${tRef.current('chat.description')}:* ${event.payload?.description || ''}\n\n${tRef.current('chat.skillSaved')}`,
                  timestamp: Date.now(),
                },
              ]);
            }
          }
        });

        addTracked(
          'ralph_loop_progress',
          (data: { iteration: number; cost: number; message: string; code?: string }) => {
            if (active) setRalphProgress(data);
          },
        );

        addTracked('ralph_loop_done', () => {
          if (active) setRalphProgress(null);
        });

        addTracked(
          'computer_use_step',
          (data: {
            action?: string;
            screenshot: string;
            point?: { x: number; y: number };
            box?: { x1: number; y1: number; x2: number; y2: number };
          }) => {
            if (active) {
              setMessages((prev) => [
                ...prev,
                {
                  id: generateUUID(),
                  role: 'assistant',
                  content: data.action
                    ? `🤖 **[Computer Action]** ${data.action}`
                    : `🤖 **[Computer Action]** ${tRef.current('chat.runningAutomation')}`,
                  timestamp: Date.now(),
                  computerUsePreview: {
                    screenshot: data.screenshot,
                    point: data.point,
                    box: data.box,
                  },
                },
              ]);
            }
          },
        );

        // v1.0.0 — Antigravity edit review: the agent proposes a file edit and
        // pauses until the user accepts/rejects the diff in the editor.
        addTracked('edit_proposal', (payload: RemoteEditProposalPayload) => {
          if (!active) return;
          useEditProposalStore.getState().proposeRemote(payload);
        });

        // The sidecar finished writing an accepted edit — refresh any open tab
        // so the editor shows the applied content (not the stale pre-edit copy).
        addTracked('edit_applied', (data: { path: string; relPath?: string; runId?: string }) => {
          if (!active) return;
          void (async () => {
            try {
              const { content, encoding, isTruncated } = await fsReadText(data.path);
              fileContentCache.set(data.path, {
                content,
                originalContent: content,
                encoding,
                hydrated: true,
                isTruncated,
              });
              const files = useAppStore.getState().codeOpenFiles;
              if (files.some((f) => f.path === data.path)) {
                useAppStore
                  .getState()
                  .setCodeOpenFiles(
                    files.map((f) => (f.path === data.path ? { ...f, modified: false } : f)),
                  );
              }
            } catch {
              // File may be binary or unreadable — leave the tab as-is.
            }
          })();
        });
      } catch (err) {
        console.error('[ChatPanel] Socket initialization failed:', err);
        if (active) setConnectionStatus('disconnected');
      }
    };

    initSocket();
    return () => {
      active = false;
      stopStreamFlush();
      const sock = socketRef.current;
      if (sock) {
        for (const [ev, handler] of tracked) {
          sock.off(ev, handler as never);
        }
      }
    };
    // setMessages/startStreamFlush/tRef are stable useCallbacks/refs — listed
    // so exhaustive-deps is satisfied (no behavioural change).
  }, [reconnectTrigger, stopStreamFlush, startStreamFlush, syncApiConfig, setMessages, tRef]);

  const handleReconnect = async () => {
    if (connectionStatus === 'connected') return;
    setConnectionStatus('connecting');
    try {
      if (import.meta.env.DEV)
        console.info('[ChatPanel] Manual reconnect triggered, starting sidecar server...');
      await invoke('start_server');
      // L5 FIX: Wait for server readiness signal instead of hardcoded timeout
      const maxWait = 10000;
      const pollInterval = 200;
      let waited = 0;
      let serverReady = false;
      while (waited < maxWait) {
        try {
          const status = await invoke<{ status: string }>('get_server_status');
          if (status.status === 'running' || status.status === 'starting') {
            serverReady = true;
            break;
          }
        } catch {
          // Server not ready yet
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        waited += pollInterval;
      }
      if (!serverReady && import.meta.env.DEV) {
        console.warn('[ChatPanel] Server readiness timeout after', maxWait, 'ms');
      }
      // Caller must increment reconnectTrigger to trigger re-init
    } catch (e) {
      console.error('[ChatPanel] Manual reconnect failed:', e);
      setConnectionStatus('disconnected');
    }
  };

  const handleApproveTool = () => {
    if (!approvalRequest || !socketRef.current) return;
    if (approvalRequest.approvalKind === 'command') {
      socketRef.current.emit('approve_command', { id: approvalRequest.toolCallId });
    } else {
      socketRef.current.emit('approve', { toolCallId: approvalRequest.toolCallId });
    }
    setApprovalRequest(null);
  };

  const handleRejectTool = (reason: string = 'User rejected execution') => {
    if (!approvalRequest || !socketRef.current) return;
    if (approvalRequest.approvalKind === 'command') {
      socketRef.current.emit('reject_command', { id: approvalRequest.toolCallId });
    } else {
      socketRef.current.emit('reject', { toolCallId: approvalRequest.toolCallId, reason });
    }
    setApprovalRequest(null);
  };

  const handleApproveFileWrite = () => {
    if (!fileApprovalRequest || !socketRef.current) return;
    socketRef.current.emit('approve_command', { id: fileApprovalRequest.id });
    setFileApprovalRequest(null);
  };

  const handleRejectFileWrite = () => {
    if (!fileApprovalRequest || !socketRef.current) return;
    socketRef.current.emit('reject_command', { id: fileApprovalRequest.id });
    setFileApprovalRequest(null);
  };

  const handleConfirmResume = () => {
    if (!resumeApprovalRequest || !socketRef.current) return;
    socketRef.current.emit('agent_run', {
      resumeRunId: resumeApprovalRequest.runId,
      resumeConfirmed: true,
    });
    setResumeApprovalRequest(null);
    setIsSending(true);
    setActiveFlow('agent');
  };

  const handleRejectResume = () => {
    setResumeApprovalRequest(null);
  };

  const refreshAgentRuns = () => {
    socketRef.current?.emit('list_agent_runs', { limit: 30 });
  };

  const handleResumeRun = (runId: string) => {
    if (!socketRef.current) return;
    socketRef.current.emit('agent_run', { resumeRunId: runId });
    setIsSending(true);
    setActiveFlow('agent');
  };

  return {
    socketRef,
    connectionStatus,
    setConnectionStatus,
    agentEvents,
    setAgentEvents,
    approvalRequest,
    fileApprovalRequest,
    resumeApprovalRequest,
    agentRuns,
    ralphProgress,
    isSending,
    setIsSending,
    activeFlow,
    setActiveFlow,
    handleReconnect,
    handleApproveTool,
    handleRejectTool,
    handleApproveFileWrite,
    handleRejectFileWrite,
    handleConfirmResume,
    handleRejectResume,
    refreshAgentRuns,
    handleResumeRun,
  };
}
