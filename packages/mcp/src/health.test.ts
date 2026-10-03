// v1.2.0-demo2 P3.2 (Điểm 8): tầng health cho MCP client.
//
// Nguồn ý tưởng: `refer_project/ai-core/openhands` (MIT) —
//   src/api/mcp-health/mcp-health-store.ts, probe-mcp-server-health.ts
//
// Điểm mấu chốt học được: verdict KHÔNG được persist. Nó chỉ có giá trị bằng
// độ mới của lần probe, nên hết TTL thì mọi server phải về `unknown` chứ không
// phải giữ lại kết quả cũ — nếu không, ta sẽ tưởng server còn sống trong khi
// nó đã chết từ lâu.

import { describe, it, expect, vi } from 'vitest';
import { McpHealthStore, type McpHealthState } from './health.js';

const T0 = 1_000_000;

function storeWithClock(ttlMs = 30_000) {
  let now = T0;
  const store = new McpHealthStore({ ttlMs, now: () => now });
  return { store, advance: (ms: number) => (now += ms) };
}

describe('McpHealthStore — trạng thái', () => {
  it('server chưa từng probe thì là unknown', () => {
    const { store } = storeWithClock();
    expect(store.get('srv-a').state).toBe<McpHealthState>('unknown');
  });

  it('đang probe thì là checking, và get trả về đúng trạng thái đó', () => {
    const { store } = storeWithClock();
    store.beginCheck('srv-a');
    expect(store.get('srv-a').state).toBe<McpHealthState>('checking');
  });

  it('probe thành công → healthy, kèm số tool và độ trễ', () => {
    const { store } = storeWithClock();
    store.record('srv-a', { state: 'healthy', latencyMs: 42, toolCount: 7 });
    const rec = store.get('srv-a');
    expect(rec.state).toBe<McpHealthState>('healthy');
    expect(rec.toolCount).toBe(7);
    expect(rec.latencyMs).toBe(42);
  });

  it('probe lỗi → degraded, kèm thông điệp lỗi', () => {
    const { store } = storeWithClock();
    store.markFailure('srv-a', 'ECONNREFUSED');
    const rec = store.get('srv-a');
    expect(rec.state).toBe<McpHealthState>('degraded');
    expect(rec.error).toContain('ECONNREFUSED');
  });
});

describe('McpHealthStore — TTL, verdict không persist', () => {
  it('hết TTL thì healthy quay về unknown (không giữ kết quả cũ)', () => {
    const { store, advance } = storeWithClock(30_000);
    store.record('srv-a', { state: 'healthy', latencyMs: 10, toolCount: 3 });
    expect(store.get('srv-a').state).toBe<McpHealthState>('healthy');

    advance(29_999);
    expect(store.get('srv-a').state).toBe<McpHealthState>('healthy');

    advance(2); // vượt TTL
    expect(store.get('srv-a').state).toBe<McpHealthState>('unknown');
  });

  it('probe lại sau khi hết hạn trả về số liệu mới', () => {
    const { store, advance } = storeWithClock(1_000);
    store.record('srv-a', { state: 'healthy', latencyMs: 10, toolCount: 3 });
    advance(1_001);
    expect(store.get('srv-a').state).toBe<McpHealthState>('unknown');

    store.record('srv-a', { state: 'degraded', latencyMs: 999, toolCount: 0, error: 'chết' });
    expect(store.get('srv-a').state).toBe<McpHealthState>('degraded');
    expect(store.get('srv-a').latencyMs).toBe(999);
  });

  it('store mới (tương đương reload) thì mọi server về unknown', () => {
    const first = new McpHealthStore({ ttlMs: 60_000, now: () => T0 });
    first.record('srv-a', { state: 'healthy', latencyMs: 5, toolCount: 1 });

    // "Reload" = tạo store mới. Không có nguồn persist nào được dùng.
    const reloaded = new McpHealthStore({ ttlMs: 60_000, now: () => T0 });
    expect(reloaded.get('srv-a').state).toBe<McpHealthState>('unknown');
  });
});

describe('McpHealthStore — thống kê', () => {
  it('đếm số lần phát hiện chết (MTTD đo được)', () => {
    const { store } = storeWithClock();
    store.record('srv-a', { state: 'healthy', latencyMs: 1, toolCount: 1 });
    store.markFailure('srv-a', 'lần 1');
    store.markFailure('srv-a', 'lần 2');
    store.record('srv-b', { state: 'healthy', latencyMs: 1, toolCount: 1 });

    const s = store.summary();
    expect(s.degraded).toBe(1);
    expect(s.healthy).toBe(1);
    expect(s.unknown).toBe(0);
    expect(store.stats.failures).toBe(2);
    expect(store.stats.totalProbes).toBe(4); // 1 record + 2 failure + 1 record
  });

  it('list() chỉ trả về server còn trong hạn', () => {
    const { store, advance } = storeWithClock(100);
    store.record('srv-a', { state: 'healthy', latencyMs: 1, toolCount: 1 });
    store.record('srv-b', { state: 'healthy', latencyMs: 1, toolCount: 1 });
    expect(store.list()).toHaveLength(2);

    advance(101);
    expect(store.list()).toHaveLength(0);
  });

  it('làm mới (re-probe) không làm mất thống kê', () => {
    const { store } = storeWithClock();
    store.record('srv-a', { state: 'healthy', latencyMs: 1, toolCount: 1 });
    store.beginCheck('srv-a');
    expect(store.get('srv-a').state).toBe<McpHealthState>('checking');
    expect(store.stats.totalProbes).toBe(1);
  });
});

describe('probeMcpHealth — logic 3 trị cho xác thực', () => {
  it('auth lỗi → unauthenticated (không phải unknown)', async () => {
    const { probeMcpHealth } = await import('./health.js');
    const client = {
      connect: vi.fn(async () => undefined),
      refreshTools: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
      callTool: vi.fn(async () => {
        throw Object.assign(new Error('Unauthorized: 401'), { status: 401 });
      }),
    } as never;

    const res = await probeMcpHealth('srv-a', client, { authProbeTool: 'whoami' });
    expect(res.auth).toBe('unauthenticated');
  });

  it('lỗi không nói lên gì về quyền → unknown (không đoán bừa)', async () => {
    const { probeMcpHealth } = await import('./health.js');
    const client = {
      connect: vi.fn(async () => undefined),
      refreshTools: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
      callTool: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    } as never;

    const res = await probeMcpHealth('srv-a', client, { authProbeTool: 'whoami' });
    expect(res.auth).toBe('unknown');
  });
});
