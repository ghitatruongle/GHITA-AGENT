# Security Policy

> **Version:** v0.0.0-preview
> **Maintainer:** Ghita Agent Security Team (`security@ghita.dev`)
> **Last updated:** 2026-08-23

Ghita Agent takes the security of its users, their devices, and their data seriously. This document describes how to report vulnerabilities, what we support, and the security guarantees built into the project.

---

## 1. Supported Versions

We provide security updates for the following versions:

| Version  | Supported        | Notes                        |
| -------- | ---------------- | ---------------------------- |
| `1.1.5`  | ✅ Active        | Current hardened line        |
| `1.1.x`  | ⚠️ Critical only | Patch-only for critical CVEs |
| `<1.1.0` | ❌ End of life   | Upgrade required             |

We follow [Semantic Versioning](https://semver.org/). Security fixes are released as soon as possible and may be back-ported to the previous minor version when feasible.

---

## 2. Reporting a Vulnerability

**Please do not open a public GitHub issue for security problems.**

### 2.1 Private disclosure channel

- **Email:** `security@ghita.dev`
- **GitHub Security Advisories:** https://github.com/ghitatruongle/GHITA-AGENT/security/advisories/new (preferred for CVE-eligible reports)
- **GPG fingerprint:** `4F2A 9C81 0D7B 3E55 8A02 7C19 B6D4 5E83` _(on request)_

### 2.2 What to include

To help us triage quickly, please include:

1. A clear description of the vulnerability and its impact.
2. Steps to reproduce, ideally with a minimal PoC (code, screenshot, or recording).
3. Affected component (`apps/desktop`, `apps/mobile`, `apps/vscode-extension`, `packages/*`) and version.
4. Environment details (OS, Node 20.x+, Tauri 2.x, etc.).
5. Your assessment of severity (CVSS v3.1 if known).

### 2.3 What to expect

| Stage              | SLA                          |
| ------------------ | ---------------------------- |
| Initial ack        | ≤ **72 hours**               |
| Triage & severity  | ≤ **7 working days**         |
| Patch / mitigation | ≤ **30 days** for `Critical` |
| Public disclosure  | Coordinated, ≤ **90 days**   |

We follow a **coordinated disclosure** model and credit reporters by default unless anonymity is requested.

---

## 3. Threat Model (high level)

GHITA bridges a desktop AI agent (Tauri + React) and a mobile companion app (React Native) over Socket.IO and Bluetooth. The model below describes assets, trust boundaries, and key risks we design against.

### 3.1 Assets

- **User API keys** for OpenAI / Anthropic / Google / Ollama / etc. (stored locally, encrypted at rest)
- **Pairing PIN codes** between desktop and mobile (6-digit, rotated)
- **Local chat history** and **agent memory** (tiered store with PII redaction)
- **Sandboxed computer-use actions** (mouse/keyboard, browser automation)
- **User skills** (user-defined markdown + plugin manifests)

### 3.2 Trust boundaries

```
┌──────────────────────┐                  ┌──────────────────────┐
│  Mobile (RN / BLE)   │  ── Socket.IO ──▶│  Desktop (Tauri)     │
│  untrusted network?  │  ◀─ BLE pairing ─│  Rust core (sandbox)  │
└──────────────────────┘                  └──────────┬───────────┘
                                                    │
                                                    ▼
                                         ┌──────────────────────┐
                                         │  AI Providers / OS   │
                                         └──────────────────────┘
```

### 3.3 Key risks addressed

| Risk                           | Mitigation                                                                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious skill code           | `SkillGuard` hash pin + AST-Lock + plugin manifest review; skills spawn via argv (no shell) with governance denylist                                                             |
| Prompt-injection from web/UI   | Guardrail middleware + enterprise secret detector, both backed by the native `secscan` one-pass pre-filter                                                                       |
| Computer-use overreach         | Per-action approval on mobile + sandbox isolation                                                                                                                                |
| API-key leakage                | OS credential vault is the source of truth; the plaintext `api-config.json` mirror is deleted once the vault write succeeds                                                      |
| Renderer compromise            | Production CSP forbids inline/eval script; FS mutations are scoped to folders the user granted via a native dialog; command approval dialogs show head AND tail of long commands |
| LAN MitM during pairing        | Rotating 6-digit code **plus mandatory desktop-side confirmation**; the device token travels AES-256-GCM-sealed under a key derived from the pairing code                        |
| Paired-device overreach        | Command/edit approvals are desktop-only — a paired phone can never approve its own agent's shell commands                                                                        |
| Local process escalation       | `/health` returns pairing/device data only to callers holding the desktop session token; bind host derives solely from the LAN toggle                                            |
| Outbound dependency compromise | `dependency-review.yml` workflow + `pnpm audit` in CI                                                                                                                            |
| Insecure deserialization       | `resolutions: serialize-javascript ^7.0.5` enforced                                                                                                                              |

---

## 4. Built-in Security Features

GHITA ships with several first-class security packages:

- **`packages/security`** — input sanitization, secret rotation, CORS auditor, audit runner.
- **`packages/skills` → `SkillGuard`** — SHA-256 hash pinning, signed skill manifests, hot-reload protection.
- **`packages/communication` → `GatewayGuardrail`** — DM pairing, content filter, PII redaction.
- **`.ghita/security-blacklist.yaml`** — static blocklist of forbidden APIs/strings, enforced in CI.
- **`.ghita/rules.yaml` → AST-Lock** — protects critical symbols from accidental refactor (`SecurityGate`, `calculateInternal`).
- **`.ghita/checks/no-any.md`** — quality gate forbidding `any` in source paths defined by policy.

---

## 5. Hardening Checklist (for contributors)

Before opening a PR that touches security-sensitive code:

- [ ] No new dependency uses a permissive license incompatible with MIT.
- [ ] No `eval`, `Function()` constructor, or `vm.runInNewContext` on user input.
- [ ] All IPC payloads between Rust ⇄ JS are validated against a schema (Zod / TypeBox).
- [ ] No new raw HTTP clients — use `packages/ai-engine/src/tools/web-fetch.ts`.
- [ ] No raw `child_process.exec` on the mobile side.
- [ ] If you add a new env var, document it in `.env.example` (no real secrets).
- [ ] Run `pnpm lint`, `pnpm typecheck`, and `pnpm test` locally.

---

## 6. Security Advisories

Past advisories and patches are published at:

- `CHANGELOG.md` (search for `### 🛡️ Security`)
- GitHub Security tab → **Advisories** (when severity ≥ High)

---

## 7. Acknowledgements

We thank the following reporters and projects:

- All anonymous contributors via `security@ghita.dev`.
- The OWASP Top-10 and ASVS projects, which inform our threat model.
- The Tauri security advisories and the Rust ecosystem CVE feed.

_Ghita Agent © 2026 — Security is a feature, not a follow-up._
