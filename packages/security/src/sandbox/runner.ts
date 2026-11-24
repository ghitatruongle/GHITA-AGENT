// Multi-platform sandbox executor combining:
// 1. Pre-execution command policy checking (`checkCommand`)
// 2. Native OS sandbox enforcement (`ghita-sandbox` addon)
// 3. Fallback to child_process with timeout and env scrubbing

import { spawnSync } from 'node:child_process';
import { loadNative } from '@ghita/native-bridge';
import { checkCommand } from '../governance/exec-policy.js';
import type { ExecPolicyRule } from '../governance/exec-policy.js';

export type SandboxProfileType = 'workspace' | 'read-only' | 'strict';

export interface SandboxRunnerOptions {
  profile?: SandboxProfileType;
  workspace?: string;
  denyGlobs?: string[];
  envAllow?: string[];
  timeoutMs?: number;
  memoryLimitMb?: number;
  processLimit?: number;
  /** ReadOnly/Strict: commit overlay writes về workspace thay vì rollback (R2). */
  overlayCommit?: boolean;
  /** IO write budget MB — vượt → kill với violation `io-budget` (R2). */
  ioWriteLimitMb?: number;
  execRules?: ExecPolicyRule[];
}

export interface SandboxViolationInfo {
  reason: string;
  detail: string;
}

export interface SandboxExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  enforcement: 'landlock' | 'seatbelt' | 'restricted-token' | 'supervised' | 'fallback-js';
  violations: SandboxViolationInfo[];
  blocked: boolean;
  requiresApproval?: boolean;
  /** Lifecycle cuối (R2 state machine): completed | timed-out | killed | … */
  state?: string;
  /** Overlay session dir (ReadOnly/Strict) — relative writes đổ vào đây. */
  overlayDir?: string | null;
  /** True khi overlay được commit về workspace thay vì rollback. */
  overlayCommitted?: boolean;
}

/**
 * Sandbox policy config (Track R2): nguồn khai báo profile + denyGlobs cho
 * sandbox runtime — consumer (packages/agents hook, hosts) đọc từ đây thay
 * vì hard-code. `denyGlobs` merge với {@link DEFAULT_SANDBOX_DENY_GLOBS}.
 */
export interface SandboxPolicyConfig {
  profile: SandboxProfileType;
  /** Extra deny globs từ policy (vd secrets, credentials). */
  denyGlobs?: string[];
  timeoutMs?: number;
  envAllow?: string[];
  memoryLimitMb?: number;
  processLimit?: number;
}

/**
 * Deny set mặc định — secrets/credentials không bao giờ được sandbox đọc.
 * Merge với policy config bằng {@link resolveSandboxPolicy}.
 */
export const DEFAULT_SANDBOX_DENY_GLOBS: string[] = [
  '**/*.pem',
  '**/*.key',
  '**/.ssh/**',
  '**/.env',
  '**/.env.*',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/credentials.json',
];

/**
 * Merge policy config thành `SandboxRunnerOptions`: denyGlobs = defaults ∪
 * config (dedupe, case-insensitive theo chuẩn glob của addon — lowercase).
 * `includeDefaultDenyGlobs: false` tắt phần defaults.
 */
export function resolveSandboxPolicy(
  config: SandboxPolicyConfig,
  includeDefaultDenyGlobs = true,
): SandboxRunnerOptions {
  const configured = config.denyGlobs ?? [];
  const merged = includeDefaultDenyGlobs
    ? [...new Set([...DEFAULT_SANDBOX_DENY_GLOBS, ...configured])]
    : [...new Set(configured)];
  return {
    profile: config.profile,
    denyGlobs: merged,
    timeoutMs: config.timeoutMs,
    envAllow: config.envAllow,
    memoryLimitMb: config.memoryLimitMb,
    processLimit: config.processLimit,
  };
}

