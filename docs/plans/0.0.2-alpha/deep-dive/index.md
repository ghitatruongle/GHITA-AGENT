# Deep-dive 6 dự án ít sao nhất — docs/plans/0.0.2-alpha/deep-dive/

> Lệnh của owner 22/11/2026: đào sâu lần lượt 6 dự án ít sao nhất trong `refer_project/`, mỗi dự án 2 lượt subagent (mỗi lượt 2 subagent song song — tổng 24 subagent).
> Lượt 1 = tổng quan + tính năng + ưu điểm áp dụng vào Ghita · Lượt 2 = kiến trúc + thuật toán.
> Kết quả: **12 tài liệu** trong 6 thư mục con. Số sao thực tế lấy từ GitHub API 22/11/2026.

| #   | Dự án                                                                                    | Stars | License     | 2 tài liệu                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------- | ----- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | [open-agent](open-agent/) (AFK-surf/open-agent — fork AFFiNE, multi-agent self-hostable) | 1.062 | Apache-2.0  | [01-luot-1](open-agent/01-luot-1-uu-diem-tinh-nang.md) · [02-luot-2](open-agent/02-luot-2-kien-truc-thuat-toan.md)         |
| 2   | [node-pty](node-pty/) (microsoft/node-pty — PTY backend VS Code)                         | 2.064 | MIT         | [01-luot-1](node-pty/01-luot-1-uu-diem-tinh-nang.md) · [02-luot-2](node-pty/02-luot-2-kien-truc-thuat-toan.md)             |
| 3   | [better-harness](better-harness/) (QoderAI — audit harness 10 host agents)               | 2.479 | MIT         | [01-luot-1](better-harness/01-luot-1-uu-diem-tinh-nang.md) · [02-luot-2](better-harness/02-luot-2-kien-truc-thuat-toan.md) |
| 4   | [nut-js](nut-js/) (nut-tree/nut.js — desktop automation)                                 | 2.856 | Apache-2.0  | [01-luot-1](nut-js/01-luot-1-uu-diem-tinh-nang.md) · [02-luot-2](nut-js/02-luot-2-kien-truc-thuat-toan.md)                 |
| 5   | [agentenv](agentenv/) (kvcache-ai/AgentENV — MoonshotAI, Firecracker env cho RL)         | 3.777 | MIT         | [01-luot-1](agentenv/01-luot-1-uu-diem-tinh-nang.md) · [02-luot-2](agentenv/02-luot-2-kien-truc-thuat-toan.md)             |
| 6   | [ds2api](ds2api/) (CJackHwang — DeepSeek web→API gateway, ARCHIVED)                      | 4.697 | ⚠️ AGPL-3.0 | [01-luot-1](ds2api/01-luot-1-uu-diem-tinh-nang.md) · [02-luot-2](ds2api/02-luot-2-kien-truc-thuat-toan.md)                 |

## Kết luận nhanh từng dự án cho Ghita

1. **open-agent** — top 3 idea: TokenUsageTracker AsyncLocalStorage (`monitoring`/`ai-engine`), StreamObject protocol 5 loại + `tool-incomplete-result` (`ai-engine`/`communication`), tool `choose` + todo aggregation (`agents`/desktop). Beta sớm.
2. **node-pty** — KHÔNG dùng trực tiếp (Tauri = Rust); dùng crate **portable-pty** + port 5 pattern ConPTY (2-phase init, kill-tree console-aware, resize pixel, exit thống nhất, escape commandline).
3. **better-harness** — gap chưa hấp thụ rõ ràng: 7 evidence states (vs 4 mức hiện tại), Intervention Ledger, score-finding consistency gate, finding emission bar, privacy sanitizer. ⚠️ Phát hiện: công thức `ceiling − findings×6/8` trong `work-loop.ts:127-134` trái nguyên tắc gốc — cần thay.
4. **nut-js** — không dùng làm dependency (npm prebuilt đã rút); port 5 pattern (registry probe/fallback, validateSearchRegion + AbortSignal, window clamp, Bresenham+easing, MatchRequest generic) vào `computer-use`.
5. **AgentEnv** — áp dụng ngay: Job Object limits, TTL auto-kill; kế hoạch: trait `SandboxBackend` + overlay-dir rollback cho `crates/sandbox`; Linux-only chỉ học ý tưởng.
6. **ds2api** — AGPL → chỉ clean-room design pattern: StandardRequest canonical (N×M→N+M cho ~25 provider), credential pool + FIFO waiter, SSE micro-batch, AgentError normalize. KHÔNG automate login/TLS spoof (ToS).

## Phương pháp

- 12 lượt dispatch, mỗi lượt 2 subagent general-purpose chạy song song (max 2 concurrent — khớp RAM 21,8GB).
- Mỗi subagent CHỈ ĐỌC (không chạy code repo thứ ba), tự lưu báo cáo vào file `_subagent-N-*.md` khi xong; tài liệu ghép cơ học bằng `cat` + header tổng hợp (tránh lỗi ghi lại nội dung dài).
- Mỗi báo cáo con bắt buộc kèm bằng chứng path:line.
