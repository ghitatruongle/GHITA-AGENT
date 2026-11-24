export class AIBaseError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.cause = cause;

    // Restore prototype chain
    Object.setPrototypeOf(this, new.target.prototype);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class AIAPIError extends AIBaseError {
  readonly provider: string;
  readonly status?: number;
  readonly details?: unknown;

  constructor(provider: string, message: string, status?: number, details?: unknown) {
    super(`[${provider} API Error] ${message}`);
    this.provider = provider;
    this.status = status;
    this.details = details;
  }
}

export class AIValidationError extends AIBaseError {
  readonly schemaDescription: string;
  readonly errors: unknown[];
  readonly rawResponse: string;

  constructor(
    schemaDescription: string,
    rawResponse: string,
    errors: unknown[],
    message = 'Structured output validation failed',
  ) {
    super(`${message}: ${schemaDescription}`);
    this.schemaDescription = schemaDescription;
    this.rawResponse = rawResponse;
    this.errors = errors;
  }
}

export class AITimeoutError extends AIBaseError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, message = 'AI Engine request timed out') {
    super(`${message} after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }
}

export class AIRateLimitError extends AIBaseError {
  readonly provider: string;
  readonly limit?: number;
  readonly remaining?: number;
  readonly resetTime?: Date;

  constructor(
    provider: string,
    message = 'Rate limit exceeded',
    limit?: number,
    remaining?: number,
    resetTime?: Date,
  ) {
    super(`[${provider} Rate Limit] ${message}`);
    this.provider = provider;
    this.limit = limit;
    this.remaining = remaining;
    this.resetTime = resetTime;
  }
}

export class AIInvalidConfigError extends AIBaseError {
  constructor(message: string) {
    super(`Invalid Config: ${message}`);
  }
}

export class AINoProviderError extends AIBaseError {
  constructor(message = 'No AI providers available or ready') {
    super(message);
  }
}

export class AIToolCallRepairError extends AIBaseError {
  readonly rawResponse: string;
  readonly attempts: number;
  readonly toolErrors: unknown[];

  constructor(
    rawResponse: string,
    attempts: number,
    toolErrors: unknown[],
    message = 'Failed to repair tool call output',
  ) {
    super(`${message} after ${attempts} attempts`);
    this.rawResponse = rawResponse;
    this.attempts = attempts;
    this.toolErrors = toolErrors;
  }
}

export class AIPermissionDeniedError extends AIBaseError {
  readonly toolName: string;
  readonly reason: string;

  constructor(toolName: string, reason: string) {
    super(`Permission denied for tool "${toolName}": ${reason}`);
    this.toolName = toolName;
    this.reason = reason;
  }
}

export class AISecurityGuardrailError extends AIBaseError {
  readonly threatType: string;
  readonly details?: unknown;

  constructor(
    threatType: string,
    details?: unknown,
    message = 'Security guardrail violation detected',
  ) {
    super(`${message} (${threatType})`);
    this.threatType = threatType;
    this.details = details;
  }
}

export class AIUnsupportedFeatureError extends AIBaseError {
  readonly provider: string;
  readonly feature: string;

  constructor(provider: string, feature: string) {
    super(`Provider "${provider}" does not support feature "${feature}"`);
    this.provider = provider;
    this.feature = feature;
  }
}

export class AIBudgetExceededError extends AIBaseError {
  readonly limit: number;
  readonly currentSpent: number;
  readonly period: string;

  constructor(limit: number, currentSpent: number, period = 'monthly') {
    super(
      `AI spending budget exceeded. Limit: $${limit}, Current Spent: $${currentSpent} (${period})`,
    );
    this.limit = limit;
    this.currentSpent = currentSpent;
    this.period = period;
  }
}

// --- Track S2: canonical AgentError shape ---
//
// One normalized failure shape on top of the existing hierarchy (extension,
// not replacement): every failure crossing the retry ladder / telemetry is
// canonicalized into a machine-readable code + retryability verdict, whatever
// the provider threw underneath.

/** Machine-readable failure classes the retry ladder and telemetry reason over. */
export type AgentErrorCode =
  | 'rate_limited'
  | 'auth'
  | 'timeout'
  | 'network'
  | 'content_filter'
  | 'invalid_request'
  | 'server'
  | 'empty_response'
  | 'budget'
  | 'no_provider'
  | 'unknown';

export interface AgentErrorShape {
  code: AgentErrorCode;
  /** Provider that produced the failure, when attributable. */
  provider?: string;
  /** HTTP status when the failure came from a provider response. */
  status?: number;
  /** Whether a retry (same provider, switched key, or fallback) can plausibly succeed. */
  retryable: boolean;
  /** Provider-suggested retry delay in ms (Retry-After), when known. */
  retryAfterMs?: number;
  details?: unknown;
}

/** Codes where another attempt can plausibly help (mirrors the legacy
 * retry-everything-unless-auth/4xx semantics). */
const RETRYABLE_AGENT_CODES: ReadonlySet<AgentErrorCode> = new Set([
  'rate_limited',
  'timeout',
  'network',
  'server',
  'unknown',
]);

const RATE_LIMIT_RE = /\b429\b|rate[ _-]?limit|too many requests/i;
const CONTENT_FILTER_RE =
  /content[ _-]?filter|refusal|blocked by (the )?safety|safety system|flagged as (harmful|unsafe)|harmful content/i;
const AUTH_RE =
  /\b(401|403)\b|unauthorized|forbidden|invalid[ _-]?api[ _-]?key|authentication|permission denied/i;
const INVALID_REQUEST_RE =
  /\b(400|404|422)\b|bad request|invalid request|not found|unsupported|invalid model/i;
const SERVER_RE = /\b(500|502|503|504)\b|internal server error|bad gateway|service unavailable/i;
const TIMEOUT_RE = /timeout|timed[ _-]?out|etimedout|operation aborted|aborted/i;
const NETWORK_RE =
  /network|fetch failed|econnrefused|econnreset|econnaborted|enotfound|socket hang up|dns/i;

function extractHttpStatus(message: string): number | undefined {
  const paren = /\((\d{3})\)/.exec(message);
  if (paren) return Number(paren[1]);
  const loose = /\b([45]\d\d)\b/.exec(message);
  return loose ? Number(loose[1]) : undefined;
}

export class AgentError extends AIBaseError {
  readonly code: AgentErrorCode;
  readonly provider?: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: unknown;

  constructor(message: string, shape: AgentErrorShape, cause?: unknown) {
    super(message, cause);
    this.code = shape.code;
    this.provider = shape.provider;
    this.status = shape.status;
    this.retryable = shape.retryable;
    this.retryAfterMs = shape.retryAfterMs;
    this.details = shape.details;
  }

  /**
   * Canonicalize any thrown value into an AgentError. Idempotent: existing
   * AgentError instances pass through (with provider backfill when missing).
   */
  static from(error: unknown, provider?: string): AgentError {
    if (error instanceof AgentError) {
      if (provider && !error.provider) {
        return new AgentError(
          error.message,
          {
            code: error.code,
            provider,
            status: error.status,
            retryable: error.retryable,
            retryAfterMs: error.retryAfterMs,
            details: error.details,
          },
          error.cause,
        );
      }
      return error;
    }

    const message = error instanceof Error ? error.message : String(error);
    const status = extractHttpStatus(message);
    const code = classifyAgentError(error, message, status);
    const retryable = RETRYABLE_AGENT_CODES.has(code) && code !== 'empty_response';

    return new AgentError(
      message,
      { code, provider, status, retryable },
      error instanceof Error ? undefined : error,
    );
  }
}

function classifyAgentError(
  error: unknown,
  message: string,
  status: number | undefined,
): AgentErrorCode {
  // Typed hierarchy first — the most reliable signal.
  if (error instanceof AIRateLimitError) return 'rate_limited';
  if (error instanceof AISecurityGuardrailError) return 'content_filter';
  if (error instanceof AITimeoutError) return 'timeout';
  if (error instanceof AIBudgetExceededError) return 'budget';
  if (error instanceof AINoProviderError) return 'no_provider';
  if (error instanceof AIPermissionDeniedError) return 'auth';
  if (error instanceof AIValidationError || error instanceof AIToolCallRepairError) {
    return 'invalid_request';
  }
  if (error instanceof AIInvalidConfigError) return 'invalid_request';
  if (error instanceof AIAPIError) {
    if (error.status === 429) return 'rate_limited';
    if (error.status === 401 || error.status === 403) return 'auth';
    if (error.status && error.status >= 500) return 'server';
    if (error.status) return 'invalid_request';
  }

  // Message/status heuristics. Order matters: a 400 carrying content-filter
  // wording is content_filter, a 429 mentioning quota is rate_limited.
  if (status === 429 || RATE_LIMIT_RE.test(message)) return 'rate_limited';
  if (CONTENT_FILTER_RE.test(message)) return 'content_filter';
  if (status === 401 || status === 403 || AUTH_RE.test(message)) return 'auth';
  if (status !== undefined && status >= 500) return 'server';
  if (SERVER_RE.test(message)) return 'server';
  if (status === 400 || status === 404 || status === 422 || INVALID_REQUEST_RE.test(message)) {
    return 'invalid_request';
  }
  if (TIMEOUT_RE.test(message)) return 'timeout';
  if (NETWORK_RE.test(message)) return 'network';
  return 'unknown';
}
