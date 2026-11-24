export { InputSanitizer } from './input-sanitizer.js';
export { CorsAuditor } from './cors-auditor.js';
export { SecretRotator, maskKey } from './secret-rotator.js';
export type { SecretRotatorOptions } from './secret-rotator.js';
export { AuditRunner } from './audit-runner.js';
export type { AuditRunOptions } from './audit-runner.js';

// Track S4 optional: hashcash PoW (SHA3-256) cho local API bridge.
export {
  DEFAULT_HASHCASH_BITS,
  DEFAULT_HASHCASH_TTL_MS,
  MAX_HASHCASH_BITS,
  checkHashcash,
  hashcashLeadingZeroNibbles,
  mintHashcash,
} from './hashcash.js';
export type {
  CheckHashcashOptions,
  HashcashCheckResult,
  HashcashStampInfo,
  MintHashcashOptions,
} from './hashcash.js';

// v0.4.9 A1: Local rule-based security scanner (original implementation)
export {
  SecurityScanner,
  InvalidScanTargetError,
  DEFAULT_SCANNER_RULES,
  toSecuritySeverity,
} from './scanner/index.js';
export type {
  ScannerOptions,
  ScanOptions,
  ScanReport,
  FindingSeverityLevel,
  FindingConfidenceLevel,
  FindingLocation,
  ScanFinding,
  ScanFindingsDocument,
  ScanCoverageDocument,
  ScannerRule,
  ScanSummary,
} from './scanner/index.js';

export {
  PolicyEngine,
  PolicyViolationError,
  DEFAULT_POLICY_RULES,
  checkOwaspAgentic,
  checkCommand,
  splitCompound,
  tokenize,
  parseSegment,
  DEFAULT_EXEC_RULES,
} from './governance/index.js';
export type {
  PolicyEngineOptions,
  OwaspCheckOptions,
  PolicyEffect,
  PolicyDecision,
  PolicyRequest,
  PolicyRule,
  PolicyResult,
  OwaspAgenticRiskId,
  GovernanceFinding,
  AgentActionContext,
  CommandSegment,
  ExecPolicyEffect,
  ExecPolicyRule,
  ExecPolicyVerdict,
} from './governance/index.js';

export {
  SandboxRunner,
  DEFAULT_SANDBOX_DENY_GLOBS,
  resolveSandboxPolicy,
  type SandboxProfileType,
  type SandboxRunnerOptions,
  type SandboxViolationInfo,
  type SandboxExecutionResult,
  type SandboxPolicyConfig,
} from './sandbox/index.js';

export type {
  SecurityIssue,
  SecuritySeverity,
  SecurityCategory,
  AuditReport,
  CorsConfig,
  SanitizationRule,
  ApiKeyInfo,
  RotationEvent,
} from './types.js';

export const SECURITY_VERSION = '0.0.2-alpha';
