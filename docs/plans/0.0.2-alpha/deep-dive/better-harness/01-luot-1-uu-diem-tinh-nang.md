# better-harness — Lượt 1: Tổng quan, tính năng & ưu điểm áp dụng

> **Dự án:** QoderAI/better-harness v0.5.0 — plugin/skill audit quy trình làm việc AI chạy bên trong 10 host coding agent (Qoder, Claude Code, Codex, Cursor, Copilot, Qwen, Pi, Kimi, WorkBuddy, Grok) · MIT (đã xác minh) · thuần JS ESM Node ≥22, 2 runtime deps (tree-sitter-wasm + esbuild-wasm), ~73k dòng scripts + ~50k dòng test · clone: `refer_project/ai-tools/better-harness`
> **Phương pháp:** 2 subagent khảo sát song song 22/11/2026, chỉ đọc mã nguồn. Subagent 1 = tổng quan & tính năng; Subagent 2 = ưu điểm & áp dụng vào Ghita.

## Tóm tắt nhanh (tổng hợp)

- KHÔNG phải eval framework cho LLM — là plugin đánh giá **harness** (quy trình agent) thay vì đánh giá model: CLI thu evidence-bundle → 3 agent read-only song song → lead hòa giải + freeze score → báo cáo HTML/findings.json machine-validated.
- Evaluation model "Agent Work Loop": 5 dimension × 15 check, 7 trạng thái bằng chứng (evidence) làm trần điểm 59/74/84/94/100, nguyên tắc "configured capability is not observed use".
- **Ghita đã hấp thụ từ trước:** 5 dims/15 checks, trần điểm, floor 35, repair progress, longitudinal SQLite (`packages/agents/src/harness/work-loop.ts:19-36`, `packages/evals/src/longitudinal.ts`).
- **Gap lớn nhất chưa lấy:** EvidenceLevel 4 mức vs 7 trạng thái đầy đủ, Intervention Ledger (guardrail metric + state machine + stop/revert), score-finding consistency gate, finding emission bar, privacy sanitizer, evidence-bundle freeze — đề xuất 10 items A1-A10 có xếp hạng ưu tiên.
- License MIT an toàn cho Ghita. Không nên học: hệ 11 host adapters, Canvas style Qoder-specific, văn bản điều lệ ultra-dense.

---

# better-harness — Subagent 1: Tổng quan & tính năng

Repo khảo sát: `D:\GHITA AGENT\refer_project\ai-tools\better-harness` (clone QoderAI/better-harness, @qoder-ai/better-harness v0.5.0). Toàn bộ nhận định dưới đây kèm bằng chứng `path:line` relative tới root repo.

## 1. Dự án là gì

- **Bản chất**: Better Harness KHÔNG phải eval framework cho LLM/model, mà là một "harness engineering" toolkit dạng plugin/skill chạy BÊN TRONG coding agent (Claude Code, Codex, Qoder, Cursor, Copilot CLI...), để **đánh giá quy trình làm việc AI xung quanh code diff** và xuất báo cáo có bằng chứng kèm đề xuất sửa. Tagline: "Delegate coding to agents. Improve the loop around them." (README.md:8).
- **Vấn đề giải quyết**: review chỉ final diff sẽ bỏ sót vấn đề hệ thống — mục tiêu mơ hồ, bước improvised, "it works" không bằng chứng, bỏ qua safeguard, bài học bị mất (README.md:76-92).
- **Ai dùng**: team/dev dùng AI coding agent muốn audit & cải thiện workflow của chính agent đó; tác giả là Qoder (công ty IDE AI, package.json:8-10).
- **Mô hình sử dụng**:
  1. Slash-command skill `/better-harness` cài qua plugin marketplace của từng host (README.md:166-188).
  2. Standalone Node CLI `better-harness` (bin → scripts/better-harness.mjs, package.json:72-74) cho thu thập evidence deterministic + render báo cáo.
  3. Không có chế độ CI/server chính; mọi thứ là read-only, chạy local, host agent tự làm "judge".
