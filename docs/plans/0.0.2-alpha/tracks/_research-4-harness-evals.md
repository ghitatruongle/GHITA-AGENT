# Nghiên cứu nền: agents/harness + evals

> Subagent research 4 — READ-ONLY, 2026-11-22. Repo: `D:\GHITA AGENT`. Nền cho Track S1 (sửa scoring + gap better-harness).

## 1. `packages/agents/src/harness/` (4 file)

### 1a. File + vai trò

- `work-loop.ts` (151 dòng): `WorkLoopEvaluator` — resolve dimension score dưới evidence-bounded ceiling; `checkToDimension` (52-63); `applyRepairProgress` (144-150).
- `types.ts` (111 dòng): model 5 dimension / 15 check (1-4); toàn bộ type của review.
- `session-report.ts` (73 dòng): `renderSessionReport` (19-72) — render `WorkLoopReview` thành Markdown "reader-safe" (3-4).
- `index.ts` (15 dòng): public API (3-14). Được re-export từ `packages/agents/src/index.ts:634-650`.

### 1b. Logic scoring quanh `work-loop.ts:127-134`

- **Ceiling** từ `EVIDENCE_CEILING` (work-loop.ts:28-36): map 7 EvidenceState → điểm trần (Missing/Unobserved/Not applicable = 59; Present = 74; Wired = 84; Exercised = 94; Outcome-supported = 100). State cao nhất được tìm bằng `EVIDENCE_STRENGTH` (39-47) qua 3 check của dimension (111-118).
- **Findings đếm thế nào** (123-125): `findings.filter(f => checkToDimension(f.primaryCheck) === dimension && f.repairProgress !== 'verified')` — tức finding `pending`/`partial`/`blocked` đều trừ điểm; chỉ `verified` (set qua `applyRepairProgress`, 144-150) mới thôi trừ.
- **Công thức** (127-134): `learning-capture` → `score = Math.max(LEARNING_CAPTURE_FLOOR, ceiling − count×8)` (130); 4 dimension còn lại → `base = hasMissing ? Math.min(ceiling, 59) : ceiling` (132), `score = Math.max(0, base − count×6)` (133). `hasMissing` = có check nào state `Missing` (121) — kẹp dimension ≤ 59 dù check khác Exercised (test xác nhận: `packages/agents/tests/harness.test.ts:54-64`).
- **Floor 35** ở `LEARNING_CAPTURE_FLOOR` (work-loop.ts:50), chỉ áp dụng cho learning-capture.
- **Loop Effectiveness** = `Math.round(mean(5 dimension scores))` (82-84) — đã deterministic.
- Lưu ý: comment dòng 129 nói learning-capture là "authored integer 35..100" nhưng code đang **tính bằng công thức**, không phải authored input → đúng điểm S1 cần sửa.

### 1c. 15 checks / 5 dimension

- Dimension: `types.ts:7-12` (task-understanding, controlled-execution, change-validation, reliable-delivery, learning-capture).
- 15 check id: `types.ts:15-35` (3 check/dimension).
- Map check→dimension: `DIMENSION_CHECKS` (`work-loop.ts:19-25`). `checkToDimension` trả `undefined` thay vì throw cho dữ liệu bẩn (59-62).

### 1d. Repair progress logic

- `applyRepairProgress` (144-150): cập nhật `repairProgress` của đúng 1 finding, **không đổi dimension score** (comment 140-143). Score chỉ bị ảnh hưởng khi re-`evaluate()` với findings đã cập nhật (vì deduction đọc tại 123-125).
- `WorkLoopFinding.repairProgress?: 'verified' | 'partial' | 'blocked' | 'pending'` (`types.ts:76`).

### 1e. EvidenceLevel / EvidenceState

- **Harness đã có 7 state**: `EvidenceState` = Present | Wired | Exercised | Outcome-supported | Missing | Unobserved | Not applicable (`packages/agents/src/harness/types.ts:41-48`).
- **Evals có 4 mức**: `EvidenceLevel` = 'missing' | 'observed' | 'artifact' | 'outcome-supported' (`packages/evals/src/types.ts:17` — là dòng 17, không phải 16).

## 2. `packages/evals/src/` (9 file source + 4 test)

### 2a. Cấu trúc

