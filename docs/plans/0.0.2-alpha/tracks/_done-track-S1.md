# Track S1 — DONE: Work-loop scoring đúng nguyên tắc + evidence states

> Worker thực thi 2026-11-22. Spec: `track-S1-workloop-evals.md`, nền: `_research-4-harness-evals.md`, nguồn thiết kế: `deep-dive/better-harness/02-luot-2-kien-truc-thuat-toan.md`. Chỉ làm working tree — KHÔNG commit/push.

## 1. Files đã sửa

| File                                            | Thay đổi                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/agents/src/harness/work-loop.ts`      | P1: thay công thức scoring; P3: emission bar + reverse-link 2 chiều + consistency gate trong `evaluate()`                                                                                                                                                                                                         |
| `packages/agents/src/harness/types.ts`          | `DimensionScore` thêm `scoreSource`/`authored`/`validatedCeiling`/`findingRefs`; `WorkLoopFinding.dimensionRefs`; `WorkLoopReview.emissionBarRejected`/`consistencyViolations`; mới: `EvaluateOptions`                                                                                                            |
| `packages/agents/src/harness/session-report.ts` | P3: privacy sanitizer (async) — tái dùng `InputSanitizer` (@ghita/security) + `createPiiRedactionMiddleware` (agents), re-check emission bar lúc render                                                                                                                                                           |
| `packages/agents/src/harness/index.ts`          | export mới: `InvalidWorkLoopScoreError`, `passesEmissionBar`, `scoreFindingConsistency`, `LOW_SCORE_FINDING_THRESHOLD`, type `EvaluateOptions`                                                                                                                                                                    |
| `packages/agents/tests/harness.test.ts`         | cập nhật kỳ vọng có chủ đích + 10 test mới (19 it total)                                                                                                                                                                                                                                                          |
| `packages/agents/tsconfig.json`                 | **(+1 dòng, ngoài footprint kê khai — bắt buộc):** thêm project reference `../security` để `tsc -b` compile được import `@ghita/security` (không có reference → TS6059 rootDir). KHÔNG sửa package.json/pnpm-lock (không cần `pnpm install` — runtime resolve qua symlink hoisted `node_modules/@ghita/security`) |
| `packages/evals/src/types.ts`                   | `EvidenceLevel` 4→7 levels khớp 7 `EvidenceState` của harness                                                                                                                                                                                                                                                     |
| `packages/evals/src/scoring.ts`                 | `LEVEL_WEIGHT` 7 mức + 6 điểm emit trong `computeRunScore` + `DIMENSION_EXPECTATIONS`                                                                                                                                                                                                                             |
| `packages/evals/src/scoring.test.ts`            | sửa assert `0.7`/`0.4` sang level mới + thêm test 7 levels                                                                                                                                                                                                                                                        |

Snapshot script: `C:\Users\Acer\AppData\Local\Temp\ghita-s1\snapshot.mjs` (ngoài repo, đã xoá được nếu muốn).

## 2. Từng phase

### P1 — Scoring đúng nguyên tắc (work-loop.ts)

- **Bỏ** công thức `max(35, ceiling − findings×8)` / `max(0, base − findings×6)` — vi phạm "score never creates or suppresses a finding".
- **`EVIDENCE_SCORES`** (bản `AGENT_WORK_LOOP_EVIDENCE_SCORES` của model gốc): Present 40 / Wired 60 / Exercised 75 / Outcome-supported 90 / Missing–Unobserved–Not applicable 0.
- **Baseline deterministic** = trung bình (round) evidence score của 3 check trong dimension.
- **Authored score**: `evaluate(episode, findings, { authoredScores })` — reviewer/AI tự chấm integer per dimension; **ceiling validator** chặn: non-integer, <0, hoặc > `validatedCeiling` → throw `InvalidWorkLoopScoreError` (`INVALID_AGENT_WORK_LOOP_SCORE_REVIEW`, đúng behavior bản gốc). `validatedCeiling` = `EVIDENCE_CEILING[state cao nhất]`, kẹp 59 khi có check `Missing` ("required check Missing giữ dimension ≤59").
- **Floor 35 learning-capture** giữ nguyên, áp cho cả authored lẫn baseline.
- Field mới trên `DimensionScore`: `scoreSource` ('authored'|'baseline'), `authored`, `validatedCeiling`.

### P2 — evals 4→7 evidence states

- `EvidenceLevel` = `missing | unobserved | not-applicable | present | wired | exercised | outcome-supported` (parity 1-1 với `EvidenceState` harness; harness không đổi gì — đã có đủ 7 từ trước).
- `LEVEL_WEIGHT`: missing/unobserved/not-applicable 0, present 0.4, wired 0.7, exercised 0.85, outcome-supported 1 (monotonic; 0.4/0.7 giữ đúng semantic cũ observed/artifact).
- Emit points trong `computeRunScore`: markers all→outcome-supported/some→wired; artifacts→wired (none→present); steps→exercised (none→present); pass→outcome-supported (fail→present); learning structured→present; task-understanding markers→wired.
- `DIMENSION_EXPECTATIONS` đổi levels tương ứng (observed→present, artifact→wired, trajectory→exercised cho controlled-execution expectation).

### P3 — Consistency gate + emission bar + privacy sanitizer

- **Emission bar** (`passesEmissionBar`, chạy trong `evaluate()` + re-check trong `renderSessionReport`): finding chỉ được emit khi có đủ inspected gap + bounded impact + smallest-owner repair + validation route (trim non-empty). Id bị loại → `review.emissionBarRejected`.
- **Reverse-link 2 chiều**: `dimension.findingRefs` (projection từ primaryCheck ownership) + `finding.dimensionRefs` — được set trong `evaluate()`, integrity được gate kiểm cả 2 chiều.
- **Consistency gate** (`scoreFindingConsistency`, wire vào `evaluate()`): dimension **authored** score < 70 (`LOW_SCORE_FINDING_THRESHOLD`, đúng ngưỡng bản gốc) mà không có finding link → throw `InvalidWorkLoopScoreError` trừ khi `allowUnlinkedLowScore` (escape hatch của bản gốc, violation vẫn được ghi vào `review.consistencyViolations`). **Baseline được miễn** rule low-score (generated với confidence thấp — cùng semantic escape hatch bản gốc); link integrity thì check cho mọi review.
- **Privacy sanitizer** (`renderSessionReport`, giờ async `Promise<string>`): mỗi free-text field (episodeId, goal, check.summary, problem/impact/repair/validationRoute) đi qua `InputSanitizer.scan()` (strip script/iframe/event-handler) rồi qua `createPiiRedactionMiddleware().preModel()` (redact EMAIL/API_KEY/TOKEN/AWS_KEY/PRIVATE_KEY). **Không reimplement regex nào.** Async là bắt buộc (interface preModel là Promise); trong repo không có consumer nào ngoài tests (đã grep — chỉ harness index/tests), sidecar bundle rebuild tự pickup.

## 3. Thay đổi kỳ vọng test có chủ đích (harness.test.ts, 9→19 it)

| Test cũ                                                                                                    | Kỳ vọng cũ                       | Kỳ vọng mới                                                                                                           |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| "reaches the exercised ceiling when a check is exercised"                                                  | `score === 94` (ceiling-derived) | `score === 25` (baseline mean 75+0+0) + `scoreSource === 'baseline'`; **thêm** test authored 90 ≤ validatedCeiling 94 |
| "open findings reduce the affected dimension score"                                                        | score giảm khi có finding        | **đảo**: `dimWith.score === dimWithout.score` (score không derive từ findings)                                        |
| 5 test còn lại (checkToDimension, ceiling cap, Missing≤59, floor 35, session-limited, applyRepairProgress) | —                                | giữ nguyên, pass không đổi                                                                                            |

Test mới: authored ≤ ceiling accepted; authored > ceiling throw; non-integer throw; Missing kẹp authored ≤59; gate authored <70 không finding → throw / có finding → pass / `allowUnlinkedLowScore` → violation ghi lại; baseline miễn gate; emission bar filter + `emissionBarRejected`; reverse-link 2 chiều + `scoreFindingConsistency` trống; render sanitize PII/script; render không in finding dưới bar.

## 4. Gates

| Gate                                                                     | Kết quả                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest run` packages/agents (harness.test.ts)                           | **19/19 passed**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `vitest run` packages/evals (4 file)                                     | **14/14 passed**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tsc -b --force` packages/agents (kèm references shared/memory/security) | xanh                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `tsc -b --force` packages/evals                                          | xanh                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `eslint` src/harness + tests + evals files                               | xanh (0 error)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `npx knip`                                                               | **exit 0** — không unused/unlisted/unresolved; chỉ 19 configuration hints có sẵn về knip.json (không liên quan S1)                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm turbo test --filter=...`                                           | **bị chặn bởi môi trường, không phải code**: pnpm 11 `verify-deps-before-run` tự nhảy `pnpm install` + purge node_modules, abort vì no-TTY — chết ngay ở build `@ghita/shared`/`@ghita/mcp` (package không đụng tới). Không chạy `pnpm install` (an toàn worker song song R1). Bù lại: gates tương đương đã chạy thủ công đầy đủ (tsc -b từng package + vitest từng package + knip). Flag `--config.verify-deps-before-run=false` hoạt động ở cấp `pnpm run` nhưng không truyền được xuống child pnpm mà turbo spawn |