- **3 lớp mở (README.md:129-145)**: (1) engineering practices — `references/`; (2) evaluation model — `models/agent-work-loop.md`; (3) runnable implementation — `skills/`, `scripts/`, `hooks/`, `templates/`.

## 2. Kho tính năng theo chủ đề

### 2.1 Evaluation workflow (luồng `/better-harness` — skills/better-harness/SKILL.md)

- **Step 1**: freeze scope + thu `harness evidence-bundle` (topology, provider, window, depth; quick = 3 assets/7 ngày, normal = 5 assets/30 ngày) (SKILL.md:11-67).
- **Step 2**: chạy **đúng 3 agent read-only song song**: Session Evidence, Project Harness Evidence, Agent Customize Evidence; hard cap 3 agent delegated; specialist không được chấm điểm (SKILL.md:69-119).
- **Step 3**: lead agent hòa giải candidate → merge theo (target, consequence, owner, repair route) → freeze severity + 5 dimension scores → chọn support track Bootstrap (0→1) / Operationalize (1→60) / Optimize (60→100) / Undetermined (SKILL.md:121-176).
- **Step 4**: render một lần duy nhất qua `harness render --validate`, chỉ pass khi `status: pass`; cấm viết tay HTML/Canvas/Markdown (SKILL.md:178-197).
- **Step 5**: follow-up — finding-bound fix (agent độc lập chấm verified/partial/blocked), usage-summary, Loop Discovery (SKILL.md:198-215).

### 2.2 Evaluation model — "Agent Work Loop"

- 5 dimension × 15 check id ổn định: Task Understanding, Controlled Execution, Change Validation, Reliable Delivery, Learning Capture (models/agent-work-loop.md:83-89).
- Đơn vị review là **Task Episode** (1 user goal + 1 acceptance boundary, có thể跨 nhiều session) (agent-work-loop.md:13-16).
- **Thang evidence state**: `Present → Wired → Exercised → Outcome-supported`, cộng `Missing / Unobserved / Not applicable` (agent-work-loop.md:95-103); trần điểm theo state cao nhất: 59/74/84/94/100 (agent-work-loop.md:110-118). Learning Capture do agent chấm 35–100 (agent-work-loop.md:136-143).
- Nguyên tắc chống "điểm ảo": "A configured capability is not observed use" (agent-work-loop.md:55); điểm không sinh/hủy finding; không suy dimension score từ count finding (agent-work-loop.md:121-134).

### 2.3 Metrics đo gì

- **Không đo accuracy model**. Đo chất lượng workflow: 5 dimension score 0–100 ("Loop Effectiveness"), findings có severity + evidence boundary + verifier, Evidence Brief (README.md:118-127).
- **Usage/cost**: `session-analysis usage-summary`, daily-usage, model-pricing → chi phí token theo model (scripts/session-analysis/usage-summary.mjs, model-pricing.mjs); session efficiency, long-sessions, tool-call-trace, file-reads (scripts/session-analysis/).
- **Regression so sánh dọc thời gian**: intervention ledger lưu trong findings.json, chỉ báo "Loop Effectiveness" thay đổi khi có Task Episode sau tương đương (agent-work-loop.md:151-165, 636-653); "Passing a current check proves intervention was exercised; only a comparable later result can prove improvement" (README.md:124-127).
- **Asset inventory**: Rules/Skills/MCP/Memory/Agents/Hooks/Commands/Workflows/Plugins — chỉ dùng để route inspection, count không tạo finding (SKILL.md:57-62).

### 2.4 Feedback loop

- Feedforward: AGENTS.md, specs, Skills, acceptance criteria; Feedback sensors: linters, tests, Hooks, eval agents (README.md:100-104).
- Loop Discovery + Loop Engineering: chọn "smallest durable owner" cho repeated work qua coverage ladder (observed → built-in → configured → extend → create) (agent-work-loop.md:679-692; references/loop-engineering/loop-discovery.md).
- Learning Capture: phát hiện repeated opportunity ≥2 Task Episode tương đương → candidate → owner → longitudinal validation (agent-work-loop.md:520-789).
- Hooks thực thi: blast-radius (tree-sitter phân tích ảnh hưởng go/js/python), test-mapping, mapping-gate, review-trigger, secret-scan guard (hooks/git-scripts/, scripts/agent-guardrails/secret-scan.mjs).