- `types.ts` (109 dòng): `EVALS_VERSION` (3), `EVAL_DIMENSIONS` (6-12, mirror 5 dimension harness), `EvidenceLevel` (17), `Evidence` (19-27), `EvalTask` (30-42), `AgentResult` (57-67), `RunOutcome` (70-77), `EvalRun` (80-90), `AgentAdapter` (93), `EvalSuite` (96-99).
- `longitudinal.ts` (126 dòng): **có SQLite** — `better-sqlite3` (1), `LongitudinalStore` (21-112): bảng `eval_runs` (27-41), `insertRun` (45-63), `averageScore` (74-81, AVG + round), `trend` (84-92), `compare` → DeltaRow (95-107), `renderTrend` (115-125). DB path mặc định `.ghita/evals/history.db` (cli.ts:105).
- `scoring.ts` (172 dòng): `LEVEL_WEIGHT` (8-13: missing 0 / observed 0.4 / artifact 0.7 / outcome-supported 1), `DIMENSION_EXPECTATIONS` (16-40), `coveragePerDimension` (43-52, lấy weight cao nhất mỗi dimension), `computeRunScore` (65-166: marker 72-86, artifacts 89-102, trajectory 105-118, pass 121-127, learning heuristic regex/độ dài 130-141), score = mean 5 coverage ×100 (154-163).
- `runner.ts` (87 dòng): `defaultAdapter` fixture (15-24), `finalizeEval` (27-47 — **passed = output non-empty**, dòng 33), `runSuite` (50-64), `summarize` (66-77), `hashSteps` fingerprint deterministic (79-86).
- `suites.ts` (31 task qua 3 suite): internal-v1.1.0 (18, 20 task), browser-v1.1.0 (185, 6 task), skills-v1.1.0 (253, 5 task).
- `report.ts` (78 dòng): `renderRunReport` (17-55 — bảng evidence, pass/fail reasons, trajectory), `renderCompareReport` (58-77 — delta + cảnh báo regression).
- `replay.ts` (57 dòng): `replayTrajectory` (18-35), `replayOffline` (38-56).
- `cli.ts` (216 dòng): lệnh `run` / `compare` / `replay` (109-201).
- `index.ts` (28 dòng): export toàn bộ.

### 2b. Scoring/ceiling ở evals có trùng work-loop không?

**Không trùng — 2 hệ thống khác cơ chế, cùng mô hình 5 dimension:**

- Work-loop: ceiling-based (`ceiling − findings×6/8`, floor 35) theo check states.
- Evals: coverage-weighted (`LEVEL_WEIGHT` max per dimension → mean ×100, scoring.ts:154-163), **không có khái niệm ceiling, không có floor, không có findings**. Không có bản sao `EVIDENCE_CEILING` ở evals — map ceiling chỉ tồn tại ở `work-loop.ts:28-36`.

### 2c. Tests hiện có: 4 file / 13 it()

- `scoring.test.ts` (55 dòng): 4 it — pass score cao khi marker khớp (5-16), fail score thấp khi không khớp (18-29), đủ evidence 5 dimension (31-42), coverage lấy best level (44-54, assert artifact = 0.7).
- `runner.test.ts` (49 dòng): 4 it — runSuite ≥20 task (10-18), taskFilter (20-25), fingerprint deterministic (27-39), summarize rỗng (42-48).
- `longitudinal.test.ts` (62 dòng): 2 it — store/aggregate/compare (19-47), null khi chưa có version (49-60).
- `replay.test.ts` (37 dòng): 3 it — offline thiếu answer (4-12), handler lỗi (14-26), all-pass (28-36).
- Kèm theo: `packages/agents/tests/harness.test.ts` (161 dòng) — 9 it (checkToDimension 16-24; evaluator ceiling 26-108; applyRepairProgress 110-136; renderSessionReport 138-160).

## 3. Cách scoring được tiêu thụ

- **Không UI nào tiêu thụ.** Grep toàn repo: `@ghita/evals` không được import bởi package/app nào (chỉ package.json của chính nó); harness chỉ được dùng bởi `packages/agents/tests/harness.test.ts`. Desktop app: các hit "score" chỉ là fuzzy-search của CommandPalette (`apps/desktop/src/components/CommandPalette.tsx:32`) — không liên quan.
- **Bề mặt duy nhất là Markdown:**
  - Harness: `renderSessionReport` (session-report.ts:19-72) — header Goal + Loop Effectiveness/100 (23-24), cờ session-limited (25-28), bảng Dimension|Score|Highest evidence|Ceiling (33-38), per-check (42-50), Findings với problem/impact/repair/validation + repair progress (52-69).
  - Evals CLI: `cli.ts:110-155` in score từng run (`131`), avg score (123), trend bảng version (140-148), ghi `.ghita/evals/report.md` + JSON per-run (130-152); `compare` ghi `compare.md` (174-181); `renderRunReport`/`renderCompareReport` (report.ts:17-77).
- ⇒ Mở rộng scoring không phá vỡ contract UI nào; chỉ cần giữ Markdown report ổn định.

## 4. Đánh giá khoảng cách cho Track S1

### 4a. Authored score + ceiling validator + trung bình deterministic

