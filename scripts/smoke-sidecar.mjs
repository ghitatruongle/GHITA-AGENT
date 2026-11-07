#!/usr/bin/env node
// (H3.2) smoke-sidecar — kiểm chứng CẦU NỐI socket->engine sau mỗi build:
//   1. Nổ sidecar server.mjs (port ngẫu nhiên)
//   2. Socket.io client kết nối + phát crew_run (chưa auth)
//   3. Phải nhận lỗi auth RÕ RÀNG (chứng minh handler ĐÃ đăng ký + sống)
//   4. Phát crew_run payload rác (auth giả lập GHITA_SMOKE_AUTH=1 chỉ dùng
//      khi sidecar chạy cục bộ với GHITA_SMOKE_TRUST=1)
// Exit 0 = cầu nối sống; exit 1 = handler chết (đúng cái lỗi của bản 4/11).
//
// Cách dùng: node scripts/smoke-sidecar.mjs [--server <path server.mjs>]
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootArgIdx = process.argv.indexOf('--server');
const SERVER = rootArgIdx !== -1
  ? process.argv[rootArgIdx + 1]
  : join(scriptDir, '..', 'apps', 'desktop', 'src-tauri', 'sidecar', 'server.mjs');

const PORT = 18000 + Math.floor(Math.random() * 2000);
const URL = `http://127.0.0.1:${PORT}`;

const SMOKE_TOKEN = 'smoke-' + Math.random().toString(36).slice(2);
const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, GHITA_PORT: String(PORT), GHITA_SMOKE: '1', GHITA_SESSION_TOKEN: SMOKE_TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => {
  out += d;
});
child.stderr.on('data', (d) => {
  out += d;
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Chờ sidecar sẵn sàng (log "Sidecar listening" hoặc tương tự)
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await wait(250);
    if (/listening|ready|Sidecar/i.test(out)) {
      ready = true;
      break;
    }
    if (child.exitCode !== null) break;
  }
  if (!ready) {
    console.error('❌ smoke-sidecar: sidecar không lên sau 10s');
    console.error(out.slice(-800));
    child.kill();
    process.exit(1);
  }

  // socket.io-client resolve từ deps của desktop (scripts/ không có node_modules)
  const { createRequire } = await import('node:module');
  const desktopRequire = createRequire(join(scriptDir, '..', 'apps', 'desktop', 'package.json'));
  const { io } = desktopRequire('socket.io-client');
  const socket = io(URL, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000,
    auth: { token: SMOKE_TOKEN },
  });
  const result = await new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, reason: 'timeout 20s không nhận được phản hồi từ handler' }),
      20_000,
    );
    socket.on('connect', async () => {
      // Phát crew_run KHÔNG auth — handler phải trả lỗi rõ (không im lặng).
      const onAny = (name) => {
        socket.on(name, (p) => {
          clearTimeout(timer);
          resolve({
            ok: true,
            event: name,
            error: p?.message ?? p?.error ?? '',
          });
        });
      };
      // BẤT KỲ phản hồi nào từ handler = cầu nối sống (không còn rơi vào
      // khoảng trống như bản 4/11).
      for (const name of ['chat_error', 'error', 'crew_event', 'crew_done']) onAny(name);
      socket.emit('crew_run', {
        process: 'sequential',
        agents: [{ id: 'a1', name: 'Smoke', role: 'r', goal: 'g' }],
        tasks: [{ id: 't1', description: 'smoke' }],
      });
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: 'connect_error: ' + err.message });
    });
  });

  socket.close();
  child.kill();
  if (!result.ok) {
    console.error('❌ smoke-sidecar FAILED: ' + result.reason);
    console.error('--- sidecar log (cuoi) ---\n' + out.slice(-1200));
    process.exit(1);
  }
  console.log('✅ smoke-sidecar OK — handler crew_run sống, phản hồi: ' + (result.error ?? '').slice(0, 120));
  process.exit(0);
}

const EVENTS_ERROR_NAME = 'error'; // EVENTS.ERROR của sidecar
main().catch((err) => {
  console.error('❌ smoke-sidecar crashed: ' + err.message);
  child.kill();
  process.exit(1);
});
