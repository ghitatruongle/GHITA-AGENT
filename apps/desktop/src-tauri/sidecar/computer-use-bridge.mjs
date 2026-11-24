// ==============================================================================
// Track S4 — Computer-use bridge cho sidecar (agent path).
//
// Vấn đề: sidecar là process node.exe độc lập do Tauri spawn (lib.rs), không
// bao giờ có `globalThis.__TAURI__` — nên TauriOperator trong
// packages/computer-use luôn throw "Tauri invoke failed: __TAURI__ global not
// found" và server.mjs:1149 rơi về ComputerUseController rỗng. Mouse /
// keyboard / screenshot từ agent path vì thế KHÔNG hoạt động qua sidecar.
//
// Phương án đã chọn (Track S4 P1): **(a) RPC qua chính socket.io server của
// sidecar tới client desktop tin cậy** (WebView đã có __TAURI__/invoke). WebView
// relay các lệnh `computer_*` trong whitelist rồi trả kết quả bằng socket.io
// acknowledgement. KHÔNG chọn (b) napi addon vì: computer_use.rs nằm trong
// Cargo workspace độc lập của src-tauri (Cargo.lock riêng), tách thành addon
// đòi hỏi crate mới + build native đa nền tảng và trùng lặp đường native đã
// hardened; đường (a) tái dùng transport + auth sẵn có (session token, room
// `desktop`), native vẫn đi qua Rust command duy nhất trong desktop process.
//
// Khi không có desktop client kết nối (headless), rpc reject với lỗi rõ ràng —
// caller (ComputerUseController/skills) báo failure thay vì im lặng.
// ==============================================================================

import { randomBytes } from 'node:crypto';

/** Whitelist lệnh Tauri computer_* được phép relay (phòng thủ kép: WebView cũng whitelist). */
export const COMPUTER_USE_COMMANDS = Object.freeze(
  new Set([
    'computer_health_check',
    'computer_get_screen_size',
    'computer_screenshot',
    'computer_move_mouse',
    'computer_click',
    'computer_type_text',
    'computer_press_key',
  ]),
);

const DEFAULT_TIMEOUT_MS = 10_000;

// Per-command timeouts: screenshot cần thời gian capture + encode PNG base64.
const COMMAND_TIMEOUT_MS = {
  computer_health_check: 5_000,
  computer_get_screen_size: 5_000,
  computer_screenshot: 20_000,
};

/**
 * Undo DPI scaling — mirror của operators/utils.ts (packages/computer-use).
 * Capture Rust trả physical pixels; ReAct loop làm việc theo logical (OS)
 * coordinates nên phải chia theo scale_factor.
 */
export function undoDpiScale(size, scaleFactor) {
  if (!size || typeof size !== 'object') return size;
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return size;
  return {
    width: Math.round(size.width / scaleFactor),
    height: Math.round(size.height / scaleFactor),
  };
}

function isFinitePoint(point) {
  return (
    point &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= 0 &&
    point.y >= 0
  );
}

/**
 * Tạo bridge computer-use. Bridge giữ Set socket desktop tin cậy (được attach
 * từ `io.on('connection')` khi `isTrustedDesktopSocket(socket)` — chỉ WebView
 * desktop có session token, thiết bị paired/cloud không bao giờ được attach).
 */
