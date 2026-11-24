# Track S4 — DONE: Computer-use gap + patterns phụ (2026-11-22)

> Worker S4. Không commit/push — chỉ working tree. Không blocker.

## Phương án chọn (P1) + lý do

**Chọn (a) — RPC bridge qua socket.io tới WebView desktop** (KHÔNG chọn (b) napi addon).

Verify kiến trúc đã xác nhận đúng gap: sidecar là node.exe độc lập do Tauri spawn
(`apps/desktop/src-tauri/src/lib.rs` chạy `server.bundle.mjs`), không bao giờ có
`globalThis.__TAURI__` → `createTauriAdapter()` (`packages/computer-use/src/operators/tauri.ts:49-63`)
luôn throw → `getOrCreateNodeRegistry()` rơi catch → `ComputerUseController()` rỗng →
mouse/keyboard/screenshot từ agent path KHÔNG hoạt động.

Lý do chọn (a):

1. **(b) quá nặng và trùng lặp native**: `computer_use.rs` nằm trong Cargo workspace ĐỘC LẬP
   của src-tauri (Cargo.lock riêng, không thuộc `crates/`) — tách thành napi addon đòi hỏi
   crate mới + chỉnh Cargo workspace + build native đa nền tảng, trùng lặp đường Rust đã
   hardened; rủi ro conflict với worker song song đang sửa crates/*.
2. **(a) tái dùng hạ tầng sẵn có**: sidecar đã là socket.io server; WebView desktop kết nối
   với auth session token (`authType: 'desktop'`, room `desktop`); pattern request/response
   id-correlation đã có (`require_approval` → `approve_command`); `sharedSocket.ts` đã import
   `invoke` từ `@tauri-apps/api/core`.
3. **Không build native, degradation rõ ràng**: headless (không desktop client) → action
   reject với lỗi rõ ràng thay vì "adapter is not available" mơ hồ.
4. **Bảo mật giữ nguyên**: native vẫn đi qua Tauri command duy nhất trong desktop process;
   whitelist `computer_*` ở CẢ HAI đầu (sidecar bridge + webview relay, defense in depth);
   thiết bị paired/cloud không bao giờ được attach làm relay (chỉ `isTrustedDesktopSocket`).

Flow mới: agent (sidecar) → `ComputerUseController` → bridge adapter
(`computer_use_invoke` + socket.io ack) → WebView relay (whitelist) → `invoke('computer_*')`
→ Rust `computer_use.rs`.

## P2 — Fix sidecar gap + e2e

- **Mới** `apps/desktop/src-tauri/sidecar/computer-use-bridge.mjs`: `createComputerUseBridge`
  — track socket desktop tin cậy (auto-detach on disconnect), `rpc(cmd, args)` per-command
  timeout (health/getScreenSize 5s, screenshot 20s, mặc định 10s), response-id guard,
  `undoDpiScale` mirror TauriOperator, adapter đầy đủ 5 method + healthCheck.
- **Sửa** `apps/desktop/src-tauri/sidecar/server.mjs`: import + singleton bridge; attach
  trusted desktop socket trong `io.on('connection')`; `getOrCreateNodeRegistry()` dùng
  bridge adapter (gỡ path `createTauriAdapter` chết + loader `loadComputerUseNode` dead code).
  `mobile_touch/mobile_type/mobile_key` tự hưởng (dùng chung `computerController`).
- **Sửa** `apps/desktop/src/utils/sharedSocket.ts`: relay listener `computer_use_invoke`
  (whitelist 7 lệnh, ack có try/catch, không đổi behavior các flow cũ).
  _Lưu ý: file này nằm ngoài footprint liệt kê trong task nhưng là bắt buộc của phương án
  (a) — chỉ có WebView có `__TAURI__`. Thay đổi thuần additive ~60 dòng._
- **E2E** `computer-use-bridge.test.mjs` (node --test, socket.io THẬT + fake Tauri relay
  phía client đúng hướng sidecar→WebView): 10/10 pass — gồm e2e "adapter điều khiển chuột +
  screenshot qua bridge thành công", whitelist, headless reject, timeout, lỗi Tauri truyền
  nguyên văn, validate input, id-mismatch, disconnect-recovery.

## P3 — Port nut-js patterns vào packages/computer-use

Mới `packages/computer-use/src/screen/` (export qua `index.ts`):

| File               | Port từ nut-js                                | Nội dung                                                                                                                                                                         |
| ------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `region.ts`        | screen.class.ts:39-84 + window.class.ts:43-71 | `validateSearchRegion` (throw: NaN/âm/<2px/vượt màn hình, `InvalidSearchRegionError`) + `clampRegionToScreen` (gốc âm shadow-border → dịch về 0, tràn → cắt, max 0, KHÔNG throw) |
| `match-request.ts` | match-request.class.ts:3-10                   | `MatchRequest<HAYSTACK, NEEDLE, PROVIDER_DATA_TYPE>` generic + `MatchResult` + `createMatchRequest` (confidence mặc định 0.99, chặn 0/>1/NaN)                                    |
| `waitFor.ts`       | timeout.function.ts:7-76                      | `waitFor` poll: chạy action ngay, retry intervalMs=500, timeoutMs=5000, AbortSignal → reject ngay (`WaitAbortedError`, name `AbortError`), timeout kèm `lastRejectionReason`     |
| `index.ts`         | —                                             | barrel                                                                                                                                                                           |

Tests `tests/screen-patterns.test.ts`: 25/25 pass (4 điều kiện validate, 6 case clamp gồm
maximized/offscreen, waitFor retry/timeout-reason/abort-in-sleep/abort-before-start/options
guard, MatchRequest default/ko-generic/invalid confidence).

## Optional — hashcash PoW + đối chiếu docloader

- **Mới** `packages/security/src/hashcash.ts` (clean-room, thiết kế theo deep-dive open-agent
  mục 4, KHÔNG copy code): stamp v1 7 trường `1:bits:ts:resource:ext:rand:counter` (ts UTC
  `YYYYMMDDHHMMSS`, rand alphanumeric 16), mint SHA3-256 tới `ceil(bits/4)` nibble zero,
  check `floor(bits/4)` + `bits >= requiredBits` + resource chính xác + TTL 5 phút + chặn
  timestamp tương lai (skew 60s) + cap `MAX_HASHCASH_BITS=64` chống DoS difficulty.
  Export qua `packages/security/src/index.ts`. Tests `tests/hashcash.test.ts`: 19/19 pass
  (gồm case asymmetry bits=13: mint 4 nibble / check 3 nibble vẫn pass như thiết kế).
- **Đối chiếu crates/docloader ↔ open-agent doc_loader (chỉ ghi nhận, không sửa):**
  Ghita `crates/docloader` = std-only extraction core (`DocLoadResult{content, mime_type,
size_bytes, source}`, detect_mime + HTML strip, PDF/DOCX stub opt-in feature + napi addon
  dyn-symbols — cùng pattern napi với sandbox). open-agent đi xa hơn ở tầng CHUNKING:
  tree-sitter splitter, Markdown/TokenSplitter, `Chunk{index, content}`, RAG 7168 token
  overlap 128 → pgvector. Kết luận: nếu sau này Ghita cần RAG chunking trong Rust, thiết kế
  `Chunk{index, content}` + tree-sitter splitter của open-agent là mẫu tham khảo; hiện
  docloader Ghita đúng phạm vi extraction nên không cần thay đổi.

## Gates (kết quả thật)

- `pnpm turbo run build --filter=@ghita/computer-use --filter=@ghita/security` → 10/10 OK.
- `pnpm turbo run test --filter=@ghita/computer-use --filter=@ghita/security` →
  computer-use 241 pass / 13 skipped (dso-integration cần Docker) — gồm 25 test mới;
  security 176 pass — gồm 19 test hashcash mới.
- `node --test apps/desktop/src-tauri/sidecar/computer-use-bridge.test.mjs` → 10/10 pass.
- `tsc -b` apps/desktop (typecheck sharedSocket relay) → exit 0.
- Desktop vitest targeted (3 file tiêu thụ sharedSocket: SkillManager, components-render,
  views-render) → 44/44 pass.
- `pnpm knip` → exit 0, không có issue mới (chỉ configuration hints có sẵn).
- `node --check` server.mjs + computer-use-bridge.mjs → OK. server.bundle.mjs là artifact
  gitignored (được build lại khi `pnpm build:sidecar`).

## Files footprint S4

- Sửa: `apps/desktop/src-tauri/sidecar/server.mjs`, `apps/desktop/src/utils/sharedSocket.ts`,
  `packages/computer-use/src/index.ts`, `packages/security/src/index.ts`.
- Mới: `apps/desktop/src-tauri/sidecar/computer-use-bridge.mjs` (+test),
  `packages/computer-use/src/screen/{index,region,match-request,waitFor}.ts`,
  `packages/computer-use/tests/screen-patterns.test.ts`,
  `packages/security/src/hashcash.ts`, `packages/security/tests/hashcash.test.ts`.

## Ghi chú cho owner

1. `apps/desktop/src/utils/sharedSocket.ts` ngoài footprint liệt kê nhưng là mảnh bắt buộc
   của phương án (a) — không có receiver phía WebView thì bridge không chạy.
2. Test bridge sidecar chạy bằng `node --test` trực tiếp; nếu muốn đưa vào CI cần thêm vào
   script `test` của `apps/desktop/package.json` (không tự sửa vì ngoài footprint).
3. Không commit/push/tag — toàn bộ nằm ở working tree.