### 2.5 Báo cáo / dashboard

- 4 output mode: **Qoder Canvas**, **Cursor Canvas**, **HTML self-contained** (report.html + report.md + findings.json), **Markdown-only** (docs/docs/hosts/adapter-matrix.md:67-77).
- Report history: xem 5 dimension theo thời gian (demo assets/demo/twenty-history.png, README.md:66-74); sample report đầy đủ: assets/demo/better-harness-report.html.
- 7 style template báo cáo (analyst, audit-scorecard, consulting-deck, editorial-insight, engineering-diagnosis, executive-dashboard, transformation-playbook — templates/style/); Canvas TSX ~2.5k dòng (templates/canvas/better-harness-insights.canvas.tsx 2071 dòng).
- Quality gates máy kiểm tra: harness-report-quality, score-finding-consistency, validate-canvas (scripts/harness-analysis/report-quality.mjs, score-finding-consistency.mjs).

### 2.6 Tích hợp

- **10 host adapter** (docs/docs/hosts/adapter-matrix.md:24-39): Qoder, Claude Code, Codex, Cursor, Qwen Code, GitHub Copilot, Pi, Kimi Code, WorkBuddy, Grok — mỗi host có shell manifest riêng (.claude-plugin/, .codex-plugin/, .cursor-plugin/, .qoder-plugin/, .kimi-plugin/, qwen-extension.json, pi manifest trong package.json:29-36) + provider inventory + session-evidence adapter (scripts/session-analysis/platforms/ đủ 10 host; scripts/agent-customize/providers/ đủ 10 host).
- **Read-only plugin lifecycle control plane**: `plugin status/plan/verify` + `doctor` trên 8 host profile × 11 surface; `plugin plan` xuất typed argv KHÔNG bao giờ tự execute mutation (CHANGELOG.md:10-19; scripts/plugin-lifecycle/).
- **Không gọi API model provider nào**: deps chỉ `@vscode/tree-sitter-wasm` + `esbuild-wasm` (package.json:95-98) — host agent đóng vai trò LLM judge, phần JS thuần deterministic.
- **CI**: .github/workflows/ci.yml, release.yml (npm publish + provenance), pages.yml (Docusaurus site zh-Hans i18n — docs/docusaurus.config.js, docs/i18n/zh-Hans/).

### 2.7 CLI/API surface chính (scripts/better-harness-cli/registry.mjs:17-287)

- `report` (alias quickstart), `agent-customize`, `plugin` (status/plan/verify), `doctor`, `agent-lint`, `cloc`, `dependency-governance`, `session-analysis` (sources/sessions/facets/insights/facts/usage-summary/file-reads/show/events), `coding-agent-practices` (asset-baseline/inventory/asset-integrity), `core-change-watch` (change-drift/core-candidates/diff-impact/evidence-pack/git-history-profile/project-profile), `harness` (evidence-bundle/workspace-topology/analyze/checkup/source/source-review/task-loop-report/render/preview-canvas/report-quality/repair-findings/record-fix-output/validate-canvas).
- Quy ước CLI agent-friendly: human-first mặc định + `--json`/`--no-color`/`--dry-run`/`--timeout` machine-first, tách plan vs mutation, stdout parser-safe (docs/ARCHITECTURE.md:171-183).

## 3. Trạng thái dự án

