# Audit wiring module demo2 (T6.4 — kế hoạch v0.0.1, 2026-11-08)

> Tiêu chí xong của T6.4: "Danh sách khớp thực tế" — đây là bằng chứng audit, không phải câu chữ từ memory cũ.

## Kết quả audit (grep toàn repo, 2026-11-08)

| Module demo2 | File | Export? | Wire thật? | Kết luận |
|---|---|---|---|---|
| AIPageController (stagehand act/extract/observe) | packages/browser-control/src/stagehand.ts | ✅ index.ts:245 | ❌ chưa có skill nào gọi | **T6.2 wire ngay trong chu kỳ này** |
| AIPageCache (stagehand-cache) | stagehand-cache.ts | ✅ index.ts:246 (từ stagehand.js) | ✅ dùng trong stagehand.ts | OK |
| BrowserMCPServer | mcp-server.ts | ✅ index.ts:248 | ❌ export-only | Chờ 0.0.2 |
| track7 (browser track) | track7/index.ts | ✅ index.ts:251 | ❌ export-only | Chờ 0.0.2 |
| stealth-v2 | stealth-v2.ts | ✅ index.ts:268 (types) | ❌ export-only | Chờ 0.0.2 |
| dom-extractor | dom-extractor.ts | ✅ index.ts:242 | ✅ sidecar dùng gián tiếp qua skills? | Cần verify 0.0.2 |

Ghi chú: `createBrowserControlSkills` (index.ts:130) chỉ đăng ký browser.open/close/navigate/click... — không có verb AI (observe/act/extract). Sidecar lazy-import cả package (server.mjs:56). = **1 module wire trong chu kỳ này (T6.2), 4 module ghi rõ chờ 0.0.2**.
