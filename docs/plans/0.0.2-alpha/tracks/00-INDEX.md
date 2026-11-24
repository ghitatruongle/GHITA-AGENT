# 00 — INDEX TRACKS v0.0.2-alpha

> Chia nhỏ công việc thành 6 track để dễ quản lý. Mỗi track = 1 file riêng, có trạng thái nền ĐÃ KIỂM CHỨNG bằng subagent nghiên cứu nền (`_research-1..4`).
> Kiến thức gốc: `../2026-11-22-tong-hop-kien-truc-6-du-an.md` (8 chủ đề A1-A8) + `../deep-dive/` (12 tài liệu).
> Quy ước chung: KHÔNG commit/push tự ý · native-first + JS fallback · gates: typecheck/lint/turbo test/knip/cargo test/clippy −D warnings · license cấm GPL/AGPL (ds2api chỉ clean-room).

| Track                                  | Tên                                                 | Khu vực                        | Phụ thuộc | Giá trị | Nghiên cứu nền                                                         |
| -------------------------------------- | --------------------------------------------------- | ------------------------------ | --------- | ------- | ---------------------------------------------------------------------- |
| [R1](track-R1-pty.md)                  | PTY dùng chung + kill-tree chuẩn                    | Rust (crates/pty + src-tauri)  | —         | Cao     | [_research-3](_research-3-desktop-terminal.md) + deep-dive node-pty    |
| [R2](track-R2-sandbox.md)              | Sandbox v2: trait backend + rollback + limits       | Rust (crates/sandbox)          | —         | Cao     | [_research-1](_research-1-sandbox.md) + deep-dive AgentEnv             |
| [S1](track-S1-workloop-evals.md)       | Work-loop scoring đúng nguyên tắc + evidence states | TS (agents/harness + evals)    | —         | Cao     | [_research-4](_research-4-harness-evals.md) + deep-dive better-harness |
| [S2](track-S2-ai-engine.md)            | StandardRequest + AgentError + credential pool      | TS (ai-engine)                 | —         | Cao     | [_research-2](_research-2-ai-engine.md) + deep-dive ds2api             |
| [S3](track-S3-observability-stream.md) | TokenTracker + StreamObject + choose                | TS (ai-engine + communication) | S2 (nhẹ)  | Cao     | [_research-2](_research-2-ai-engine.md) + deep-dive open-agent         |
| [S4](track-S4-computer-use-phu.md)     | Computer-use gap + phụ (PoW, docloader)             | TS + Rust nhỏ                  | —         | Trung   | [_research-3](_research-3-desktop-terminal.md) + deep-dive nut-js      |

## Trạng thái (owner cập nhật)

| Track | Trạng thái           | Ghi chú                                         |
| ----- | -------------------- | ----------------------------------------------- |
| R1    | ✅ XONG (22/11/2026) | gates xanh — `_done-track-R1.md`                |
| R2    | ✅ XONG (22/11/2026) | 21/21 + 157/157 + 444/444 — `_done-track-R2.md` |
| S1    | ✅ XONG (22/11/2026) | 19/19 + 14/14 — `_done-track-S1.md`             |
| S2    | ✅ XONG (22/11/2026) | 1016 tests PASS — `_done-track-S2.md`           |
| S3    | ✅ XONG (22/11/2026) | 1054/1054 + 165 + 24 — `_done-track-S3.md`      |
| S4    | ✅ XONG (22/11/2026) | 241 + 176 + e2e 10/10 — `_done-track-S4.md`     |

## Thứ tự đề xuất

S1 (nợ kỹ thuật, nhỏ) → S2 → S3 → R1 → R2 → S4. Hoặc chạy song song R1/R2 với S-track vì khác khu vực.
