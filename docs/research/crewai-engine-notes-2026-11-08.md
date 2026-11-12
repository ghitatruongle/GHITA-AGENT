# Ghi chú nghiên cứu crewai → Engine Crew (chụp trước khi xóa clone 686MB)

> Ngày: 2026-11-08 · Người soạn: agent (T2.2 kế hoạch v0.0.1) · Nguồn: `refer_project/ai-framework/crewai` @ d697217 (2026-11-08, đã sync)
> Mục đích: nốt lại phần "áp dụng 1 lần" của crewai trước khi xóa clone; gap còn lại ghi vào plan 0.0.2.

## 1) Đã áp dụng vào Engine Crew (packages/agents/src/crew/) — từ chu kỳ trước

| Pattern crewai | Đã vào Ghita ở đâu | Bằng chứng |
|---|---|---|
| Sequential/hierarchical process | `crew.ts` — `process === 'hierarchical'` route qua manager, sequential route task→member | crew.ts:235,286,340 |
| Delegation-as-tools | `delegation.ts` — manager (hoặc agent) gọi crewmate như tool | delegation.ts:1 |
| Best-effort planning | `planner.ts` — planning trước kickoff | crew.ts:3 comment |
| Usage metrics | `executor.ts:59` + crew.ts:505 — ghi token/request mỗi LLM call, pattern CrewAI UsageMetrics | executor.ts:59 |
| RPM controller | `rpm.ts` | rpm.ts |
| Crew memory | `memory.ts` | memory.ts |

## 2) Gap còn lại vs crewai mới nhất (đọc trực tiếp mã nguồn ngày 08/11) → plan 0.0.2

| # | Gap | crewai gốc | Ghita hiện tại | Gợi ý chỗ cắm |
|---|---|---|---| chu kỳ 0.0.2 |
| 1 | `manager_agent` không được nằm trong `agents` list | crew.py `check_manager_llm` (dòng ~727): manager_agent ∈ agents → error `manager_agent_in_agents` | chưa có validation này | crew.ts kickoff validate |
| 2 | "Crew phải kết thúc bằng ≤1 task async" | crew.py `validate_end_with_at_most_one_async_task` (dòng ~800): đếm từ cuối dãy task async liên tiếp > 1 → error | chưa có | crew.ts kickoff validate |
| 2.1 | 3 trường usage metrics mới: `cached_prompt_tokens`, `reasoning_tokens`, `cache_creation_tokens` | types/usage_metrics.py | executor.ts chỉ đếm total/prompt/completion/successful | executor.ts usage tracker |
| 3 | Manager validation: `manager_llm` hoặc `manager_agent` bắt buộc khi hierarchical | crew.py:727 | Ghita dùng fallback manager tự tạo (đã có), nhưng chưa chặn config sai (manager_agent ∈ agents) | crew.ts validate |
| 3.1 | Sequential: task thiếu agent → error ngay khi config | crew.py `validate_tasks` (config-time) | Ghita kiểm tại runtime? | crew.ts:235 vùng sequential routing |
| 4 | Async task cuối: task cuối cùng async → guard | crew.py | chưa có | executor.ts |
| 5 | Config-time validation tổng thể (model_validator chain) | crew.py | validate runtime-only | crew.ts + types.ts |

(Đánh số giữ nguyên từ lúc đọc; #2.1/#3.1 là chi tiết nhỏ của #2/#3.)

## 3) Kết luận

Engine Crew đã hứng đủ phần lõi (process, delegation, planning, usage, RPM, memory). Còn lại là **validation parity + 3 trường usage mới** — việc nhỏ, ghi vào plan 0.0.2.
Việc "áp dụng 1 lần" của crewai coi như XONG. Clone 686MB dọn được sau khi tài liệu này được commit... chưa commit — tài liệu nằm trong working tree, clone xóa ngay (nội dung quan trọng đã chụp trong file này).
