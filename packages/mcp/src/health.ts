// v1.2.0-demo2 P3.2 (Điểm 8): tầng health cho MCP client.
//
// Nguồn ý tưởng: `refer_project/ai-core/openhands` (MIT) —
//   src/api/mcp-health/mcp-health-store.ts + probe-mcp-server-health.ts
//
// Ba quyết định thiết kế, học thẳng từ đó:
//   1. Bốn trạng thái `checking | healthy | degraded | unknown` — có `unknown`
//      riêng vì "chưa biết" khác hẳn "biết là chết". Trước demo2, GHITA chỉ
//      có `connected: boolean`, nên không phân biệt được hai việc này.
//   2. Verdict KHÔNG persist. Hết TTL là về `unknown`, không giữ kết quả cũ.
//      Giữ lại kết quả cũ là cách nhanh nhất để tưởng server đã chết vẫn sống.
//   3. Xác thực dùng logic BA trị (authenticated / unauthenticated / unknown).
//      `unknown` thì giao diện phải hỏi lại người dùng, không được đoán.

/** Trạng thái sức khoẻ của một MCP server. */
export type McpHealthState = 'checking' | 'healthy' | 'degraded' | 'unknown';

/** Kết quả xác thực — ba trị, cố ý không có boolean. */
export type McpAuthState = 'authenticated' | 'unauthenticated' | 'unknown';

export interface McpHealthRecord {
  state: McpHealthState;
  /** Thời điểm probe gần nhất (epoch ms). 0 nghĩa là chưa có. */
  checkedAt: number;
  latencyMs?: number;
  toolCount?: number;
  error?: string;
  auth?: McpAuthState;
}

export interface McpHealthProbeResult {
  /** Server được probe — để log/telemetry không phải tự truyền lại. */
  name: string;
  state: McpHealthState;
  latencyMs: number;
  toolCount: number;
  error?: string;
  auth?: McpAuthState;
}

export interface McpHealthStoreOptions {
  /** Bao lâu một verdict còn hợp lệ. Mặc định 30s. */
  ttlMs?: number;
  /** Đồng hồ tiêm vào để test được. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 30_000;

/**
 * Lưu trạng thái sức khoẻ của các MCP server trong bộ nhớ.
 *
 * Cố ý KHÔNG có đường persist: khởi động lại là mọi thứ về `unknown`, đúng như
 * thiết kế gốc — verdict cũ không có giá trị.
 */
export class McpHealthStore {
  private readonly records = new Map<string, McpHealthRecord>();

  readonly stats = { totalProbes: 0, failures: 0 };

  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: McpHealthStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Bản ghi hiện tại; nếu hết hạn thì trả `unknown` và KHÔNG trả kết quả cũ.
   * Trả bản SAO: người gọi đổi content của bản ghi nhận về không được làm
   * hỏng state nội bộ của store. */
  get(name: string): McpHealthRecord {
    const rec = this.records.get(name);
    if (!rec) return { state: 'unknown', checkedAt: 0 };

    if (rec.checkedAt !== 0 && this.now() - rec.checkedAt > this.ttlMs) {
      return { state: 'unknown', checkedAt: rec.checkedAt };
    }
    return { ...rec };
  }

  /** Đánh dấu đang probe. */
  beginCheck(name: string): void {
    this.records.set(name, { state: 'checking', checkedAt: this.now() });
  }

  /** Ghi kết quả probe. Tên server lấy từ khoá, không cần truyền lại. */
  record(name: string, result: Omit<McpHealthProbeResult, 'name'>): void {
    this.stats.totalProbes++;
    this.records.set(name, {
      state: result.state,
      checkedAt: this.now(),
      latencyMs: result.latencyMs,
      toolCount: result.toolCount,
      error: result.error,
      auth: result.auth,
    });
  }

  /** Ghi kết quả probe thất bại. */
  markFailure(name: string, error: string): void {
    this.stats.totalProbes++;
    this.stats.failures++;
    this.records.set(name, {
      state: 'degraded',
      checkedAt: this.now(),
      error,
    });
  }

  /** Các server còn trong hạn. */
  list(): Array<{ name: string; record: McpHealthRecord }> {
    const out: Array<{ name: string; record: McpHealthRecord }> = [];
    for (const name of this.records.keys()) {
      const rec = this.get(name);
      if (rec.state !== 'unknown' || rec.checkedAt === 0) {
        out.push({ name, record: rec });
      }
    }
    return out;
  }

  /** Số server theo trạng thái (dùng cho UI/bảng điều khiển). */
  summary(): Record<McpHealthState, number> {
    const s: Record<McpHealthState, number> = {
      checking: 0,
      healthy: 0,
      degraded: 0,
      unknown: 0,
    };
    for (const name of this.records.keys()) s[this.get(name).state]++;
    return s;
  }

  forget(name: string): void {
    this.records.delete(name);
  }
}

/** Phần client mà probe cần — cho phép test bằng object giả. */
export interface McpHealthProbedClient {
  connect(): Promise<void>;
  refreshTools(): Promise<readonly unknown[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface ProbeOptions {
  /** Tool dùng để kiểm tra quyền; bỏ trống thì không suy diễn gì về quyền. */
  authProbeTool?: string;
}

/** HTTP status đủ để kết luận "không có quyền". */
function extractStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { status?: unknown; code?: unknown; message?: unknown };
  if (typeof e.status === 'number') return e.status;
  if (typeof e.code === 'number') return e.code;
  if (typeof e.message === 'string') {
    const m = e.message.match(/\b(401|403)\b/);
    if (m?.[1]) return Number(m[1]);
  }
  return undefined;
}

/**
 * Probe một MCP server: kết nối, lấy danh sách tool, và (tuỳ chọn) hỏi thăm
 * quyền bằng logic ba trị. Không bao giờ ném — lỗi thành `degraded`.
 *
 * LƯU Ý QUYỀN SỞ HỮU: probe luôn `close()` client trong `finally` — hãy truyền
 * client dành riêng cho việc probe, KHÔNG truyền client đang dùng chung lâu dài
 * (kết nối sẽ bị đóng ngầm).
 */
export async function probeMcpHealth(
  name: string,
  client: McpHealthProbedClient,
  options: ProbeOptions = {},
): Promise<McpHealthProbeResult> {
  const started = Date.now();
  try {
    await client.connect();
    const tools = await client.refreshTools();
    const latencyMs = Date.now() - started;

    let auth: McpAuthState | undefined;
    if (options.authProbeTool) {
      try {
        const res = await client.callTool(options.authProbeTool, {});
        // MCP báo lỗi quyền ở tầng tool bằng result THƯỜNG kèm isError:true,
        // không ném — chỉ vì call không ném mà kết luận "authenticated" là sai.
        const isError =
          typeof res === 'object' &&
          res !== null &&
          (res as { isError?: unknown }).isError === true;
        auth = isError ? 'unknown' : 'authenticated';
      } catch (err) {
        const status = extractStatus(err);
        // 401/403 là bằng chứng rõ. Lỗi khác (mất mạng, timeout) thì KHÔNG
        // kết luận được — thà `unknown` để giao diện hỏi lại người dùng.
        auth = status === 401 || status === 403 ? 'unauthenticated' : 'unknown';
      }
    }

    return { name, state: 'healthy', latencyMs, toolCount: tools.length, auth };
  } catch (err) {
    return {
      name,
      state: 'degraded',
      latencyMs: Date.now() - started,
      toolCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
