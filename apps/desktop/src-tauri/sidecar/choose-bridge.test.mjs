// v0.0.2-alpha integration — e2e nhỏ cho choose bridge (node --test).
// Kịch bản thật: agent gọi tool `choose` (executeChoose thật từ @ghita/ai-engine
// dist — chính là path orchestrator.builtInTools chạy trong sidecar) → bridge
// relay qua socket.io thật tới "desktop UI" (client mô phỏng useChatSocket:
// nhận require_approval kèm options, emit approve_command/reject_command) →
// resolveChoose feed quyết định về engine → tool resume trả JSON kết quả.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { Server as IoServer } from 'socket.io';
import { io as ioClient } from 'socket.io-client';

import { createChooseBridge, sanitizeChoosePayload } from './choose-bridge.mjs';
import * as aiEngine from '@ghita/ai-engine';

/** Đợi desktop UI nhận require_approval kèm options (timeout 2s). */
function waitForApproval(fixture) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const poll = setInterval(() => {
      const hit = fixture.approvalsSeen.find((p) => Array.isArray(p?.options));
      if (hit) {
        clearInterval(poll);
        resolve(hit);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error('desktop UI never received require_approval with options'));
      }
    }, 20);
  });
}

/**
 * Bật socket.io server thật trên port 0 + 1 client mô phỏng desktop UI.
 * Connection handler mirror đúng glue của sidecar server.mjs:
 *   socket.join('desktop') + approve_command/reject_command → bridge.
 */
