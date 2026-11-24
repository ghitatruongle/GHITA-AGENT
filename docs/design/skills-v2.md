# Skills v1.1.0 — Track 2: Skill schema v2, sandbox, lock, discovery, creator loop

Tài liệu cho các module mới trong `packages/skills/src/v2` (mục tiêu 13–22).

## 1. Schema v2 + validator (`v2/validator.ts`)

Frontmatter SKILL.md v2:

```yaml
---
name: fix-typos
description: 'Use this skill whenever you need to fix typos. Triggers include: typo, spelling'
allowed-tools: file terminal # allowlist adapter keys: file | terminal | screenshot | app
sandbox_permissions: default # default | require_escalated
license: MIT # SPDX / Proprietary
metadata:
  version: '1.2.0' # bắt buộc quoted string khi có script
  internal: true # ẩn khỏi discovery (WIP tier)
sources:
  - name: typo-helper
    url: https://example.com/typo-helper
---
```

- `validateSkillV2(manifest)` → issues/warnings (tên lowercase-hyphen, description bắt buộc,
  allowed-tools phải thuộc danh sách hợp lệ, sandbox_permissions enum, license string,
  metadata.version quoted string, sources array).
- `validateSkillFolder()` — structural contract: skill có `scripts/` phải kèm `tests/<skill>/`.

## 2. Import v2 (`v2/importer.ts`)

- `parseV2Frontmatter(content)` — parser YAML-subset riêng cho v2: hỗ trợ block lồng
  `metadata:` và `sources:` (list `- name:` / `url:`), quotes, bool, number.
- `importSkillV2(source, executor?)` → `{ skill?, skipped[], manifest }` — map đủ các
  trường v2 lên `SkillDefinition` (allowedTools, sandboxPermissions, license, sources,
  metadata.version, metadata.internal) và báo lý do skip khi vi phạm contract.
- `importSkillV2Batch(sources)` — import hàng loạt, trả về danh sách skip theo id.

## 3. Enforcement `allowed-tools` (`v2/enforce.ts`)

- `createToolGate(adapters, allowedTools)` — wrapper deny-default: adapter key không nằm
  trong allowlist bị gỡ khỏi runtime và ghi vào `stats().denied` (có hook `onDeny`).
- `runSkillWithToolGate(registry, id, invocation, adapters)` — chạy skill qua gate và
  trả về danh sách tool bị deny.

## 4. Sandbox (`v2/sandbox.ts`) — P28/P29

- `SkillSandboxRunner` — chạy script skill trong Docker container:
  `--label ghita-sandbox-id=skill`, `--memory`, `--cpus`, `--network none` (mặc định),
  mount workspace `/workspace`.
- **Deny-default**: `SandboxConfig.enabled = false` mặc định; docker không có sẵn hoặc
  bị tắt → từ chối rõ lý do, **không** fallback chạy trên host.
- `dockerAvailable(executor)` — probe `docker version`.

## 5. License engine (`v2/licenses.ts`) — P30

- `LICENSE_MATRIX` — 13 license: permissive/copyleft/proprietary + `importable` gate
  (MIT-compatible: MIT, MIT-0, Apache-2.0, BSD-2/3, ISC, CC0, Unlicense, MPL-2.0).
- `classifyLicense(raw)` — phân loại chịu lỗi viết hoa/đuôi ("Apache License 2.0").
- `generateThirdPartyNotices(entries)` — tạo bảng THIRD-PARTY NOTICES cho attribution.

## 6. skill-lock v3 (`v2/skill-lock.ts`) — P31

- `computeFolderHash(dir)` — hash SHA-256 bền vững theo cây thư mục
  (relative path + size + content, bỏ .git/node_modules) → `folderHash` 32 hex.
- `upsertLockEntry` / `detectLockChanges` — lockfile v3 (`ref`, `sourceType`, `provider`,
  `installedAt`, `updatedAt`, `files`) + phát hiện stale khi bất kỳ file nào đổi.

## 7. Discovery 3 tầng (`v2/discover.ts`) — P32

- `discoverSkills({ userDir, workspaceDir, projectDir, depth=3 })` — quét `SKILL.md`
  theo layout chuẩn (`skills/` hoặc `.skills/`), **shadow rule**: tầng nông hơn thắng
  (user > workspace > project), cùng tầng giữ bản đầu tiên.
- `findSkillMarkdowns(base, maxDepth)`, `parseDiscoveredSkill(file, layer)`,
  `discoveredToSkill(def)` — chuyển discovery thành SkillDefinition stub.

## 8. Skill-creator eval-loop (`v2/creator-loop.ts`) — P33

- `evaluateDraft(draft, { evaluatePrompt, threshold })` — trigger accuracy + quality
  ratio + suggestions (thêm trigger verbs, mô tả rõ ràng hơn, mở rộng description).
- `improveDescription(draft, eval)` — prepend "Use this skill whenever…" khi accuracy thấp.
- `runCreatorLoop(draft, config, maxIterations)` — lặp evaluate → improve có giới hạn.

## 9. Instinct metrics (`v2/instinct-metrics.ts`) — P34

- `InstinctTriggerMetrics.record(skillId, hit)` / `stats(skillId, since?)` →
  hits/misses/precision; `suggestion()` gợi ý viết lại description khi precision < ngưỡng.

## 10. Export đa-harness (`v2/export-harness.ts`) — P35

- `HARNESS_TARGETS`: claude-code → `.claude/skills`, codex/cursor → `.agents/skills`,
  vercel/ghita → `skills/`.
- `skillToMarkdown(skill)` — serialize skill về SKILL.md v2 (giữ đủ trường v2).
- `planExport(skills, harness, { includeInternal })` — plan file tương đối + skip
  internal skills; `exportPlanSummary()` — report text.

## 11. Wiring view (`v2/view.ts`) — P36

- `toSkillListView(skills, lockLookup?)` — rows cho SkillsView: version, license,
  allowedTools, sandbox, internal, enabled, lock status.

## Exports

```ts
import { importSkillV2, validateSkillV2, createToolGate, SkillSandboxRunner,
         computeFolderHash, discoverSkills, runCreatorLoop, planExport, ... } from '@ghita/skills';
// Re-exported qua packages/skills/src/index.ts → export * from './v2/index.js'
```

## Verify

```bash
pnpm --filter @ghita/skills typecheck   # 0 lỗi
pnpm --filter @ghita/skills test        # 329 tests pass (gồm ~35 test v2 mới)
pnpm --filter @ghita/skills build
```