- **License**: MIT, "Copyright (c) 2026 Qoder" (LICENSE:1-3; package.json:5).
- **Ngôn ngữ/framework**: thuần JavaScript ESM (Node >=22.20.0 <25, package.json:91-94), không framework runtime; docs site dùng Docusaurus; Canvas report là React/TSX (chỉ cho Qoder/Cursor render).
- **Kích thước**: 644 file (không tính .git/node_modules); 248 file .md ≈ 34k dòng hướng dẫn/spec; 339 file .mjs; scripts/ ≈ 73k dòng; test/ ≈ 50k dòng, ~95 test file (`node --test`, package.json:83).
- **Cấu trúc top-level**: `skills/` (1 skill), `scripts/` (~25 capability dir), `models/`, `references/` (4 domain + bootstrap + loop-engineering), `hooks/`, `templates/`, `prompts/`, `case-studies/`, `docs/`, `test/`, 7 plugin metadata root, `AGENTS.md`, `roadmap.md`, `CHANGELOG.md`.
- **Version + activity**: v0.5.0 (2026-08-04, CHANGELOG.md:6); clone có 155 commit, 2026-07-27 → 2026-08-11; tags v0.4.1, v0.5.0. Contributor chính: Phodal Huang (68+35 commit — Fengda Huang trùng người), abel, 李颖琨, 靳崇力, UIOSUN, dependabot + ~5 người nữa (git shortlog). Dự án mở source 2026-07-30 (docs/blog/2026-07-30-better-harness-is-now-open-source.md) — rất mới, nhịp commit dày.
- **Roadmap** (roadmap.md): P0→P3 gồm LC-04 "trajectory-native Harness Eval Lab" (replay, pairwise compare, held-out, ablation, judge disagreement, cost), LC-06 Durable Loop Runtime (validate/plan/run/resume/stop/budgets), LC-07 Intervention Engine, LC-09 long-horizon benchmark, LC-11 Harness Diff as PR/CI artifact, LC-12 Loop Packs registry (roadmap.md:60-77) — hướng tới eval suite + experiment engine thật sự, hiện sản phẩm dừng ở "Observe → Diagnose → Report → Recommend" (roadmap.md:119-121).

## 4. 5 điểm độc đáo nhất

1. **Đánh giá harness thay vì đánh giá model**: mô hình Agent Work Loop 5×15 check với thang evidence `Present→Wired→Exercised→Outcome-supported` làm trần điểm cứng — thiết kế chống "điểm tự tin ảo" hiếm thấy trong các eval tool (models/agent-work-loop.md:95-118, 55).
2. **Pipeline multi-agent có kỷ luật**: collectors JS deterministic (`harness evidence-bundle`) + đúng 3 agent read-only song song + lead hòa giải với quality gates và freeze score trước khi viết copy — một pattern orchestrator-critic có test riêng (SKILL.md:69-176; test/harness-report-quality.test.mjs, score-finding-consistency.test.mjs).
3. **Adapter matrix 10 host với lifecycle control plane read-only**: chuẩn hóa cài đặt/verify/plan qua 8 profile × 11 surface, xuất typed argv nhưng fail-closed, không bao giờ tự mutate host (docs/docs/hosts/adapter-matrix.md:24-63; scripts/plugin-lifecycle/plan.mjs).
4. **Kỷ luật bằng chứng & privacy tuyệt đối**: missing evidence luôn explicit (`Unobserved`), redacted semantic facets, cấm copy raw prompt/secret vào report, bundle fail-closed khi mâu thuẫn (agent-work-loop.md:75-76; SKILL.md:48-62; CHANGELOG.md:122-126).
5. **Báo cáo portable + intervention ledger dọc thời gian**: findings.json là hợp đồng dữ liệu (reportContractVersion, templates/reporting/harness-findings.input.json:1-25), HTML self-contained mở được không cần host, ledger cho phép so sánh trước/sau sửa finding — tiền đề cho eval regression của _workflow_ chứ không phải của code.

---

# better-harness — Subagent 2: Ưu điểm & áp dụng vào Ghita

Repo: `refer_project/ai-tools/better-harness` (QoderAI/better-harness v0.5.0). READ-ONLY.
License: **MIT** (`LICENSE:1`, `package.json:5`) — an toàn với ràng buộc cấm GPL/AGPL của Ghita.
Runtime deps chỉ 2: `@vscode/tree-sitter-wasm`, `esbuild-wasm` (`package.json:95-98`); Node >=22.20 (`package.json:92`); ~94 test files `node --test` (`test/`), CI 4 ma trận OS/Node (`.github/workflows/ci.yml:15-30`).