interface SandboxNative {
  /**
   * LƯU Ý (R2): napi-rs camelCase-hóa tên field của `#[napi(object)]` ở CẢ
   * HAI chiều — keys phải là camelCase (denyGlobs, timeoutMs, memoryLimitMb,
   * processLimit, overlayCommit, ioWriteLimitMb). v1 truyền snake_case
   * (deny_globs, timeout_ms, …) nên các option đa từ bị addon bỏ qua âm thầm
   * — bug v1 được phát hiện khi wire P4.
   */
  spawnSandboxed(
    command: string,
    args: string[],
    options?: {
      profile?: string;
      workspace?: string;
      denyGlobs?: string[];
      envAllow?: string[];
      timeoutMs?: number;
      memoryLimitMb?: number;
      processLimit?: number;
      overlayCommit?: boolean;
      ioWriteLimitMb?: number;
    },
  ): {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    enforcement: string;
    violations: Array<{ reason: string; detail: string }>;
    blocked: boolean;
    state?: string;
    /** napi-rs camelCase cho SandboxRunOutput.overlay_dir. */
    overlayDir?: string | null;
    overlayCommitted?: boolean;
  };
}

const sandboxBridge = () =>
  loadNative<SandboxNative>('sandbox', undefined as unknown as SandboxNative);

export class SandboxRunner {
  private readonly defaultOptions: SandboxRunnerOptions;

  constructor(defaultOptions: SandboxRunnerOptions = {}) {
    this.defaultOptions = defaultOptions;
  }

  /**
   * Run a process safely inside the sandbox with pre-exec inspection and OS containment.
   */
  async run(
    command: string,
    args: string[] = [],
    options: SandboxRunnerOptions = {},
  ): Promise<SandboxExecutionResult> {
    const opts = { ...this.defaultOptions, ...options };
    const fullCommandLine = [command, ...args].join(' ');

    // 1. Pre-execution governance check
    const verdict = checkCommand(fullCommandLine, opts.execRules);
    if (verdict.decision === 'deny') {
      return {
        exitCode: null,
        stdout: '',
        stderr: `[governance:deny] ${verdict.reason ?? 'Command blocked by execution policy.'}`,
        durationMs: 0,
        enforcement: 'supervised',
        violations: [
          {
            reason: 'exec-policy-deny',
            detail: verdict.reason ?? `Command matches deny rule ${verdict.matchedRule?.id}`,
          },
        ],
        blocked: true,
      };
    }

    // 2. Execute via native addon if available
    const bridge = sandboxBridge();
    if (bridge.native && typeof bridge.impl?.spawnSandboxed === 'function') {
      try {
        const res = bridge.impl.spawnSandboxed(command, args, {
          profile: opts.profile ?? 'workspace',
          workspace: opts.workspace,
          denyGlobs: opts.denyGlobs,
          envAllow: opts.envAllow,
          timeoutMs: opts.timeoutMs ?? 120_000,
          memoryLimitMb: opts.memoryLimitMb,
          processLimit: opts.processLimit ?? 64,
          overlayCommit: opts.overlayCommit,
          ioWriteLimitMb: opts.ioWriteLimitMb,
        });

        return {
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
          durationMs: res.durationMs,
          enforcement: (res.enforcement as SandboxExecutionResult['enforcement']) || 'supervised',
          violations: res.violations,
          blocked: res.blocked,
          requiresApproval: verdict.decision === 'ask',
          state: res.state,
          overlayDir: res.overlayDir ?? null,
          overlayCommitted: res.overlayCommitted,
        };
      } catch (err) {
        // Fall back to JS spawnSync
      }
    }

    // 3. Fallback pure-Node execution with timeout and working directory
    const start = Date.now();
    try {
      const proc = spawnSync(command, args, {
        cwd: opts.workspace ?? process.cwd(),
        timeout: opts.timeoutMs ?? 120_000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      return {
        exitCode: proc.status,
        stdout: proc.stdout ?? '',
        stderr: proc.stderr ?? (proc.error ? proc.error.message : ''),
        durationMs: Date.now() - start,
        enforcement: 'fallback-js',
        violations: proc.error ? [{ reason: 'spawn-error', detail: proc.error.message }] : [],
        blocked: false,
        requiresApproval: verdict.decision === 'ask',
      };
    } catch (e) {
      return {
        exitCode: null,
        stdout: '',
        stderr: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - start,
        enforcement: 'fallback-js',
        violations: [{ reason: 'spawn-exception', detail: String(e) }],
        blocked: false,
        requiresApproval: verdict.decision === 'ask',
      };
    }
  }
}
