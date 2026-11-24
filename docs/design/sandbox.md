# Sandboxed Execution — `crates/sandbox` (v1.1.5-beta1 Track 1.1)

Zero-dependency sandboxed spawn with three enforcement tiers and graceful
degradation (patterns: grok-build `xai-grok-sandbox`, codex-rs `linux-sandbox`).
Loaded from TS via `@ghita/native-bridge` under the addon name `sandbox`.

## Profiles

| Profile     | Writes                                                              | Notes               |
| ----------- | ------------------------------------------------------------------- | ------------------- |
| `workspace` | beneath the workspace dir + system temp only                        | default             |
| `read-only` | nowhere                                                             | reads everywhere    |
| `strict`    | nowhere + network-facing binaries denied (`curl`, `wget`, `ssh`, …) | hermetic CI posture |

Extra **deny globs** compose with any profile: `**/*.pem`, `**/.ssh/**`,
`**/.env` — matched against every path-like argument and every redirect
target (`>`, `>>`, `2>`).

## Enforcement tiers (auto-detected, reported in the result)

| OS      | Tier         | Mechanism                                                                                                                                                                                                    |
| ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Linux   | `landlock`   | Landlock ruleset applied in `pre_exec` (raw syscalls, no crates) + `PR_SET_NO_NEW_PRIVS`; writes outside the allowed roots fail at the kernel. WSL1 detected (`osrelease` classifier) → supervised fallback. |
| macOS   | `seatbelt`   | `sandbox-exec -p` with a generated SBPL profile (write-denied, workspace subpath allow-listed).                                                                                                              |
| Windows | `supervised` | kill-on-close Job Object containment + redirect/write-target policy precheck + env scrubbing. AppContainer is the documented upgrade tier.                                                                   |

All platforms additionally run the **supervised core**: cwd locked to the
workspace, environment scrubbed to an allowlist (`PATH`, temp, locale, home +
extras), deny-glob argument precheck, write-scope check for redirect targets,
and a hard timeout.

## Result

```jsonc
{
  "exitCode": 0, // null when blocked before spawn
  "stdout": "…",
  "stderr": "…",
  "durationMs": 42,
  "enforcement": "supervised", // landlock | seatbelt | supervised
  "violations": [], // [{ reason: "deny-glob", detail: "…" }]
  "blocked": false, // true → the command never ran
}
```

## Usage (napi, once the addon is built)

```ts
import { loadNative } from '@ghita/native-bridge';

const bridge = loadNative('sandbox');
if (bridge.native) {
  const result = bridge.impl.spawnSandboxed('git', ['push', '--force', 'origin', 'main'], {
    profile: 'strict',
    denyGlobs: ['**/*.pem'],
    timeoutMs: 30000,
  });
}
```

Pre-exec policy violations block the spawn (`blocked: true`, `exitCode: null`)
— combine with the exec policy (`@ghita/security` `checkCommand`) and the
hooks system (`docs/design/hooks.md`) for layered pre-execution governance.

## Tests

`cargo test -p ghita-sandbox` — 7 unit/integration tests: glob matching, WSL
classification, env allowlist, write-target extraction, policy precheck
(deny-glob / write-outside-scope / strict-network), a real spawn that runs a
benign command, and a policy-blocked spawn that never executes. On Linux CI
an additional test asserts Landlock actually denies writes outside the
workspace when the kernel supports it (skipped→supervised otherwise).
