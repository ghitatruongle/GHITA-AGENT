# Marketplace v1.1.0 — Track 3: Claude plugins, installer, tiers, scan, trust

Tài liệu cho `packages/marketplace/src/plugins` (mục tiêu 23–27).

## 1. Claude plugin import (`plugins/claude-plugin.ts`) — P37

- `importClaudePluginJson(raw, id)` — chuyển `.claude-plugin/plugin.json` (Claude Code
  ecosystem) thành `PluginManifest` native: name/version/description/author/license/
  repository/entrypoint + permissions suy ra từ shape (mcp → network:http; hooks →
  filesystem:read / notification:send). Thiếu name/version → trả warnings, không manifest.
- `importClaudeMarketplaceJson(raw)` — parse `marketplace.json` (danh sách `plugins[]`
  với source/version/tags); thiếu `source` → plugin bị bỏ qua kèm lý do.
- `loadClaudePluginFromDir(root, id)` — tìm và đọc manifest từ thư mục plugin
  (`/.claude-plugin/plugin.json`, `/.claude-plugin/marketplace.json`, `/plugin.json`,
  `/marketplace.json`).
- `normalizeRepoUrl` — github shorthand (`acme/plugin`) → `https://github.com/acme/plugin`.

## 2. Installer (`plugins/installer.ts`) — P38

- `parsePluginSpec('<user>/<repo>[@tag]')` — hỗ trợ cả scoped name (`@scope/plugin@main`).
- `PluginInstaller.install(spec)` — fetch (mặc định `git clone --depth 1 --branch <ref>`),
  parse manifest, copy files vào `installDir/<id>` (bỏ .git/node_modules), ghi lockfile
  nếu có `LockfileManager`; fetcher **injectable** (chạy offline trong test/CI).
- `installFromLocalDir(dir, id, opts)` — cài từ thư mục local (không cần network).

## 3. Agent-driven install skill (`plugins/agent-installer-skill.ts`) — P39

- `createPluginInstallerSkill({ install, listInstalled })` — skill `$plugin-installer`:
  agent gọi với `input.repo` → discover → install → báo cáo (pattern OpenAI
  `$skill-installer`). Dùng trong session, không cần UI.

## 4. Catalog tiers (`plugins/catalog-tiers.ts`) — P40

- `CatalogTier = system | curated | experimental | quarantined`
- `TieredCatalog` — `add` (gán tier qua `TierRule`), `quarantine(id, reason)` /
  `release(id)` (zone cách ly), `list(tier?)`, `installable()` (system + curated),
  `count()` theo tier.
- Mặc định: id bắt đầu `@ghita/` hoặc `ghita-` → `system`.

## 5. Marketplace view (`plugins/view.ts`) — P41

- `toMarketplaceView(manifests, { tiers, versions, trust })` — rows cho UI:
  version picker (danh sách versions), license badge (class permissive/copyleft/
  proprietary/unknown), tier, quarantine, publisher, downloads/rating, trust badge.

## 6. Supply-chain scan (`plugins/supply-chain.ts`) — P42

- `computePluginHash(dir)` — SHA-256 ổn định theo cây thư mục (bỏ .git/node_modules).
- `heuristicScan(dir)` — quét pattern rủi ro: eval/atob/obfuscation (high),
  exfiltration webhook+credential (critical), download-and-execute (medium).
- `scanPlugin(dir, id, { lookupHash?, env? })` — pipeline: hash → external lookup
  (VirusTotal-style, injectable; `VT_API_KEY` env placeholder) → heuristics →
  verdict `clean | suspicious | malicious | unknown`.
- `renderScanReport(report)` — report markdown (verdict + findings table).

## 7. Trust tiers & publish policy (`plugins/trust.ts`) — P43

- `TrustLevel = trusted | verified | community | quarantined`
- `evaluateTrust(policy, { scanVerdict, reputation })` — scan malicious/suspicious →
  quarantined bất kể policy; giữ trusted/verified.
- `trustBadge(level)` — badge UI.
- `VersionHistory` — ghi version + pin digest, `previous()`/`rollback()` an toàn.
- `canPublish(manifest, policy, scanVerdict)` — gate: chặn publish khi scan xấu,
  publisher bị quarantine, hoặc version không khớp `pinnedTag` (prefix match).

## Exports

```ts
import {
  importClaudePluginJson,
  importClaudeMarketplaceJson,
  loadClaudePluginFromDir,
  PluginInstaller,
  parsePluginSpec,
  createPluginInstallerSkill,
  TieredCatalog,
  assignTier,
  toMarketplaceView,
  scanPlugin,
  renderScanReport,
  evaluateTrust,
  canPublish,
  VersionHistory,
} from '@ghita/marketplace';
```

## Verify

```bash
pnpm --filter @ghita/marketplace typecheck   # 0 lỗi
pnpm --filter @ghita/marketplace test        # 33 tests pass (gồm 33 test Track 3 + suite cũ)
pnpm --filter @ghita/marketplace build
```
