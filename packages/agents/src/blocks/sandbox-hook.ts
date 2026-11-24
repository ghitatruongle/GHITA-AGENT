// Wire BlockContext.runInSandbox → SandboxRunner (@ghita/security) →
// ghita-sandbox native addon (Track R2, P4). code_sandbox block tự báo lỗi
// khi hook chưa wire — hook này là bản wire production:
//
//   const runInSandbox = createRunInSandbox({
//     workspace: projectDir,
//     policy: { profile: 'strict', denyGlobs: ['**/.secrets/**'] },
//   });
//   new GraphExecutor(registry, { runInSandbox });
//
// Code chạy qua `node -e <code>` với cwd = overlay upper (ReadOnly/Strict):
// mọi write tương đối đổ vào thư mục overlay rồi bị rollback mặc định —
// commit chỉ khi policy bật `overlayCommit`.

import {
  DEFAULT_SANDBOX_DENY_GLOBS,
  SandboxRunner,
  resolveSandboxPolicy,
  type SandboxExecutionResult,
  type SandboxPolicyConfig,
} from '@ghita/security';

/** Options cho {@link createRunInSandbox}. */
export interface RunInSandboxOptions {
  /** Working directory / write scope root của sandbox. */
  workspace?: string;
  /** Policy config: profile + denyGlobs + limits (default profile 'strict'). */
  policy?: SandboxPolicyConfig;
  /** Merge DEFAULT_SANDBOX_DENY_GLOBS vào denyGlobs (default true). */
  includeDefaultDenyGlobs?: boolean;
  /** Node binary thực thi code (default `process.execPath`). */
  nodeExecutable?: string;
  /** Bật overlay commit (mặc định false — rollback mọi write). */
  overlayCommit?: boolean;
  /** Observable: called với result của mỗi lần chạy (audit/log). */
  onResult?: (result: SandboxExecutionResult) => void;
}

/** Lỗi khi code bị sandbox chặn hoặc exit khác 0 — mang nguyên result. */
export class SandboxRunError extends Error {
  constructor(
    message: string,
    public readonly result: SandboxExecutionResult,
  ) {
    super(message);
    this.name = 'SandboxRunError';
  }
}

/**
 * Build hook `runInSandbox(code)` cho `BlockContext` / `GraphExecutorServices`
 * chạy code trong sandbox thật (native addon, JS fallback khi thiếu addon).
 * Mặc định: profile `strict`, denyGlobs = defaults ∪ policy, rollback overlay.
 */
export function createRunInSandbox(
  options: RunInSandboxOptions = {},
): (code: string) => Promise<string> {
  const runnerOptions = resolveSandboxPolicy(
    {
      profile: options.policy?.profile ?? 'strict',
      denyGlobs: options.policy?.denyGlobs,
      timeoutMs: options.policy?.timeoutMs,
      envAllow: options.policy?.envAllow,
      memoryLimitMb: options.policy?.memoryLimitMb,
      processLimit: options.policy?.processLimit,
    },
    options.includeDefaultDenyGlobs ?? true,
  );
  const runner = new SandboxRunner({
    ...runnerOptions,
    workspace: options.workspace ?? runnerOptions.workspace,
    overlayCommit: options.overlayCommit,
  });

  return async (code: string): Promise<string> => {
    const program = options.nodeExecutable ?? process.execPath;
    const result = await runner.run(program, ['-e', code]);
    options.onResult?.(result);

    if (result.blocked) {
      throw new SandboxRunError(
        `[sandbox:blocked] ${(result.stderr || 'command blocked by sandbox policy.').trim()}`,
        result,
      );
    }
    if (result.exitCode !== null && result.exitCode !== 0) {
      throw new SandboxRunError(
        `[sandbox:exit-${result.exitCode}] ${(result.stderr || result.stdout).trim()}`,
        result,
      );
    }
    return result.stdout;
  };
}

// Re-export để host không phải import từ 2 package.
export { DEFAULT_SANDBOX_DENY_GLOBS, resolveSandboxPolicy };
export type { SandboxPolicyConfig, SandboxExecutionResult };
