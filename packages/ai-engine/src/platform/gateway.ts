import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { timingSafeEqual } from 'node:crypto';
import type { Orchestrator } from '../orchestrator.js';
import { isRustEngineEnabled, tryNativeCompletion } from '../rig-bridge.js';

export interface GatewayConfig {
  port?: number;
  apiKey?: string;
  rateLimitLimit?: number; // requests per minute
  rateLimitWindowMs?: number;
  monthlyBudget?: number; // USD
  piiFilteringEnabled?: boolean;
  allowedOrigins?: string[];
  maxRequestBodyBytes?: number;
  metricsRequireAuth?: boolean;
  maxRateLimitKeys?: number;
}

class RequestBodyTooLargeError extends Error {}

export class AIGatewayServer {
  private orchestrator: Orchestrator;
  private config: Required<GatewayConfig>;
  private server: Server | null = null;

  // Trackers
  private requestCounts = new Map<string, number[]>();
  private accumulatedCost = 0;
  private auditLogs: Array<Record<string, unknown>> = [];

  // Metrics (Prometheus style counters/gauges)
  private metrics = {
    httpRequestsTotal: 0,
    llmTokenUsageTotal: 0,
    llmCostTotal: 0,
    llmRequestDurationSecondsSum: 0,
  };

  constructor(orchestrator: Orchestrator, config?: GatewayConfig) {
    this.orchestrator = orchestrator;
    this.config = {
      port: config?.port ?? 3001,
      apiKey:
        config?.apiKey ??
        process.env.GHITA_ADMIN_API_KEY ??
        (() => {
          throw new Error('GHITA_ADMIN_API_KEY environment variable is required');
        })(),
      rateLimitLimit: config?.rateLimitLimit ?? 60,
      rateLimitWindowMs: config?.rateLimitWindowMs ?? 60000,
      monthlyBudget: config?.monthlyBudget ?? 100.0,
      piiFilteringEnabled: config?.piiFilteringEnabled ?? true,
      allowedOrigins: config?.allowedOrigins ?? ['http://localhost:1420', 'http://127.0.0.1:1420'],
      maxRequestBodyBytes: config?.maxRequestBodyBytes ?? 1024 * 1024,
      metricsRequireAuth: config?.metricsRequireAuth ?? true,
      maxRateLimitKeys: config?.maxRateLimitKeys ?? 10_000,
    };
  }

  async start(): Promise<void> {
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      this.metrics.httpRequestsTotal++;
      const startTime = Date.now();

      const origin = req.headers.origin;
      if (origin && !this.config.allowedOrigins.includes(origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Forbidden: Origin is not allowed' } }));
        return;
      }
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = new URL(req.url ?? '', `http://${req.headers.host}`);

      // Route: /metrics (Prometheus)
      if (url.pathname === '/metrics') {
        if (this.config.metricsRequireAuth && !this.isAuthorized(req.headers.authorization)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Unauthorized: Invalid API Key' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end(this.generatePrometheusMetrics());
        return;
      }

      // Route: /v1/chat/completions (OpenAI Compatible)
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        try {
          // 1. Auth check
          if (!this.isAuthorized(req.headers.authorization)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Unauthorized: Invalid API Key' } }));
            return;
          }

          // 2. Rate limit check
          const ip = req.socket.remoteAddress || 'unknown';
          if (this.isRateLimited(ip)) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ error: { message: 'Too Many Requests: Rate limit exceeded' } }),
            );
            return;
          }

