# Ghita Agent — Project Context

> This file is the canonical **project charter** for the repository. It
> describes what the code in this monorepo actually builds and which
> phases are currently in flight. Historically this file contained the
> leftover notes of an unrelated "Scientific Document Correction" Python
> project — those notes were removed during the **PROJECT.md cleanup
> audit fix**.

## What this project is

Ghita Agent is a **multi-platform, AI-driven coding assistant**
delivered as a Turborepo + pnpm monorepo. It bundles a desktop app
(Tauri + React + Rust), a mobile companion app (React Native +
Kotlin), and a VS Code extension, all sharing a common workspace of
TypeScript packages for AI orchestration, security, memory, and skills.

The product is positioned as a local-first coding agent: the user keeps
their code on their own machine, the agent plans and edits inside that
workspace, and only model calls are sent to upstream providers through a
strictly-scoped proxy.

## High-level architecture

```text
┌────────────────────────────────────────────────────────────────────┐
│                       Ghita Agent                          │
│                                                                    │
│  apps/desktop  ─── apps/mobile  ─── apps/vscode-extension          │
│      │                │                    │                       │
│      └──────┬─────────┴─────────┬──────────┘                       │
│             │                   │                                  │
│  packages/ai-engine   (model gateway, fallback, streaming guardrails)│
│  packages/agents      (multi-agent orchestration, subagent spawner) │
│  packages/memory      (tiered memory, semantic search, sessions)   │
│  packages/skills      (skill hub, marketplace, OAuth handoff)      │
│  packages/security    (input sanitiser, secret rotator, audit)     │
│  packages/communication (daemon, Socket.IO transport, gateways)    │
│  packages/...         (12 other supporting packages)               │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌────────────────────────────┐
              │   Sidecar server.mjs (Tauri) │
              │   Local-only IPC, session    │
              │   token authenticated.       │
              └────────────────────────────┘
```

## Phases in flight

| #   | Phase                                 | Status  |
| --- | ------------------------------------- | ------- |
| 0   | Bootstrap (monorepo, CI, lint, build) | ✅ Done |
| 1   | AI engine + gateway + fallback        | ✅ Done |
| 2   | Multi-agent orchestration             | ✅ Done |
| 3   | Skill hub + marketplace               | ✅ Done |
| 4   | Memory tiering (hot/warm/cold)        | ✅ Done |
| 5   | Desktop app (Tauri shell + UI)        | ✅ Done |
| 6   | Mobile app (React Native + BLE)       | ✅ Done |
| 7   | VS Code extension                     | ✅ Done |
| 8   | Computer-use / GUI agent              | ✅ Done |
| 9   | Voice input + VAD                     | ✅ Done |
| 10  | Quality loop / LLM-as-judge           | ✅ Done |
| 11  | Hardening audit (44 findings)         | ✅ Done |

## Current focus (v0.1.5 Trust Hardening)

- Unified version **0.1.5**
- Honest tiered coverage gates (`docs/coverage-policy.md`)
- Security + agents critical-path tests
- Integrity CI job (version / artifacts / smells)

## Previous focus (Phase 11)

- **44/44 audit findings** closed (see `.agents/orchestrator/codebase_audit_report.md`).
- Coverage uses honest tier floors (see `docs/coverage-tiers.json`). Ship targets for core packages are raised only after measured coverage allows.
- Tauri shell hardened (CSP `frame-src`, IPC `GHITA_SESSION_TOKEN`, panic-free exit via `tauri::async_runtime::block_on`).
- Hard-coded credentials replaced with env-var driven configuration (`GHITA_KEYCHAIN_PASSWORD`, `GHITA_SESSION_TOKEN`, `GHITA_LIBERATE_PORTS`).

## Repository conventions

- **Node**: >= 20.x (pinned in `.nvmrc`).
- **Package manager**: pnpm 9.x with `workspaces` enabled.
- **Build orchestration**: Turborepo (`turbo.json`).
- **TS config**: strict + `noUncheckedIndexedAccess` (`tsconfig.base.json`).
- **Lint / format**: ESLint flat config + Prettier (`eslint.config.js`).
- **Test**: Vitest (`vitest.config.ts`) with v8 coverage.

## Where to read more

- [`README.md`](./README.md) — user-facing overview, screenshots, install.
- [`SECURITY.md`](./SECURITY.md) — threat model, disclosure policy.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — PR conventions, branch model.
- [`docs/architecture.md`](./docs/architecture.md) — deep-dive package map.
- [`.agents/orchestrator/codebase_audit_report.md`](./.agents/orchestrator/codebase_audit_report.md) — current audit findings.

## Owners

- **Codebase**: Ghita Agent maintainers — see `CODEOWNERS`.
- **Security disclosures**: see [`SECURITY.md`](./SECURITY.md).