---

## 1. Ưu điểm nổi bật (xếp hạng)

1. **Mô hình bằng chứng 7 trạng thái + trần điểm (evidence ceiling) — lõi của cả hệ.**
   `models/agent-work-loop.md:96-103` định nghĩa `Present / Wired / Exercised / Outcome-supported / Missing / Unobserved / Not applicable`; bảng trần điểm tuyệt đối 59/74/84/94/100 (`models/agent-work-loop.md:110-118`). Nguyên tắc gold: _"A configured capability is not observed use"_ (`models/agent-work-loop.md:55`) — cấu hình tồn tại chỉ chứng minh `Present`, chỉ task-link mới chứng minh `Exercised`. Tách bạch "không quan sát được" (`Unobserved`) khỏi "xác nhận thiếu" (`Missing`) — cùng trần 59 nhưng ý nghĩa finding khác nhau.

2. **Finding emission bar — điều kiện "emit only when" cho từng finding.**
   Mỗi check có mục _Typical findings_ với điều kiện phát hành chặt + negative condition (`models/agent-work-loop.md:238-259, 309-334, 415-440, 493-518`). Finding cần đủ 4 thứ: inspected gap, bounded impact, smallest owner-aligned repair, validation route (`models/agent-work-loop.md:127-134`); _"Scores never require JavaScript to create or demand a finding"_ (`:145-149`) — điểm thấp là gợi ý soi lại bằng chứng, không tự sinh finding. Đây là cơ chế chống hallucination trong report.

3. **Intervention Ledger — đo hiệu quả can thiệp long-giờ bằng state machine + guardrail metric.**
   `scripts/harness-analysis/intervention-ledger.mjs:26-32`: `pending → improving | unchanged | regressing | outcome-supported`. `:194-217`: state `improving`/`outcome-supported` PHẢI cải thiện primary metric **và không** làm xấu guardrail metric; `outcome-supported` cần `outcomeEvidenceRefs` riêng (`:203-210`). Bắt buộc `stopOrRevertCondition` (`:278`), ≥2 candidate causes có bằng chứng (`:237-253`), comparability window `comparable/unverified/not-comparable` (`:35, 119-132`). Regression ⇒ block hiệu quả tổng (`:388-392`). Đây là "regression detection cho prompt/context improvement" — đúng tinh thần eval loop.

4. **Score-finding consistency gate — điểm thấp phải có finding linked hai chiều.**
   `scripts/harness-analysis/score-finding-consistency.mjs:28-37`: dimension score < 70 mà không có finding nào `findingRefs → finding.dimensionRefs → dimension` là lỗi machine-validation. Reverse-link bắt buộc cả ở phía Learning Capture (`models/agent-work-loop.md:620-622`).

5. **Kiến trúc 3 evidence agents độc lập + lead reconciliation một lần.**
   `skills/better-harness/SKILL.md:69-119`: 3 agent read-only chạy song song (session / project-harness / agent-customize), KHÔNG nhận conclusion của nhau, cap cứng 3 delegated agents; lead hợp nhất đúng 1 lần rồi **freeze** severity + dimension scores trước khi viết copy/priority moves (`:129-143`). Mỗi lane unavailable/partial phải explicit (`:115-119`) — không được thay bằng "unobserved" tùy tiện.

6. **Evidence bundle CLI contract — freeze ngữ cảnh trước khi delegation.**
   `scripts/harness-analysis/evidence-bundle/contract.mjs:43-116`: `freezeEvidenceBundleContext()` `Object.freeze` workspace/provider/window/depth/limit/authority vào một bundle versioned duy nhất; sai topology target fail-closed (`:78-99`). Một lệnh `harness evidence-bundle ...` thay cho N lệnh rời rạc — DX tốt cho agent orchestrator.

