# Track S1 — Work-loop scoring đúng nguyên tắc + evidence states (TS)

> **Mục tiêu:** sửa nợ kỹ thuật scoring + mở evidence states ở evals. Nguồn: `deep-dive/better-harness/02-*.md`, nền `_research-4-harness-evals.md`. Track nhỏ, độc lập — nên làm đầu tiên.

## Nền đã kiểm chứng (facts)

- Công thức hiện tại (`work-loop.ts:127-134`): learning-capture = `max(35, ceiling − findings×8)` (floor 35 tại dòng 50); còn lại `max(0, base − findings×6)` với `base = hasMissing ? min(ceiling,59) : ceiling`; ceiling từ `EVIDENCE_CEILING` (dòng 28-36) theo evidence state cao nhất của 3 check; findings = đếm cái chưa `verified` (dòng 123-125).
- **harness ĐÃ có 7 EvidenceState** (`harness/types.ts:41-48`) — mức "4" chỉ tồn tại ở `packages/evals/src/types.ts:17` (mở ở đây thôi).
- evals scoring là coverage-weighted — KHÔNG trùng work-loop, chỉ cùng 5 dimension.
- **Không UI nào tiêu thụ scoring** — bề mặt duy nhất là Markdown (`renderSessionReport` + evals CLI) → S1 không phá contract UI.
- session-report.ts:3-4 _tuyên bố_ reader-safe nhưng không có sanitize thật; InputSanitizer (security) + createPiiRedactionMiddleware (agents) có sẵn để tái dùng.
- Tests hiện có: 9 it (agents/harness) + 4 file/13 it (evals); test assert 0.7 sẽ gãy khi đổi điểm emit.

## Thiết kế

1. **Thay công thức** (work-loop.ts:127-134) bằng: authored score từ 15 checks + **ceiling validator** (chặn vượt trần theo evidence state cao nhất) + **trung bình deterministic** Present40/Wired60/Exercised75/Outcome90 — đúng nguyên tắc "score never creates or suppresses a finding".
2. **Mở evals 4→7 states** (`packages/evals/src/types.ts:17` + `scoring.ts:8-13` điểm emit + test assert 0.7).
3. **Consistency gate**: nối vào `evaluate()` (`work-loop.ts:73-94`) — score<70 ⇔ có finding, reverse-link 2 chiều.
4. **Emission bar + privacy sanitizer** vào `renderSessionReport` — tái dùng InputSanitizer + PiiRedactionMiddleware.

## Files

- Modify: `packages/agents/src/harness/{work-loop.ts, types.ts, session-report.ts}`
- Modify: `packages/evals/src/{types.ts, scoring.ts}` + test assert 0.7
- Tests mới: ceiling validator chặn authored score vượt trần; gate score<70 ⇔ finding; snapshot report trước/sau.

## Phases & Gates

- **P1** Thay công thức + ceiling validator + tests (9 it hiện có xanh sau cập nhật kỳ vọng).
- **P2** evals 4→7 states + điểm emit + tests.
- **P3** Consistency gate + emission bar + privacy sanitizer + snapshot report.
- **Gates chung:** turbo test packages/agents + evals; knip; snapshot trước/sau để owner soát.