          // 3. Budget check
          if (this.accumulatedCost >= this.config.monthlyBudget) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ error: { message: 'Quota Exceeded: Monthly budget reached' } }),
            );
            return;
          }

          const bodyBuffer = await this.readRequestBody(req);
          const body = JSON.parse(bodyBuffer.toString());

          // 4. Content / PII Filtering
          if (this.config.piiFilteringEnabled) {
            body.messages = this.filterPII(body.messages);
          }

          // v0.0.2-preview T5: opt-in native engine fast-path (GHITA_ENGINE=native).
          // tryNativeCompletion trả null khi flag tắt / addon vắng / lỗi →
          // rơi xuống orchestrator TS hiện có (fallback giữ nguyên luồng cũ).
          if (isRustEngineEnabled()) {
            const native = await tryNativeCompletion({
              provider: body.provider ?? 'openai',
              model: body.model ?? 'gpt-4o-mini',
              messages: body.messages ?? [],
              max_tokens: body.max_tokens ?? null,
            });
            if (native !== null) {
              // F8 review: native path phải ghi sổ như TS path — cost, tokens,
              // audit log, latency metric (trước đây bị bỏ qua).
              const usage = {
                promptTokens: native.usageIn,
                completionTokens: native.usageOut,
                totalTokens: native.usageIn + native.usageOut,
              };
              const cost = this.estimateCost(native.model, usage);
              this.accumulatedCost += cost;
              this.metrics.llmCostTotal += cost;
              this.metrics.llmTokenUsageTotal += usage.totalTokens;
              this.logAudit({
                timestamp: Date.now(),
                model: native.model,
                tokens: usage.totalTokens,
                cost,
                durationMs: Date.now() - startTime,
              });
              this.metrics.llmRequestDurationSecondsSum += (Date.now() - startTime) / 1000;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  id: `chatcmpl-native-${Date.now().toString(36)}`,
                  object: 'chat.completion',
                  choices: [{ index: 0, message: { role: 'assistant', content: native.text } }],
                }),
              );
              return;
            }
          }

          // Forward to Orchestrator
          const chatResponse = await this.orchestrator.chat(body.messages, {
            model: body.model,
            maxTokens: body.max_tokens,
            temperature: body.temperature,
          });

          // Calculate Cost
          const cost = this.estimateCost(body.model || 'gpt-4o', chatResponse.usage);
          this.accumulatedCost += cost;
          this.metrics.llmCostTotal += cost;
          this.metrics.llmTokenUsageTotal += chatResponse.usage.totalTokens;

          // Audit log
          this.logAudit({
            timestamp: Date.now(),
            model: body.model,
            tokens: chatResponse.usage.totalTokens,
            cost,
            durationMs: Date.now() - startTime,
          });

          // Log latency metric
          this.metrics.llmRequestDurationSecondsSum += (Date.now() - startTime) / 1000;

          // Return OpenAI response
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: `chatcmpl-${Date.now().toString(36)}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: chatResponse.model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: chatResponse.content,
                  },
                  finish_reason: chatResponse.finishReason,
                },
              ],
              usage: {
                prompt_tokens: chatResponse.usage.promptTokens,
                completion_tokens: chatResponse.usage.completionTokens,
                total_tokens: chatResponse.usage.totalTokens,
              },
            }),
          );
        } catch (e: unknown) {
          if (e instanceof RequestBodyTooLargeError) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: e.message } }));
            return;
          }
          const message = e instanceof Error ? e.message : 'Internal Server Error';
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message } }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not Found' } }));
    });

    return new Promise<void>((resolve) => {
      this.server?.listen(this.config.port, () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
    }
  }

  getAccumulatedCost(): number {
    return this.accumulatedCost;
  }

  getAuditLogs(): Array<Record<string, unknown>> {
    return this.auditLogs;
  }

  // --- Helpers ---

  private async readRequestBody(req: IncomingMessage): Promise<Buffer> {
    const declaredLength = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > this.config.maxRequestBodyBytes) {
      throw new RequestBodyTooLargeError(
        `Request body exceeds ${this.config.maxRequestBodyBytes} bytes`,
      );
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      totalBytes += buffer.byteLength;
      if (totalBytes > this.config.maxRequestBodyBytes) {
        throw new RequestBodyTooLargeError(
          `Request body exceeds ${this.config.maxRequestBodyBytes} bytes`,
        );
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }

  private isAuthorized(authorization: string | undefined): boolean {
    const prefix = 'Bearer ';
    if (!authorization?.startsWith(prefix)) return false;
    const candidate = Buffer.from(authorization.slice(prefix.length));
    const expected = Buffer.from(this.config.apiKey);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  private isRateLimited(key: string): boolean {
    const now = Date.now();
    for (const [storedKey, storedTimestamps] of this.requestCounts) {
      if (!storedTimestamps.some((timestamp) => now - timestamp < this.config.rateLimitWindowMs)) {
        this.requestCounts.delete(storedKey);
      }
    }
    if (!this.requestCounts.has(key) && this.requestCounts.size >= this.config.maxRateLimitKeys) {
      const oldestKey = this.requestCounts.keys().next().value as string | undefined;
      if (oldestKey) this.requestCounts.delete(oldestKey);
    }
    const timestamps = this.requestCounts.get(key) || [];
    const validTimestamps = timestamps.filter((t) => now - t < this.config.rateLimitWindowMs);
    if (validTimestamps.length >= this.config.rateLimitLimit) {
      return true;
    }
    validTimestamps.push(now);
    this.requestCounts.set(key, validTimestamps);
    return false;
  }

  private filterPII(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const piiRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    return messages.map((m) => {
      if (m.content && typeof m.content === 'string') {
        return {
          ...m,
          content: m.content.replace(piiRegex, '[CENSORED_EMAIL]'),
        };
      }
      return m;
    });
  }

  private estimateCost(
    model: string,
    usage: { promptTokens: number; completionTokens: number },
  ): number {
    let promptRate = 2.5;
    let completionRate = 10.0;

    if (model.includes('mini')) {
      promptRate = 0.15;
      completionRate = 0.6;
    } else if (model.includes('gpt-4')) {
      promptRate = 5.0;
      completionRate = 15.0;
    }

    const promptCost = (usage.promptTokens / 1_000_000) * promptRate;
    const completionCost = (usage.completionTokens / 1_000_000) * completionRate;
    return promptCost + completionCost;
  }

  private logAudit(log: Record<string, unknown>) {
    this.auditLogs.push(log);
    if (this.auditLogs.length > 1000) this.auditLogs.shift();
  }

  private generatePrometheusMetrics(): string {
    return `# HELP http_requests_total Total number of HTTP requests to the gateway
# TYPE http_requests_total counter
http_requests_total ${this.metrics.httpRequestsTotal}

# HELP llm_token_usage_total Cumulative total of tokens processed
# TYPE llm_token_usage_total counter
llm_token_usage_total ${this.metrics.llmTokenUsageTotal}

# HELP llm_cost_total Accumulated total estimated LLM cost in USD
# TYPE llm_cost_total counter
llm_cost_total ${this.metrics.llmCostTotal.toFixed(6)}

# HELP llm_request_duration_seconds Total cumulative duration of LLM calls in seconds
# TYPE llm_request_duration_seconds counter
llm_request_duration_seconds ${this.metrics.llmRequestDurationSecondsSum.toFixed(4)}
`;
  }
}