7. **Privacy-safe evidence pipeline — sanitize trước khi render.**
   `scripts/session-analysis/privacy-safe-text.mjs:58-81`: strip bearer/api-key/sk-ghp/xox/AKIA, path tuyệt đối Windows/POSIX, UUID, session-id thành `<secret>/<path>/<id>`; bỏ injected XML blocks và transcript tail lồng nhau (`:1-7, 89-107`). Intervention ledger tự scan secret + cấm field `raw_*`/`sessionId`/absolute path (`intervention-ledger.mjs:37-43, 53-91`).

8. **Task Episode contract — tái tạo task có biên giới từ transcript thô.**
   `scripts/session-analysis/episode-contract.mjs:10-45`: schema versioned, gap 30 phút, nhận diện edit event (Edit/Write/apply_patch/outside-workspace filter `:96-130`), 13 regex VALIDATION_PATTERNS (npm/vitest/jest/pytest/go/cargo/typecheck/lint...), fingerprint sha256 ổn định (`:47-49`). Một "review unit" thống nhất thay vì đếm aggregate.

9. **Loop Discovery — coverage ladder + decision gate 10 tiêu chí + runtime-fit check.**
   `references/loop-engineering/loop-discovery.md:61-92`: phân loại workflow / agent / evaluator-optimizer / scheduled / human-gated / skill-shaped; _"Do not promote an autonomous agent when a deterministic workflow... gives tighter control"_ (`:91-92`). Decision gate 10 tiêu chí (`:94-121`) gồm bắt buộc verification + stop condition + safety + state + observability + evaluation contract TRƯỚC khi đề xuất loop mới. Coverage ladder: observed → built-in → configured → extend → create (`models/agent-work-loop.md:684-691`).

10. **Learning-loop detection patterns với negative control cho từng pattern.**
    `references/loop-engineering/learning-loop-patterns.md:52-66`: 10 pattern (repeated-rediscovery, recurring-correction, present-but-not-routed, routed-but-not-applied, correction-not-promoted...), mỗi pattern khai báo required signature + broken stage (capture/generalize/codify/route/exercise/evaluate/maintain) + **negative control**. Provenance 4 lớp `host-observed / deterministic-derived / ai-reviewed / unavailable` (`:23-30`); MVP recurrence = 2 episodes cùng reviewed signature (`:36-38`).

11. **Report là artifact machine-validated, cấm agent viết tay.**
    `skills/better-harness/SKILL.md:178-194`: render qua CLI `--validate --json`, chỉ thành công khi `status: pass`, _"Never hand-write Canvas, Markdown, or HTML"_. `report-quality.mjs` (1231 dòng) kiểm tra sections bắt buộc (`:9-17`), phát hiện aiFixPrompt hụt (`:549, 680`), nhảy target-level vô căn cứ (`:391-426`). Finding schema chuẩn kèm `aiFixPrompt` có mục Validation (`templates/reporting/harness-findings.input.json:39-45`).

12. **Finding-bound repair + independent post-fix reviewer.**
    Fix chỉ được cập nhật Repair Progress (`verified/partial/blocked`) qua reviewer độc lập, KHÔNG được nâng dimension score trong cùng window (`models/agent-work-loop.md:152-164`); Loop Effectiveness chỉ đổi khi có episode sau so sánh được — chống "tự chấm điểm mình vừa sửa".

## 2. So sánh với những gì Ghita đã hấp thụ trước đây

Đã có trong Ghita (`packages/agents/src/harness/work-loop.ts`, `packages/evals`):

- 5 dims / 15 checks — `work-loop.ts:19-25` ✓
- Trần điểm 59/74/84/94/100 theo evidence state — `work-loop.ts:28-36` ✓
- Learning Capture floor 35; finding kéo điểm -6/-8 — `work-loop.ts:50, 130-133` ✓
- Repair progress verified/partial/blocked không đổi score — `work-loop.ts:144-150` ✓
- Longitudinal SQLite: trend, delta theo version — `packages/evals/src/longitudinal.ts:74-107` ✓

**Gap chưa lấy (theo mức quan trọng):**