export function createComputerUseBridge({ log = () => {} } = {}) {
  const desktopSockets = new Set();
  let seq = 0;

  /** Đăng ký socket desktop tin cậy làm relay. Tự detach khi disconnect. */
  function attachDesktopSocket(socket) {
    if (!socket || typeof socket.emit !== 'function') return;
    desktopSockets.add(socket);
    socket.on('disconnect', () => {
      desktopSockets.delete(socket);
      log(`[computer-use-bridge] desktop socket detached (${desktopSockets.size} online)`);
    });
    log(`[computer-use-bridge] desktop socket attached (${desktopSockets.size} online)`);
  }

  /** True khi còn ít nhất một socket desktop đang kết nối. */
  function hasDesktopBridge() {
    for (const socket of desktopSockets) {
      if (socket.connected !== false) return true;
    }
    return false;
  }

  function pickDesktopSocket() {
    for (const socket of desktopSockets) {
      if (socket.connected !== false) return socket;
    }
    return null;
  }

  /**
   * Gọi một lệnh Tauri `computer_*` qua desktop relay.
   * Response đi ngược bằng acknowledgement của socket.io (không broadcast —
   * mỗi request nhắm đúng 1 socket nên không có click nhân đôi khi LAN có
   * nhiều desktop).
   */
  function rpc(cmd, args = {}, { timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (typeof cmd !== 'string' || !COMPUTER_USE_COMMANDS.has(cmd)) {
        reject(new Error(`[computer-use-bridge] command not allowed: ${String(cmd)}`));
        return;
      }
      const socket = pickDesktopSocket();
      if (!socket) {
        reject(
          new Error(
            '[computer-use-bridge] no trusted desktop client connected — computer-use cần app desktop đang mở',
          ),
        );
        return;
      }
      const id = `cu_${Date.now().toString(36)}_${++seq}_${randomBytes(4).toString('hex')}`;
      const limit = timeoutMs ?? COMMAND_TIMEOUT_MS[cmd] ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        reject(new Error(`[computer-use-bridge] '${cmd}' timed out after ${limit}ms`));
      }, limit);
      socket.emit('computer_use_invoke', { id, cmd, args }, (response) => {
        clearTimeout(timer);
        if (!response || typeof response !== 'object') {
          reject(new Error(`[computer-use-bridge] '${cmd}' malformed relay response`));
          return;
        }
        if (response.id !== id) {
          reject(new Error(`[computer-use-bridge] '${cmd}' response id mismatch`));
          return;
        }
        if (response.ok) {
          resolve(response.data);
        } else {
          reject(new Error(String(response.error || `'${cmd}' failed on desktop relay`)));
        }
      });
    });
  }

  /**
   * Tạo ComputerUseAdapter (interface của packages/computer-use) đi qua bridge.
   * Shape + ngữ nghĩa mirror TauriOperator: tọa độ làm tròn integer, typeText
   * rỗng là no-op, screenshot áp undoDpiScale theo scale_factor Rust trả về.
   */
  function createAdapter() {
    return {
      async getScreenSize() {
        const size = await rpc('computer_get_screen_size');
        if (!size || !(size.width > 0) || !(size.height > 0)) {
          throw new Error('[computer-use-bridge] desktop reported zero screen size');
        }
        return { width: size.width, height: size.height };
      },

      async moveMouse(point) {
        if (!isFinitePoint(point)) {
          throw new Error('[computer-use-bridge] moveMouse requires finite non-negative x/y');
        }
        await rpc('computer_move_mouse', {
          x: Math.round(point.x),
          y: Math.round(point.y),
        });
      },

      async click(point, button = 'left') {
        const args = {};
        if (point) {
          if (!isFinitePoint(point)) {
            throw new Error('[computer-use-bridge] click requires finite non-negative x/y');
          }
          args.point = { x: Math.round(point.x), y: Math.round(point.y) };
        }
        if (button) args.button = button;
        await rpc('computer_click', args);
      },

      async typeText(text) {
        if (typeof text !== 'string' || text.length === 0) return;
        await rpc('computer_type_text', { text });
      },

      async pressKey(key) {
        if (typeof key !== 'string' || key.length === 0) {
          throw new Error('[computer-use-bridge] pressKey requires a non-empty key name');
        }
        await rpc('computer_press_key', { key });
      },

      async screenshot() {
        const raw = await rpc('computer_screenshot');
        if (!raw || typeof raw.data !== 'string') {
          throw new Error('[computer-use-bridge] invalid screenshot payload from desktop relay');
        }
        const size = raw.size ? undoDpiScale(raw.size, raw.scale_factor ?? 1) : undefined;
        return { mimeType: raw.mimeType || 'image/png', data: raw.data, size };
      },

      async healthCheck() {
        const checkedAt = Date.now();
        try {
          const result = await rpc('computer_health_check');
          return { ...result, checkedAt, kind: 'tauri' };
        } catch (e) {
          return {
            ready: false,
            kind: 'tauri',
            checkedAt,
            reason: `Desktop bridge unavailable: ${e?.message ?? e}`,
          };
        }
      },
    };
  }

  return { attachDesktopSocket, hasDesktopBridge, pickDesktopSocket, rpc, createAdapter };
}