- File chạm chính: `packages/agents/src/harness/work-loop.ts` (thay công thức 127-134; mở `evaluate()` ở 73-94 để nhận authored score; thêm validator authored ≤ `EVIDENCE_CEILING[highest]` — map đã có sẵn ở 28-36), `packages/agents/src/harness/types.ts` (`DimensionScore` 89-98 thêm field authored/validated; `WorkLoopReview` 101-110 nếu cần), `packages/agents/src/harness/session-report.ts` (bảng 33-38 render authored + kết quả validator), `packages/agents/tests/harness.test.ts` (cập nhật assertion 26-108).
- Trung bình deterministic **đã có sẵn** cả 2 phía: work-loop.ts:82-84 (round mean), evals runner.ts:68-69, SQL AVG longitudinal.ts:74-81 — chỉ cần giữ nguyên/khẳng định lại, không viết mới.

### 4b. Mở rộng 4→7 evidence states

- Mục tiêu thật là **evals** `EvidenceLevel` (types.ts:17, 4 mức) nâng lên parity với harness `EvidenceState` (7 mức, đã có đủ). Harness phía work-loop không phải đổi gì (ceiling map + strength map đã đủ 7 mục, work-loop.ts:28-47).
- Cần đổi: `packages/evals/src/types.ts:17` (+ có thể thêm map thứ tự/metadata); `packages/evals/src/scoring.ts:8-13` `LEVEL_WEIGHT` (thêm weight cho Wired/Exercised…), `scoring.ts:16-40` `DIMENSION_EXPECTATIONS`, và các điểm emit evidence trong `computeRunScore` (72-152) để map đúng state mới; `scoring.test.ts` (assert cứng `0.7` ở dòng 51 sẽ gãy).
- Không cần đổi: SQLite schema (longitudinal.ts:34 chỉ lưu score int), UI (không tồn tại), harness types.

### 4c. Consistency gate + emission bar + privacy sanitizer — điểm nối tự nhiên

- **Consistency gate**: nối vào `WorkLoopEvaluator.evaluate` (work-loop.ts:73-94) trước khi score — validate finding.primaryCheck hợp lệ, check refs khớp; `checkToDimension` (52-63) đã có sẵn hành xử an toàn cho dữ liệu bẩn. Pattern gate để tham khảo: `ConfirmationGate` (`packages/agents/src/runtime/confirmation.ts:21`), `DoomLoopGate` (`packages/agents/src/runtime/doom-loop.ts:7`).
- **Emission bar**: nối vào `renderSessionReport` (session-report.ts:19) — chặn/đánh dấu nội dung chưa đạt ngưỡng bằng chứng trước khi render bảng + findings.
- **Privacy sanitizer**: session-report.ts:3-4 _tuyên bố_ "no raw prompts/paths/secrets" nhưng **không có bước sanitize thật** — chỉ render trường có bound. Điểm nối: sanitize `summary`/`evidenceRefs`/`problem`/`impact` ngay trong renderSessionReport (và/hoặc trước khi ghi report.md ở cli.ts:130-153). Tái dùng được: `InputSanitizer` (`packages/security/src/input-sanitizer.ts:25`, scan/escapeHtml) và `createPiiRedactionMiddleware` (`packages/agents/src/middleware/context-middleware.ts:204`).

## 5. Đã có sẵn — tránh làm lại

- **7 EvidenceState + ceiling map + strength map** hoàn chỉnh phía harness (work-loop.ts:28-47, types.ts:41-48) — phần mở rộng chỉ là bên evals.
- **Mean deterministic + fingerprint deterministic** đã có và đã test (work-loop.ts:82-84; runner.ts:79-86, runner.test.ts:27-39).
- **Longitudinal SQLite đầy đủ**: schema, insert, avg, trend, compare, delta (longitudinal.ts:21-112) + test.
- **Replay deterministic** offline + handler (replay.ts) + test; CLI có sẵn run/compare/replay.
- **31 task fixture cho CI offline** qua 3 suite (suites.ts).
- **`applyRepairProgress` tách khỏi scoring** đúng mô hình (work-loop.ts:140-150) — không phá khi sửa công thức.
- **Cờ `sessionLimited`** đã propagate từ `TaskEpisode.sessionLinked` → review → report (types.ts:84, work-loop.ts:89, session-report.ts:25-28).
- **InputSanitizer / PII-redaction middleware** sẵn dùng cho privacy sanitizer (security/input-sanitizer.ts:25; agents middleware/context-middleware.ts:204).
- Lưu ý nhỏ: `finalizeEval` lấy `passed = output.trim().length > 0` (runner.ts:33) — tiêu chí pass thô, S1 có thể muốn gắn với authored score.