1. `EvidenceLevel` của Ghita chỉ 4 mức `missing|observed|artifact|outcome-supported` (`packages/evals/src/types.ts:16`) — mất phân biệt `Present/Wired/Exercised` và `Unobserved ≠ Missing`.
2. So sánh before/after chỉ delta score, **không có guardrail metric, comparability state, stop/revert** (`longitudinal.ts:95-107` vs `intervention-ledger.mjs:139-217`).
3. Không có score-finding consistency gate; không có finding emission bar; không có privacy sanitizer; không có evidence-bundle freeze; không có report render-validate.

## 3. Cái hay áp dụng vào Ghita (mapping)

| #   | Ý tưởng / kỹ thuật                                                                                                             | Nguồn BH                                                               | Mapping Ghita                                                                                                                                                                                    | Giá trị   | Độ khó                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------------------------------------- |
| A1  | **Score-finding consistency gate**: điểm < 70 phải có finding linked 2 chiều                                                   | `score-finding-consistency.mjs:1-38`                                   | `packages/agents/src/harness/work-loop.ts` (validate trước khi xuất `WorkLoopReview`) + `packages/evals/src/report.ts`                                                                           | Cao       | Dễ (~40 dòng, copy gần như nguyên văn, MIT) |
| A2  | **Intervention ledger cho prompt/context**: primary + guardrail metric, state machine 5 trạng thái, comparability, stop/revert | `intervention-ledger.mjs:26-32, 139-217, 278`                          | `packages/evals/src/longitudinal.ts` — mở rộng `compare()` thành `InterventionEntry` validate (primary=avg score, guardrail=vd test pass-rate/blast-radius count của `scripts/blast-radius.mjs`) | Cao       | Trung                                       |
| A3  | **7 evidence states + Unobserved ≠ Missing**                                                                                   | `models/agent-work-loop.md:96-103`                                     | `packages/evals/src/types.ts:16` nâng `EvidenceLevel` lên đủ 7; `scoring.ts` map lại ceiling                                                                                                     | Cao       | Dễ–Trung                                    |
| A4  | **Finding emission bar ("emit only when") + cấm score tự sinh finding**                                                        | `models/agent-work-loop.md:127-134, 145-149`                           | Prompt review của Agent Work Loop (track5 `review.ts`) + doc `packages/agents/src/harness/` — thêm mục "Typical findings / emit only when"                                                       | Cao       | Dễ (chỉ prompt/doc)                         |
| A5  | **Privacy-safe sanitizer cho evidence/report**                                                                                 | `privacy-safe-text.mjs:58-81`                                          | `packages/evals/src/report.ts` trước khi ghi report/log trajectory (trajectory có thể chứa token/file path)                                                                                      | Trung–Cao | Dễ (copy regex set)                         |
| A6  | **Evidence-bundle freeze**: 1 lệnh versioned, Object.freeze context, fail-closed sai scope                                     | `evidence-bundle/contract.mjs:43-116`                                  | `packages/evals/src/runner.ts` — freeze suite/version/adapter/window trước khi chạy                                                                                                              | Trung     | Dễ                                          |
| A7  | **Loop Discovery decision gate + coverage ladder** (trước khi tạo skill/automation mới)                                        | `loop-discovery.md:61-121`; ladder `models/agent-work-loop.md:684-691` | `packages/skills` + Agent Work Loop check `loop-engineering` — gate "đã thử coverage chưa" trước khi đề xuất tạo skill mới                                                                       | Trung     | Trung                                       |
| A8  | **Learning-loop patterns + negative controls** để phát hiện lặp lại từ session Ghita                                           | `learning-loop-patterns.md:23-66`                                      | `packages/evals` mở thêm detector trên session logs local-first; mỗi pattern có negative control fixture                                                                                         | Trung     | Trung                                       |
| A9  | **Report render-validate pipeline** (agent không được viết report tay)                                                         | `SKILL.md:178-194`                                                     | `packages/evals/src/report.ts` — render từ data + validate schema, fail nếu thiếu section                                                                                                        | Trung     | Trung                                       |
| A10 | **Task Episode reconstruction từ transcript** (gap 30', validation patterns, edit-event)                                       | `episode-contract.mjs:10-130`                                          | `packages/evals/src/replay.ts` + `packages/monitoring` — dựng episode từ session Ghita để feed A8                                                                                                | Trung     | Khó                                         |

**Thứ tự đề xuất:** A1 → A4 → A3 → A5 (đều dễ, giá trị cao) rồi A2 (trung) — A2 là nâng cấp lớn nhất cho "feedback loop vào prompt/context" vì nó biến longitudinal delta thành bằng chứng có guardrail.

## 4. Hạn chế / rủi ro

- **License: đã xác minh MIT** (`LICENSE:1-22`, `package.json:5`) — không rủi ro GPL/AGPL.
- **Maturity**: v0.5.0, open-source mới 2026-07-30 (`docs/blog/2026-07-30-better-harness-is-now-open-source.md`), tag chỉ v0.4.1/v0.5.0; external contributors 2 PR (`git log`: U1oSun, tanjiawen) — bus factor thấp, gắn Qoder.
- **Vendor coupling**: Qoder/Cursor Canvas pipeline (`templates/canvas/*.tsx`, `scripts/harness-analysis/renderers/qoder-canvas.mjs`, canvas-preview cần "Qoder runtime" theo `README.md:404-406`) và adapter 11 host đọc format transcript nội bộ từng host (`scripts/session-analysis/platforms/*.mjs`) — dễ vỡ khi host đổi format.
- **Prompt-as-code**: phần lớn "engine" sống trong MD (`models/agent-work-loop.md` 820 dòng, `skills/` + `references/` ~50 file) — không test tự động được phần đó; chỉ lớp JS deterministic mới có 94 test files.
- **Validator regex nặng**: `report-quality.mjs` 1231 dòng regex song ngữ en/zh — brittle, khó port.
- **Nhiều nội dung đánh giá là heuristic LLM-judge** (Agent tự chấm), không phải eval metric tự động như `packages/evals` của Ghita — BH đo _workflow harness_, Ghita đo _agent run_; hai lớp bổ trợ chứ không thay thế.

## 5. Ba thứ KHÔNG nên học

1. **Hệ thống 11 host adapters + plugin lifecycle** (`scripts/host-support/`, `scripts/agent-customize/providers/*.mjs`, `scripts/plugin-lifecycle/`, `docs/docs/hosts/adapter-matrix.md`): Ghita là agent độc lập local-first, không cần đóng plugin cho claude/codex/cursor/qoder/kimi/qwen/workbuddy/grok; chi phí duy trì khổng lồ và phụ thuộc format nội bộ host — khác hoàn toàn bài toán của Ghita.
2. **Canvas render + style/template system của Qoder** (`templates/canvas/*.tsx`, `templates/style/` 8 style files, `canvas-preview-server.mjs` cần Qoder runtime): vendor-specific UI surface, không có giá trị cho Ghita reporter; nếu cần visual thì Ghita đã có HTML report riêng.
3. **Toàn bộ văn bản điều lệ ultra-dense + versioned contracts trùng lặp** (`reportContractVersion: 25` trong `templates/reporting/harness-findings.input.json:8`, validator bilingual en/zh, 820-dòng model doc): với Ghita ở 0.0.2-alpha, copy nguyên hệ thống gates sẽ tạo gánh nặng duy trì lớn hơn giá trị — chỉ lấy nguyên lý (ceiling, finding bar, guardrail metric), viết lại gọn bằng schema đơn giản.

---

_Phụ lục bằng chứng chính: `models/agent-work-loop.md`, `skills/better-harness/SKILL.md`, `scripts/harness-analysis/{intervention-ledger,score-finding-consistency,report-quality}.mjs`, `scripts/session-analysis/{episode-contract,privacy-safe-text}.mjs`, `references/loop-engineering/{loop-discovery,learning-loop-patterns}.md`, `scripts/harness-analysis/evidence-bundle/contract.mjs`, `templates/reporting/harness-findings.input.json`._
