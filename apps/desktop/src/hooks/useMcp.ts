// useMcp — desktop-side bridge for the sidecar `mcp_*` handlers (Track 6.3).
//
// Pattern nguồn: useCrewRun.ts (shared socket singleton + tracked listeners)
// và SkillManager.runSkill (request/response qua socket ack callback + timeout
// guard — ack không bao giờ đến nếu sidecar chết, không được treo UI).
//
// Sidecar contract (mcp-handlers.mjs):
//   mcp_list_tools {}  -> ack {success, tools:[{name, description, inputSchema}], error?}
//   mcp_call_tool {name, args} -> ack {success, name, result:{content, isError}, error?}
//   mcp_health {}      -> ack {success, registry, registryReady, health, summary}
//   Từ chối auth / lỗi validate cũng emit 'chat_error' (đã bọc trong ack.error).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { getSharedSocket } from '../utils/sharedSocket';

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpHealthInfo {
  state: 'checking' | 'healthy' | 'degraded' | 'unknown';
  checkedAt: number;
  latencyMs?: number;
  toolCount?: number;
  error?: string;
}

export interface McpToolCallResult {
  ok: boolean;
  text: string;
  isError?: boolean;
}

type McpListAck = { success: boolean; tools?: McpToolInfo[]; error?: string };
type McpCallAck = {
  success: boolean;
  name?: string;
  result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
  error?: string;
};
type McpHealthAck = {
  success: boolean;
  registry?: string;
  registryReady?: boolean;
  health?: McpHealthInfo;
  summary?: Record<string, number> | null;
  error?: string;
};

const REQUEST_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000; // index_codebase có thể index toàn workspace lần đầu

export function useMcp() {
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<McpHealthInfo | null>(null);
  const [socketReady, setSocketReady] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const aliveRef = useRef(false);

  useEffect(() => {
    let active = true;
    aliveRef.current = true;
    void (async () => {
      const socket = await getSharedSocket();
      if (!active) return;
      if (!socket) {
        setError('Not connected to the sidecar server.');
        return;
      }
      socketRef.current = socket;
      setSocketReady(true);
    })();
    return () => {
      active = false;
      aliveRef.current = false;
      socketRef.current = null;
    };
  }, []);

  /** emit + ack callback với timeout bound (cùng guard với SkillManager.runSkill). */
  const request = useCallback(
    async <T,>(
      event: string,
      payload: Record<string, unknown>,
      timeoutMs: number,
    ): Promise<T | null> => {
      const socket = socketRef.current;
      if (!socket) return null;
      return await new Promise<T | null>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve(null);
          }
        }, timeoutMs);
        socket.emit(event, payload, (res: T) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(res);
          }
        });
      });
    },
    [],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (!socketRef.current) {
      if (aliveRef.current) setError('Not connected to the sidecar server.');
      return;
    }
    if (aliveRef.current) {
      setLoading(true);
      setError(null);
    }
    const res = await request<McpListAck>('mcp_list_tools', {}, REQUEST_TIMEOUT_MS);
    if (!aliveRef.current) return;
    if (res && res.success && Array.isArray(res.tools)) {
      setTools(res.tools);
    } else {
      setError(res?.error ?? 'MCP request timed out or the sidecar is unreachable.');
    }
    setLoading(false);
  }, [request]);

  const callTool = useCallback(
    async (name: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> => {
      if (!socketRef.current) {
        return { ok: false, text: 'Not connected to the sidecar server.' };
      }
      if (aliveRef.current) setLoading(true);
      const res = await request<McpCallAck>('mcp_call_tool', { name, args }, CALL_TIMEOUT_MS);
      if (aliveRef.current) setLoading(false);
      if (!res) {
        return { ok: false, text: 'MCP call timed out or the sidecar is unreachable.' };
      }
      if (res.success && res.result) {
        const text = (res.result.content ?? [])
          .map((block) => (typeof block?.text === 'string' ? block.text : ''))
          .join('\n')
          .trim();
        return {
          ok: res.result.isError !== true,
          text: text || '(empty result)',
          isError: res.result.isError === true,
        };
      }
      const message = res.error ?? 'MCP tool call failed.';
      if (aliveRef.current) setError(message);
      return { ok: false, text: message };
    },
    [request],
  );

  const checkHealth = useCallback(async (): Promise<void> => {
    if (!socketRef.current) {
      if (aliveRef.current) {
        setHealth({ state: 'unknown', checkedAt: Date.now(), error: 'Not connected.' });
      }
      return;
    }
    if (aliveRef.current) {
      setHealth((prev) =>
        prev ? { ...prev, state: 'checking' } : { state: 'checking', checkedAt: Date.now() },
      );
    }
    const res = await request<McpHealthAck>('mcp_health', {}, REQUEST_TIMEOUT_MS);
    if (!aliveRef.current) return;
    if (res && res.health) {
      setHealth(res.health);
    } else {
      setHealth({
        state: 'unknown',
        checkedAt: Date.now(),
        error: res?.error ?? 'MCP health probe timed out.',
      });
    }
  }, [request]);

  // Auto-refresh một lần khi socket sẵn sàng — panel có data ngay khi mở tab
  // (không poll nền, cùng tinh thần useActivePolling của EcosystemView).
  useEffect(() => {
    if (!socketReady) return;
    void refresh();
    void checkHealth();
  }, [socketReady, refresh, checkHealth]);

  return { tools, loading, error, refresh, callTool, health, checkHealth };
}
