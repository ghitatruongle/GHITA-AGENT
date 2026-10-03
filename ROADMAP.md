# 🗺️ GHITA CODING AGENT — Public Roadmap

> **Current version:** v1.2.0-demo1 (DEMO — đang thử nghiệm, chưa phải bản phát hành)
> **Last updated:** 2026-10-04

---

## ✅ Done — v1.1.0 Release (2026-08-10)

| Khu vực        | Tính năng                                                                                                                                                                                                             | Trạng thái                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 📦 Release     | Installer v1.1.0 Windows NSIS `GHITA-CODING-AGENT-Setup-v1.1.0.exe` + SHA-256                                                                                                                                         | ✅ Published (tag `v1.1.0` pushed) |
| 🧪 Chất lượng  | **Zero-warning 100%** (typecheck/lint/knip/clippy 0 error 0 warning)                                                                                                                                                  | ✅                                 |
| 🧪 Chất lượng  | **Zero-bug verification xanh** (pnpm test 44/44, evals 79/100, smoke 4/4+4/4, bench, coverage T0/T1)                                                                                                                  | ✅                                 |
| 🧪 Chất lượng  | CR-019 release blocker fixed (shim stream/module exports)                                                                                                                                                             | ✅                                 |
| 🚀 Track 1–12  | Evals & MCP · Skills v2 · Plugins/marketplace · AI Engine/chat · Agents · Memory/RAG · Terminal/Browser · Native Rust (secscan/retrieval/codegraph napi) · Resource budgeting · Deep review · Bug fix · Quality gates | ✅                                 |
| 🚀 Track 13–14 | Release build & installer · Verification & publish (0 bug / 0 warning)                                                                                                                                                | ✅                                 |
| 📜 Tài liệu    | CHANGELOG [1.1.0] · README badge · registry `code-review-findings.md` (CR-001…CR-019)                                                                                                                                 | ✅                                 |

---

| Khu vực       | Tính năng                                                     | Trạng thái |
| ------------- | ------------------------------------------------------------- | ---------- |
| 🤖 AI Agentic | Antigravity edit-review gate (propose → diff → accept/reject) | ✅         |
| 🤖 AI Agentic | Multi-file edit queue + Accept All / Reject All               | ✅         |
| 🤖 AI Agentic | Edit checkpoints + undo (`.ghita/checkpoints/<runId>/`)       | ✅         |
| 🤖 AI Agentic | "Apply to file" on chat code blocks                           | ✅         |
| ✏️ Editor     | Quick File Open (Ctrl+Shift+P, fuzzy)                         | ✅         |
| ✏️ Editor     | Recent-files history (persisted)                              | ✅         |
| ✏️ Editor     | Editor status bar (cursor, selection, word count)             | ✅         |
| ✏️ Editor     | Auto-save (debounced, toggleable)                             | ✅         |
| ⌨️ Shortcuts  | Shortcuts overlay (press `?`)                                 | ✅         |
| 💬 Chat       | Export chat to Markdown                                       | ✅         |
| 💬 Chat       | Chat history cap (200 messages, RAM)                          | ✅         |
| ⚡ RAM        | LRU file cache (128 entries, never drops open tabs)           | ✅         |
| ⚡ RAM        | Low-RAM mode toggle (editor + terminal)                       | ✅         |
| 📦 Install    | One-command setup (setup.ps1 / setup.sh)                      | ✅         |
| 📦 Install    | `pnpm doctor` diagnostics                                     | ✅         |
| 🌐 i18n       | All new keys in 6 locales (en/vi/zh/ru/ja/ko)                 | ✅         |

## ✅ Done — v0.1.5 Trust Hardening (2026-07-22)

| Khu vực           | Tính năng                                 | Trạng thái |
| ----------------- | ----------------------------------------- | ---------- |
| 🔐 Integrity      | Unified version 0.1.5 across monorepo     | ✅         |
| 🧪 Coverage       | Honest tiered coverage gate               | ✅         |
| 🛡️ Security tests | Security unit blitz + deny-path tests     | ✅         |
| 🤖 Agents tests   | ReAct + AdvancedWorkflow regressions      | ✅         |
| 🧰 Toolchain      | pnpm 11.5.2 locked in packageManager + CI | ✅         |
| 📘 Docs           | Coverage policy + Core vs Incubating      | ✅         |
| 📦 Examples       | Runnable dry-run examples                 | ✅         |

> Non-goals deferred: marketplace production, MCP package, iOS App Store, Whisper STT.

---

## ✅ Done — v0.0.5 Official (2026-07-XX)

