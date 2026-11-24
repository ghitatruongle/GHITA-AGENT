// Track S4 — e2e nhỏ cho computer-use bridge (node --test).
// Kịch bản thật: sidecar bridge ↔ socket.io (transport thật, ack thật) ↔
// "desktop relay" mô phỏng WebView (fake Tauri invoke) — đúng sơ đồ
// sidecar → WebView → Tauri của bridge đã chọn.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { Server as IoServer } from 'socket.io';
import { io as ioClient } from 'socket.io-client';

import {
  COMPUTER_USE_COMMANDS,
  createComputerUseBridge,
  undoDpiScale,
} from './computer-use-bridge.mjs';

/** Giả lập phía WebView: nhận `computer_use_invoke`, gọi "Tauri", trả ack. */
function makeFakeTauriRelay({ calls = [], failCommands = new Set(), noAck = false } = {}) {
  return (payload, ack) => {
    const { id, cmd, args } = payload ?? {};
    calls.push({ cmd, args });
    if (noAck) return; // mô phỏng desktop treo — không bao giờ trả kết quả
    if (failCommands.has(cmd)) {
      ack({ id, ok: false, error: `Tauri command failed: ${cmd}` });
      return;
    }
    switch (cmd) {
      case 'computer_health_check':
        ack({ id, ok: true, data: { ready: true, kind: 'tauri' } });
        break;
      case 'computer_get_screen_size':
        ack({ id, ok: true, data: { width: 2880, height: 1800 } });
        break;
      case 'computer_screenshot':
        ack({
          id,
          ok: true,
          data: {
            mimeType: 'image/png',
            data: 'cG5nLWRhdGE=',
            size: { width: 2880, height: 1800 },
            scale_factor: 2,
          },
        });
        break;
      default:
        ack({ id, ok: true, data: null });
    }
  };
}

