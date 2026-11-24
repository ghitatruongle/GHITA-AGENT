// Shared Socket — Singleton socket.io connection to sidecar server

// All components (ChatPanel, SkillManager, etc.) should use this shared socket
// instead of creating their own connections. This eliminates 2-3 duplicate
// WebSocket connections and their associated overhead.

import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/appStore';

let socket: Socket | null = null;
let connectionPromise: Promise<Socket | null> | null = null;

// Track S4 — computer-use bridge relay. The sidecar (agent path) runs in a
// separate node.exe without `__TAURI__`, so whitelisted `computer_*` Tauri
// commands are relayed through this trusted socket client. The result travels
// back via the socket.io acknowledgement. The whitelist is defense in depth:
// the sidecar bridge (computer-use-bridge.mjs) whitelists as well, and this
// side must never become a generic Tauri invoke proxy for the sidecar process.
const COMPUTER_USE_COMMANDS = new Set([
  'computer_health_check',
  'computer_get_screen_size',
  'computer_screenshot',
  'computer_move_mouse',
  'computer_click',
  'computer_type_text',
  'computer_press_key',
]);

interface ComputerUseInvokePayload {
  id?: unknown;
  cmd?: unknown;
  args?: Record<string, unknown>;
}

function registerComputerUseRelay(sock: Socket): void {
  sock.on(
    'computer_use_invoke',
    async (payload: ComputerUseInvokePayload, ack?: (response: unknown) => void) => {
      const respond = (response: Record<string, unknown>) => {
        try {
          ack?.(response);
        } catch {
          // Ack is optional — a disconnected requester must not crash the relay.
        }
      };
      const { id, cmd, args } = payload ?? {};
      if (typeof id !== 'string' || typeof cmd !== 'string' || !COMPUTER_USE_COMMANDS.has(cmd)) {
        respond({
          id: typeof id === 'string' ? id : null,
          ok: false,
          error: `[computer-use relay] command not allowed: ${String(cmd)}`,
        });
        return;
      }
      try {
        const data = await invoke<unknown>(cmd, args ?? {});
        respond({ id, ok: true, data });
      } catch (err) {
        respond({
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}

/**
 * Get or create the shared socket connection to the sidecar server.
 * Returns null if the server is not available.
 *
 * The socket instance is created ONCE for the app lifetime and relies on
 * socket.io's built-in reconnection. Destroying and replacing a disconnected
 * instance would invalidate every consumer's saved ref and silently drop
 * their registered listeners.
 */
export async function getSharedSocket(): Promise<Socket | null> {
  if (socket) return socket;

  // Deduplicate concurrent connection attempts
  if (connectionPromise) return connectionPromise;

  connectionPromise = (async () => {
    try {
      const status = await invoke<{ port: number }>('get_server_status');
      const port = status.port || 39001;

      const sessionToken = await invoke<string>('get_session_token').catch((e) => {
        console.warn('[sharedSocket] get_session_token failed, using empty token:', e);
        return '';
      });

      socket = io(`http://127.0.0.1:${port}`, {
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000,
        auth: { token: sessionToken },
      });

      registerComputerUseRelay(socket);

      // Automatically sync active workspace on connection/reconnection
      socket.on('connect', () => {
        const cwd = useAppStore.getState().terminalCwd;
        if (socket) {
          socket.emit('set_workspace', { path: cwd || null });
        }
      });

      const sock = socket;

      // Wait for connection or timeout
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 3000);
        sock.once('connect', () => {
          clearTimeout(timeout);
          resolve();
        });
        sock.once('connect_error', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      return socket;
    } catch (err) {
      console.error('[sharedSocket] Failed to connect:', err);
      return null;
    } finally {
      connectionPromise = null;
    }
  })();

  return connectionPromise;
}

/**
 * Get the current socket instance (may be null if not connected).
 */
export function getCurrentSocket(): Socket | null {
  return socket;
}
