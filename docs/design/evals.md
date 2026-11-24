# Evals — Framework đánh giá agent (v1.1.0 Track 1)

`@ghita/evals` là framework đánh giá agent dựa trên **bằng chứng (evidence)**,
mô phỏng theo Agent Work Loop 5 chiều của `@ghita/agents` (Task Understanding,
Controlled Execution, Change Validation, Reliable Delivery, Learning Capture).

## CLI

```bash
# Build trước khi dùng
pnpm --filter @ghita/evals build

# Chạy suite nội bộ (offline, adapter fixture — không cần API key)
pnpm --filter @ghita/evals evals run

# Chỉ chạy một task
pnpm --filter @ghita/evals evals run --task edit-fix-typo

# Suite tùy chỉnh từ file JSON
pnpm --filter @ghita/evals evals run ./my-suite.json --adapter script

# So sánh hai version đã lưu (longitudinal)
pnpm --filter @ghita/evals evals compare 1.0.0 1.1.0

# Replay trajectory của một run
pnpm --filter @ghita/evals evals replay .ghita/evals/runs/<run-id>.json
```

## Kiến trúc

```
packages/evals/src
├── types.ts          # EvalTask, Evidence, EvalRun, AgentAdapter...
├── scoring.ts        # computeRunScore: 5 chiều, evidence-bound (0-100)
├── runner.ts         # runSuite/finalizeEval/defaultAdapter (fixture)
├── report.ts         # renderRunReport/renderCompareReport (markdown)
├── longitudinal.ts   # LongitudinalStore (SQLite): version → trend/compare
├── replay.ts         # replayTrajectory/replayOffline (deterministic)
├── suites.ts         # createInternalSuite (20 tasks nội bộ)
└── cli.ts            # bin `evals` (run | compare | replay)
```

- **Scoring**: evidence cấp `missing < observed < artifact < outcome-supported`;
  marker `expected[]` khớp với output = evidence mạnh nhất (outcome-supported).
- **Adapter**: `AgentAdapter = (task) => Promise<AgentResult>`. Mặc định `fixture`
  (dùng `task.fixture`, offline, chạy CI). Muốn đánh giá model thật, viết adapter
  bọc `@ghita/ai-engine` Orchestrator + `@ghita/agents` ReActAgent.
- **Longitudinal**: mỗi run được lưu vào `history.db` (SQLite); `evals compare`
  so sánh average score giữa hai version, phát hiện regression.

## CI gate

```bash
node scripts/evals-gate.mjs                # baseline mặc định 75
EVALS_BASELINE=70 node scripts/evals-gate.mjs
```

Gate chạy suite nội bộ bằng adapter fixture (deterministic) và fail nếu
average score < baseline. Workflow GitHub Actions: `.github/workflows/evals.yml`
(chạy nightly).

## Suite tùy chỉnh (JSON)

```json
{
  "name": "my-suite",
  "tasks": [
    {
      "id": "edit-t1",
      "title": "Sửa lỗi typo",
      "prompt": "Fix typo trong README.",
      "expected": ["fixed"],
      "fixture": "fixed: typo đã được sửa."
    }
  ]
}
```

## MCP interop (Track 1)

```bash
node scripts/mcp-interop-check.mjs
```

Verify 4 MCP server (codegraph/browser/memory/skills) qua SDK chuẩn —
xem `packages/{mcp,code-graph,browser-control,memory,skills}/src/mcp-server.ts`.