| Khu vực            | Tính năng                                                                                                  | Trạng thái |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | ---------- |
| 🧠 AI Engine       | Multi-provider (OpenAI, Anthropic, Google, Ollama, LiteLLM)                                                | ✅         |
| 🧠 AI Engine       | Adaptive Router — complexity-based model selection                                                         | ✅         |
| 🧠 AI Engine       | Cost Tracking & Budget Alerts                                                                              | ✅         |
| 🧠 AI Engine       | Tool Registry + Composio catalog (metadata-only; executable handlers require a live adapter + credentials) | ✅         |
| 🤖 Agents          | ReAct Runtime + DAG Flow Orchestrator                                                                      | ✅         |
| 🤖 Agents          | Sub-Agent Spawner (isolated context)                                                                       | ✅         |
| 🤖 Agents          | Agent Groups — specialized teams                                                                           | ✅         |
| 🎯 Skills          | Skill create/edit/run system                                                                               | ✅         |
| 🖥️ Computer Use    | mouse/keyboard/app automation (Tauri-native Rust)                                                          | ✅         |
| 🌐 Browser Control | Playwright + CloakBrowser stealth automation                                                               | ✅         |
| 📱 Mobile          | React Native Android app, remote pairing                                                                   | ✅         |
| 🔐 Security        | Pairing auth, CSP, input sanitization, CORS                                                                | ✅         |
| 📦 Build           | Turborepo + pnpm, CI/CD (Windows/Linux/macOS/Android)                                                      | ✅         |
| 🐳 Docker          | Multi-stage sidecar container                                                                              | ✅         |
| 🔔 Notification    | System with priority, channels, DND, history                                                               | ✅ v0.0.5  |
| 💰 Quota           | Rate Limiter + Usage Tracker + BudgetManager                                                               | ✅ v0.0.5  |
| 📊 Monitoring      | ErrorGrouper + AlertEngine + UsageTelemetry                                                                | ✅ v0.0.5  |
| 🧬 Code Graph      | AST parsing, knowledge graph, symbol search                                                                | ✅ v0.0.5  |
| 🎤 Voice           | Web Speech API STT, VAD, TTS support                                                                       | ✅ v0.0.5  |
| 🍎 iOS             | Ad-hoc build verified, App Store deferred to 0.0.6                                                         | ✅ v0.0.5  |
| 🛡️ Audit           | 44 findings (P1+P2+P3) all closed                                                                          | ✅ v0.0.5  |

---

## 🔜 In Progress — v0.0.6

| Tính năng                                                          | Target                 | ETA     |
| ------------------------------------------------------------------ | ---------------------- | ------- |
| Plugin Marketplace — install, uninstall, dependency resolution     | `packages/marketplace` | Q3 2026 |
| iOS App Store submission + TestFlight setup                        | `apps/mobile/ios`      | Q3 2026 |
| MCP Server Integration — Model Context Protocol                    | `packages/mcp`         | Q3 2026 |
| Voice improvements — Whisper STT (replace Web Speech API fallback) | `packages/voice`       | Q3 2026 |
| Monitoring v2 — Sentry DSN transport, real performance tracing     | `packages/monitoring`  | Q3 2026 |

---

## 📋 Planned — v0.2.0

| Tính năng                   | Mô tả                                                          | Ưu tiên  |
| --------------------------- | -------------------------------------------------------------- | -------- |
| **MCP Server Integration**  | Model Context Protocol — cho phép AI tools giao tiếp chuẩn hóa | 🔴 Cao   |
| **Offline Mode**            | Cache AI responses, sync queue khi mất mạng                    | 🔴 Cao   |
| **Extension SDK**           | Public API + example plugins cho bên thứ 3                     | 🔴 Cao   |
| **iOS Release**             | Build iOS app + App Store deployment                           | 🔴 Cao   |
| **BLE Fallback**            | Bluetooth Low Energy cho remote control khi không có WiFi      | 🟡 Trung |
| **Visual Regression Tests** | Playwright snapshot diff cho desktop UI                        | 🟡 Trung |
| **Storybook**               | UI component showcase cho desktop app                          | 🟡 Trung |
| **Project Wizard**          | Scaffolding template cho projects mới                          | 🟡 Trung |

---

## 🔮 Future — v0.3.0+

| Tính năng                             | Mô tả                                            |
| ------------------------------------- | ------------------------------------------------ |
| **Native Windows/macOS Code Signing** | Authenticode + notarize cho production releases  |
| **Auto-Update Channel**               | Stable/Beta/Canary release channels              |
| **SBOM Generation**                   | CycloneDX Software Bill of Materials mỗi release |
| **Performance Regression Gate**       | CI tự động cảnh báo nếu benchmark degrade >5%    |
| **Penetration Testing Program**       | Bug bounty + security audit                      |
| **Community Chat**                    | Discord/Slack server cho contributors            |
| **i18n Completion**                   | Full internationalization support                |
| **Desktop Linux Distribution**        | Snap/Flatpak packages                            |

---

## 🤝 Đóng góp

Xem [CONTRIBUTING.md](./CONTRIBUTING.md) để biết cách tham gia phát triển.

> **Lưu ý:** Roadmap này có thể thay đổi dựa trên phản hồi của cộng đồng và ưu tiên kinh doanh.