## 5. Snapshot scoring trước/sau (owner soát)

Cùng 1 episode chuẩn (15 check mixed states + 2 findings F1/F2), chạy qua dist build thật (trước = code cũ build sẵn, sau = code mới).

**BEFORE (công thức `ceiling − findings×6/8`):**

```
loopEffectiveness=80
task-understanding:  score=78  highest=Wired      ceiling=84
controlled-execution: score=94  highest=Exercised  ceiling=94
change-validation:   score=94  highest=Exercised  ceiling=94
reliable-delivery:   score=59  highest=Present    ceiling=74
learning-capture:    score=76  highest=Wired      ceiling=84
```

**AFTER (baseline mean + validator; findings không còn trừ điểm):**

```
loopEffectiveness=41
task-understanding:  score=53  highest=Wired      ceiling=84  validatedCeiling=84  source=baseline
controlled-execution: score=65  highest=Exercised  ceiling=94  validatedCeiling=94  source=baseline
change-validation:   score=25  highest=Exercised  ceiling=94  validatedCeiling=94  source=baseline
reliable-delivery:   score=27  highest=Present    ceiling=74  validatedCeiling=59  source=baseline
learning-capture:    score=35  highest=Wired      ceiling=84  validatedCeiling=84  source=baseline
```

Điểm số giảm là đúng ý thiết kế: trần chỉ là TRẦN, không phải công thức; điểm baseline phản ánh trung bình bằng chứng thật (check `Not applicable`/`Missing`/`Unobserved` đóng góp 0). Markdown report giữ nguyên cấu trúc bảng/sections.