async function startFixture({ engine = aiEngine } = {}) {
  const httpServer = createServer();
  const ioServer = new IoServer(httpServer, { transports: ['websocket'] });

  const bridge = createChooseBridge({
    emitToDesktop: (event, data) => ioServer.to('desktop').emit(event, data),
    log: () => {},
    getEngine: () => engine,
  });
  bridge.install();

  await new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  ioServer.on('connection', (socket) => {
    // Mirror sidecar: desktop socket classification → room 'desktop'.
    socket.join('desktop');
    // Mirror sidecar approve_command / reject_command handlers (desktop-only).
    socket.on('approve_command', (data) => {
      bridge.approve(data?.id, data?.choice);
    });
    socket.on('reject_command', (data) => {
      bridge.reject(data?.id);
    });
  });

  const client = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
  });

  const approvalsSeen = [];
  client.on('require_approval', (payload) => approvalsSeen.push(payload));

  return {
    bridge,
    client,
    approvalsSeen,
    close: async () => {
      client.disconnect();
      delete globalThis.chooseRequestHandler;
      aiEngine.getChooseApprovalManager().clear();
      await new Promise((resolve) => ioServer.close(resolve));
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

test('e2e: agent gọi choose → UI nhận options → user chọn → resume đúng option', async () => {
  const fixture = await startFixture();
  try {
    // Path thật của agent: createBuiltInTools()[choose].execute(args)
    const choosePromise = aiEngine.executeChoose({
      question: 'Deploy now or later?',
      options: ['Deploy now', 'Deploy later'],
    });

    const payload = await waitForApproval(fixture);
    assert.equal(payload.command, 'Deploy now or later?');
    assert.deepEqual(payload.options, ['Deploy now', 'Deploy later']);
    assert.equal(payload.allowCustom, false);
    assert.match(payload.id, /^tc_/);

    // User chạm option "Deploy later" → UI emit approve_command {id, choice}.
    fixture.client.emit('approve_command', { id: payload.id, choice: 'Deploy later' });

    const raw = await choosePromise;
    const result = JSON.parse(raw);
    assert.equal(result.approved, true);
    assert.equal(result.selected, 'Deploy later');
    assert.equal(result.selectedIndex, 1);
    assert.equal(result.customAnswer, false);
  } finally {
    await fixture.close();
  }
});

test('e2e: user từ chối (Reject) → executeChoose throws AgentError auth, not retryable', async () => {
  const fixture = await startFixture();
  try {
    const choosePromise = aiEngine.executeChoose({
      question: 'Proceed?',
      options: ['yes', 'no'],
    });
    const payload = await waitForApproval(fixture);
    fixture.client.emit('reject_command', { id: payload.id });
    await assert.rejects(
      () => choosePromise,
      (err) => {
        assert.equal(err.code, 'auth');
        assert.equal(err.retryable, false);
        assert.equal(err.provider, 'choose');
        return true;
      },
    );
  } finally {
    await fixture.close();
  }
});

test('plain approve không choice (nút Approve/Enter) → default option đầu', async () => {
  const fixture = await startFixture();
  try {
    const choosePromise = aiEngine.executeChoose({
      question: 'Proceed?',
      options: ['yes', 'no'],
    });
    const payload = await waitForApproval(fixture);
    // approve_command {id} không kèm choice.
    fixture.client.emit('approve_command', { id: payload.id });
    const result = JSON.parse(await choosePromise);
    assert.equal(result.selected, 'yes');
    assert.equal(result.selectedIndex, 0);
  } finally {
    await fixture.close();
  }
});

test('allowCustom: answer free-text ngoài danh sách → customAnswer true', async () => {
  const fixture = await startFixture();
  try {
    const choosePromise = aiEngine.executeChoose({
      question: 'Name the branch',
      options: ['main', 'develop'],
      allowCustom: true,
    });
    const payload = await waitForApproval(fixture);
    assert.equal(payload.allowCustom, true);
    fixture.client.emit('approve_command', { id: payload.id, choice: 'feature/custom' });
    const result = JSON.parse(await choosePromise);
    assert.equal(result.selected, 'feature/custom');
    assert.equal(result.selectedIndex, -1);
    assert.equal(result.customAnswer, true);
  } finally {
    await fixture.close();
  }
});

test('id-guard: approve/reject id lạ hoặc đã quyết → false, không crash', async () => {
  const fixture = await startFixture();
  try {
    assert.equal(fixture.bridge.approve('tc_unknown_id', 'x'), false);
    assert.equal(fixture.bridge.reject('tc_unknown_id'), false);
    assert.equal(fixture.bridge.approve(undefined), false);
    assert.equal(fixture.bridge.reject(null), false);

    // Đã quyết xong → quyết lần nữa phải false (không "resurrect").
    const choosePromise = aiEngine.executeChoose({ question: 'P?', options: ['a', 'b'] });
    const payload = await waitForApproval(fixture);
    assert.equal(fixture.bridge.approve(payload.id, 'b'), true);
    assert.equal(fixture.bridge.approve(payload.id, 'a'), false);
    assert.equal(fixture.bridge.reject(payload.id), false);
    const result = JSON.parse(await choosePromise);
    assert.equal(result.selected, 'b');
  } finally {
    await fixture.close();
  }
});

test('whitelist payload lỗi → không emit require_approval', async () => {
  const fixture = await startFixture();
  try {
    const before = fixture.approvalsSeen.length;
    fixture.bridge.handleRequest(null);
    fixture.bridge.handleRequest({ id: '', question: 'q', options: ['a', 'b'] });
    fixture.bridge.handleRequest({ id: 'tc_x', question: '', options: ['a', 'b'] });
    fixture.bridge.handleRequest({ id: 'tc_x', question: 'q', options: 'not-array' });
    fixture.bridge.handleRequest({ id: 'tc_x', question: 'q', options: ['only-one'] });
    fixture.bridge.handleRequest({
      id: 'tc_x',
      question: 'q',
      options: Array.from({ length: 9 }, (_, i) => `opt-${i}`),
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(fixture.approvalsSeen.length, before);

    // Payload hợp lệ vẫn đi qua được.
    fixture.bridge.handleRequest({ id: 'tc_ok', question: 'q?', options: ['a', 'b'] });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const hit = fixture.approvalsSeen.find((p) => p?.id === 'tc_ok');
    assert.ok(hit, 'valid payload must reach the desktop room');
  } finally {
    await fixture.close();
  }
});

test('engine chưa load (getEngine trả null) → quyết định bị bỏ qua an toàn', async () => {
  const fixture = await startFixture({ engine: null });
  try {
    assert.equal(fixture.bridge.approve('tc_any', 'a'), false);
    assert.equal(fixture.bridge.reject('tc_any'), false);
  } finally {
    await fixture.close();
  }
});

test('sanitizeChoosePayload: giữ whitelist, strip option không hợp lệ', () => {
  const clean = sanitizeChoosePayload({
    id: ' tc_1 ',
    question: 'q',
    options: ['a', '', 'b'],
    allowCustom: 'truthy',
    hacker: 'field',
  });
  // allowCustom strict boolean ('truthy' → false) + field lạ bị strip.
  assert.deepEqual(clean, { id: 'tc_1', question: 'q', options: ['a', 'b'], allowCustom: false });
  // Option non-string bị ép string, rỗng bị loại.
  const coerced = sanitizeChoosePayload({ id: 'i', question: 'q', options: [1, 'x', 'y'] });
  assert.deepEqual(coerced.options, ['1', 'x', 'y']);
  // Toàn option rỗng/trắng sau coercion → còn < 2 → null.
  assert.equal(sanitizeChoosePayload({ id: 'i', question: 'q', options: ['', '   '] }), null);
});