/** Bật socket.io server thật trên port 0 + 1 client mô phỏng WebView desktop. */
async function startFixture({ bridge, relay, skipAttach = false } = {}) {
  const httpServer = createServer();
  const ioServer = new IoServer(httpServer, { transports: ['websocket'] });
  await new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  ioServer.on('connection', (socket) => {
    if (!skipAttach) bridge?.attachDesktopSocket(socket);
  });

  const client = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
  });

  // Relay (giả WebView) nằm phía CLIENT: bridge emit từ server-side socket
  // tới client, client xử lý rồi trả ack — đúng hướng sidecar → WebView.
  if (relay) client.on('computer_use_invoke', relay);

  return {
    ioServer,
    client,
    close: async () => {
      client.disconnect();
      await new Promise((resolve) => ioServer.close(resolve));
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

test('COMPUTER_USE_COMMANDS whitelist đúng 7 lệnh computer_*', () => {
  assert.equal(COMPUTER_USE_COMMANDS.size, 7);
  for (const cmd of COMPUTER_USE_COMMANDS) {
    assert.match(cmd, /^computer_/);
  }
});

test('undoDpiScale: chia theo scale factor, guard scale <= 0 / NaN', () => {
  assert.deepEqual(undoDpiScale({ width: 2880, height: 1800 }, 2), {
    width: 1440,
    height: 900,
  });
  assert.deepEqual(undoDpiScale({ width: 100, height: 50 }, 0), { width: 100, height: 50 });
  assert.deepEqual(undoDpiScale({ width: 100, height: 50 }, Number.NaN), {
    width: 100,
    height: 50,
  });
  assert.deepEqual(undoDpiScale({ width: 100, height: 50 }, 1.5), {
    width: 67,
    height: 33,
  });
});

test('e2e agent path: adapter điều khiển chuột + screenshot qua bridge thành công', async () => {
  const bridge = createComputerUseBridge();
  const relayCalls = [];
  const fixture = await startFixture({
    bridge,
    relay: makeFakeTauriRelay({ calls: relayCalls }),
  });

  try {
    assert.equal(bridge.hasDesktopBridge(), true);

    const adapter = bridge.createAdapter();

    // getScreenSize
    const size = await adapter.getScreenSize();
    assert.deepEqual(size, { width: 2880, height: 1800 });

    // moveMouse — tọa độ float được làm tròn thành integer như TauriOperator
    await adapter.moveMouse({ x: 10.4, y: 20.6 });
    assert.deepEqual(relayCalls.at(-1), {
      cmd: 'computer_move_mouse',
      args: { x: 10, y: 21 },
    });

    // click mặc định trái + click phải có tọa độ
    await adapter.click();
    assert.deepEqual(relayCalls.at(-1).args, { button: 'left' });
    await adapter.click({ x: 99.5, y: 5.5 }, 'right');
    assert.deepEqual(relayCalls.at(-1), {
      cmd: 'computer_click',
      args: { point: { x: 100, y: 6 }, button: 'right' },
    });

    // typeText + pressKey
    await adapter.typeText('hello ghita');
    assert.deepEqual(relayCalls.at(-1), {
      cmd: 'computer_type_text',
      args: { text: 'hello ghita' },
    });
    await adapter.pressKey('Return');
    assert.deepEqual(relayCalls.at(-1), {
      cmd: 'computer_press_key',
      args: { key: 'Return' },
    });

    // screenshot — DPI undo từ scale_factor Rust trả về
    const capture = await adapter.screenshot();
    assert.equal(capture.mimeType, 'image/png');
    assert.equal(capture.data, 'cG5nLWRhdGE=');
    assert.deepEqual(capture.size, { width: 1440, height: 900 });

    // healthCheck
    const health = await adapter.healthCheck();
    assert.equal(health.ready, true);
  } finally {
    await fixture.close();
  }
});

test('rpc chặn lệnh ngoài whitelist (phòng thủ kép)', async () => {
  const bridge = createComputerUseBridge();
  const fixture = await startFixture({
    bridge,
    relay: makeFakeTauriRelay(),
  });
  try {
    await assert.rejects(() => bridge.rpc('fs_read_text'), /command not allowed/);
    await assert.rejects(() => bridge.rpc('execute_approved_command'), /command not allowed/);
    await assert.rejects(() => bridge.rpc(42), /command not allowed/);
  } finally {
    await fixture.close();
  }
});

test('rpc reject rõ ràng khi không có desktop client (headless)', async () => {
  const bridge = createComputerUseBridge();
  await assert.rejects(
    () => bridge.rpc('computer_get_screen_size'),
    /no trusted desktop client connected/,
  );
  assert.equal(bridge.hasDesktopBridge(), false);
});

test('rpc timeout khi desktop không trả ack', async () => {
  const bridge = createComputerUseBridge();
  const fixture = await startFixture({
    bridge,
    relay: makeFakeTauriRelay({ noAck: true }),
  });
  try {
    await assert.rejects(
      () => bridge.rpc('computer_move_mouse', { x: 1, y: 2 }, { timeoutMs: 80 }),
      /timed out after 80ms/,
    );
  } finally {
    await fixture.close();
  }
});

test('lỗi Tauri từ desktop được truyền về adapter nguyên văn', async () => {
  const bridge = createComputerUseBridge();
  const fixture = await startFixture({
    bridge,
    relay: makeFakeTauriRelay({ failCommands: new Set(['computer_click']) }),
  });
  try {
    const adapter = bridge.createAdapter();
    await assert.rejects(
      () => adapter.click({ x: 5, y: 5 }),
      /Tauri command failed: computer_click/,
    );
  } finally {
    await fixture.close();
  }
});

test('adapter validate input: tọa độ âm/NaN, key rỗng', async () => {
  const bridge = createComputerUseBridge();
  const fixture = await startFixture({ bridge, relay: makeFakeTauriRelay() });
  try {
    const adapter = bridge.createAdapter();
    await assert.rejects(() => adapter.moveMouse({ x: -1, y: 0 }), /finite non-negative/);
    await assert.rejects(
      () => adapter.moveMouse({ x: Number.NaN, y: 0 }),
      /finite non-negative/,
    );
    await assert.rejects(() => adapter.click({ x: -5, y: 5 }), /finite non-negative/);
    await assert.rejects(() => adapter.pressKey(''), /non-empty key name/);
    // typeText rỗng là no-op (không gọi relay)
    await adapter.typeText('');
  } finally {
    await fixture.close();
  }
});

test('response malformed / id mismatch bị reject thay vì resolve sai', async () => {
  const bridge = createComputerUseBridge();
  const fixture = await startFixture({
    bridge,
    relay: (payload, ack) => {
      // Trả id sai — client phải reject, không resolve nhầm request khác.
      ack({ id: `${payload?.id}_wrong`, ok: true, data: { width: 1, height: 1 } });
    },
  });
  try {
    await assert.rejects(
      () => bridge.rpc('computer_get_screen_size', {}, { timeoutMs: 300 }),
      /response id mismatch/,
    );
  } finally {
    await fixture.close();
  }
});

test('socket desktop disconnect → bridge rỗng lại, rpc reject', async () => {
  const bridge = createComputerUseBridge();
  const fixture = await startFixture({ bridge, relay: makeFakeTauriRelay() });
  try {
    assert.equal(bridge.hasDesktopBridge(), true);
    fixture.client.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(bridge.hasDesktopBridge(), false);
    await assert.rejects(
      () => bridge.rpc('computer_screenshot'),
      /no trusted desktop client connected/,
    );
  } finally {
    await fixture.close();
  }
});
