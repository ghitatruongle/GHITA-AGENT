# Code review findings — chu kỳ 0.0.1 (review 2026-11-09)

> Review toàn bộ 61 file thay đổi của Track 1–6 trước khi commit. Chia 3 vùng:
> sidecar/bảo mật (main thread) · fuzzy+hooks+AI-verbs (agent) · UI+configs (agent).
> Quy tắc: P1 = blocker phải sửa, P2 = sửa trong chu kỳ, P3 = ghi nhận/đề xuất.

## Vùng 1 — Sidecar & bảo mật (review trực tiếp)

| ID | Mức | File:chỗ | Phát hiện | Xử lý |
|---|---|---|---|---|
| S1 | P2 | `sidecar/mcp-handlers.mjs` mcp_call_tool | Không có timeout server-side — tool treo giữ promise pending vĩnh viễn, gọi nhiều lần chất đống memory | ✅ Đã sửa: `withTimeout` 120s (injectable `callTimeoutMs`) + `markFailure` cho health; 2 test hồi quy mới PASS (17/17) |
| S2 | P3 | `sidecar/mcp-handlers.mjs` respond() | Nhánh ack-throw không emit fallback (comment ghi ngược) — kết quả có thể mất khi client chết giữa chừng | ✅ Đã sửa: catch emit fallback + test PASS |
| S3 | ✅ Debug | `sidecar/native-screenshot.mjs` | Xác minh hoạt động THẬT trên máy: capture 332KB JPEG hợp lệ 945ms (biên dịch C# helper), temp file dọn sạch | PASS |
| S4 | P3 | server.mjs auth double-emit | getAuthorizedClient() đã emit EVENTS.ERROR + handler emit chat_error → 2 message/UI. Khớp pattern crew-handlers có sẵn — không phải bug mới, giữ nhất quán | Không đổi |
| S5 | ✅ | server.mjs diff (loadMcp relative path, singleton reset-on-error, host-tools adapter) | Pattern đúng, schema mapping an toàn | PASS |

## Vùng 2 — Fuzzy + hooks + AI verbs (agent reviewer)

| ID | Mức | File:chỗ | Phát hiện | Xử lý |
|---|---|---|---|---|
| F1 | **P1** | `search-replace-fuzzy.ts` sliding window | Levenshtein full-matrix O(L²)/window — đo thật: 2k dòng ≈ 7s/scan, 20k dòng > 600s → treo agent ở file lớn | ✅ Đã sửa (main thread): banded DP `|i−j| ≤ maxDist` + early-exit row-min + line-match prefilter (ratio ≥0.5) + CELL_BUDGET_PER_SCAN bail. Đo lại: 2k=40ms, 20k=1ms, miss 8ms; banded khớp full DP tuyệt đối tại biên ngưỡng (edits 1–6 đúng sim, edits 7 rớt đúng 0.95); 45/45 tests PASS |
| F2 | P2 | `search-replace.ts` cuối searchReplaceBatch | Fuzzy warning bị tag-guard error ghi đè mất tín hiệu "áp dụng nhờ đoán" | ✅ Agent sửa: merge warnings |
| F3 | P2 | `search-replace.ts` miss path | Quét fuzzy 3 lần/khối hỏng (matchSearch + resolveFuzzy + nearest) | ✅ Agent sửa: 1 scan @0.8 duy nhất, phân loại từ subset ≥0.95 |
| F4 | P3 | fuzzy module API | matchSearch gọi trực tiếp với CRLF → window giữ \r, splice replace LF-only → mixed endings. Mọi caller hiện đều chuẩn hóa qua searchReplaceBatch — rủi ro caller tương lai | Ghi nhận: normalize trong matchSearch khi có caller mới |
| F5 | P3 | `packages/agents/src/hooks/*` | 4 events mới (SessionEnd/SubagentStop/Notification/UserPromptSubmit) declared + test pipeline đủ nhưng runtime (react/agent.ts) chưa fire — dormant; PreCompact dormant từ trước | Ghi nhận: wiring follow-up 0.0.2 |
| F6 | P3 | `manager.ts` HOOK_CONTEXT | JSON trùng input (HOOK_INPUT đã có) → env phình đôi với input lớn; UserPromptSubmit.prompt giờ nằm trong env shell hook | Ghi nhận docs/hooks.md cần note; không có secret class mới |
| F7 | P3 | `browser-control/index.ts` resolveAiContext | input.llm không-callable → rơi im lặng về host llm (tốn cost) | Đề xuất reject rõ ràng — behavior change, chờ chủ ý |

Chống "test bảo kê": fuzzy/hook/skill tests assert đúng chiều, không thấy test luôn-pass. 122 tests/6 files pass tại máy reviewer.

## Vùng 3 — UI + configs (main thread — agent phụ bị kill do OOM, review thay)

| ID | Mức | File:chỗ | Phát hiện | Xử lý |
|---|---|---|---|---|
| U1 | ✅ | `useMcp.ts` | Lifecycle sạch: aliveRef+active guard, timer clear đúng, không loop emit (deps ổn), callTool chết giữa chừng trả timeout không treo UI | PASS |
| U2 | P3 | `fx/ShinyText.tsx` | useAnimationFrame của framer-motion tự cleanup ✓ nhưng vẫn chạy no-op 60fps khi paused | Ghi nhận — chi phí không đáng kể |
| U3 | ✅ | `MainLayout.tsx` view transitions | AnimatePresence mode="wait" có sẵn từ trước; chỉ thay inline variants → lib/motion (giá trị 1:1) | PASS |
| U4 | ✅ | `packages/communication/tests/wave3b-screen.test.ts` | Tạo ScreenCapture không inject — test intent là "capture fail vẫn quản lý flag đúng" → khớp behavior mới, không phải test gãy | PASS |
| U5 | ✅ | CommunicationServer/ScreenCapture callers | Toàn repo: server.ts (inject options) + 3 test file (inject hoặc không gọi capture) — không còn silent break | PASS |
| U6 | ✅ | mobile tsconfig paths | node_modules/react-native symlink → 0.87.1 đúng (tsc + jest 35/35 bằng chứng) | PASS |
| U7 | ✅ | quality-gates.yml smoke step | smoke-sidecar tự set GHITA_SMOKE + port ngẫu nhiên — chạy được trên runner windows | PASS |
| U8 | P3 | `build-installer.mjs` skip flag | Guard chỉ check dist/index.html tồn tại; có thể thêm check mtime dist vs src — giảm nhẹ vì pre-build version-sync (H1.3) đã chặn stale version string | Ghi nhận — nâng cấp 0.0.2 |
| U9 | P3 | build-installer finally | tauri.conf.json restore trong finally phủ mọi path lỗi (run() throw vẫn restore) ✓ | PASS |

## Tổng kết debug toàn chu kỳ review

- **3 P1/P2 thật đã sửa**: mcp_call_tool timeout server-side (S1), fuzzy O(L²) treo file lớn (F1), fuzzy warning bị đè + quét 3 lần (F2/F3).
- **Bằng chứng debug thực địa**: native screenshot chụp thật 332KB JPEG/945ms; banded DP khớp full DP tuyệt đối tại biên ngưỡng; đo lại hiệu năng 2k dòng 7000→40ms, 20k dòng >600s→1ms.
- **Tests sau review**: sidecar 17/17, ai-engine 45/45 (fuzzy+search-replace+edit-guard), hooks 20/20, skills+verbs 66/66 — chạy lại full gates ở mục dưới.