**Demo authored/gate/sanitizer (chỉ có trên model mới):**

```
authored accepted:
task-understanding: authored 72 -> score 72 (validatedCeiling 84)
change-validation:  authored 88 -> score 88 (validatedCeiling 94)
gate blocked: dimension "controlled-execution" has authored score 50 < 70 without a linked finding
sanitized goal: **Goal:** Contact [REDACTED:EMAIL] or [REDACTED:TOKEN]
                                     ^ <script>alert(1)</script> đã bị strip
```

## 6. Lưu ý cho owner

1. **Footprint mở rộng tối thiểu**: `packages/agents/tsconfig.json` +1 dòng (project reference `../security`) — bắt buộc để build. Không đụng package.json/pnpm-lock/ai-engine/communication/crates/apps; không wire vào runInSandbox.
2. **`renderSessionReport` giờ trả `Promise<string>`** — breaking với consumer ngoài repo nếu có (trong repo: không có).
3. **`@ghita/security` là runtime dep thực tế của `packages/agents`** nhưng chưa khai báo trong package.json (đang resolve qua symlink hoisted root + tsconfig reference; knip không flag vì nằm trong `ignoreDependencies`). Owner có muốn khai báo `workspace:*` + `pnpm install` thì làm sau khi merge các worker.
4. Evals `EvidenceLevel` đổi tên giá trị (observed→present, artifact→wired…) — mọi adapter tự viết truyền `evidence` custom với level cũ sẽ cần đổi tên.
5. P2 làm điểm evals của 1 số fixture tăng nhẹ (steps→exercised 0.85 thay vì artifact 0.7) — deterministic, đã test.
6. **Sự cố đã xử lý**: lần build `tsc -b` đầu tiên (trước khi thêm reference, vẫn lỗi TS6059) phát sinh 18 file `*.d.ts` lạc vào `packages/security/src/` (emit declaration cạnh nguồn do file bị kéo vào program qua paths). Đã xoá sạch, build lại với reference → không tái diễn, `git status packages/security/src` sạch.
