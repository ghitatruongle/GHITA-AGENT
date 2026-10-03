# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.2.0-demo1] - 2026-10-04 (DEMO — đang thử nghiệm, chưa phải bản phát hành)

> **Bản demo, chưa phải bản phát hành.** 10 điểm cải tiến đã có bằng chứng đo
> được, nhưng phần UI chưa nối vào hết (xem "Chưa nối UI" bên dưới). Cần thử
> nghiệm lâu dài trước khi coi là dùng được.

Mốc demo2: 5 dự án tham khảo → 10 điểm cải tiến → map 1-1 vào 10 tính năng đã
có. Không thêm tính năng mới; tất cả là làm một tính năng đang tồn tại trở nên
thật. Bằng chứng: `docs/research-demo2-10-points.md` · `docs/demo2-baseline.json`
(chạy lại bằng `pnpm benchmark:demo2`).

### Vòng review toàn diện + debug (2026-10-04)

Review toàn bộ thay đổi (26 file sửa + 20 file mới) theo 6 vùng độc lập, rồi
sửa ~30 lỗi tìm được. Đáng chú ý nhất:

- **Treo vô hạn agent** (`search-replace.ts`): một khối `...` bị ngược làm phần
  mở rộng ra chuỗi rỗng, rồi bộ đếm khớp quay vô tận. Chặn ở cả nguồn và ở bộ đếm.
- **Hỏng file âm thầm**: `$&`/`$1` trong nội dung thay bị hiểu thành mẫu thay;
  file CRLF của Windows không khớp được và bị ghi lẫn `\r\n` với `\n`; thay nhầm
  dòng khi mẫu khớp giữa token (`xreturn`).
- **Gate typecheck vô hiệu**: `turbo quality:tests` không chạy task ở package
  root, nên `pnpm typecheck` chưa từng kiểm tra gì ở gate mới. Đã nối lại, và
  nối luôn suite test đối kháng (`tests/demo2-adversarial`) vào `pnpm test`.
- **Cổng hoàn thành bị qua mặt**: `<task-done>` kèm `exitCode` khác 0 (lệnh vừa
  fail) vẫn được nhận là "xong" — nay chỉ `exitCode: 0` mới tính là bằng chứng.
- **UI kẹt trạng thái**: nối node tạo vòng lặp bị chặn thì WorkflowView kẹt luôn
  ở chế độ nối (chỉ Escape mới ra được); thiếu bù scroll ở 2 chỗ tạo node.
- **Rò rỉ trong subagent channel**: reply tới sớm làm timer và subscription
  `reply:<id>` rò vĩnh viễn. Flow đếm sai số lần retry; `maxConcurrency = NaN`
  khiến flow chạy 0 step mà vẫn báo `completed`.
- **Rust**: `from_token_counts` thiếu kiểm tra độ dài (lệch là panic lúc `query` —
  qua napi là chết process Node); lọc NaN/Infinity cho tham số k1/b.
- Lỗi nhỏ khác: lỗi chat hiện 2 lần, metric ghi nhần click/fill, MCP health `get()`
  trả bản ghi nội bộ, `fix-mojibake.mjs` chặn file nhị phân trước khi ghi.

Kiểm chứng sau khi sửa: `pnpm typecheck` 44/44 · `turbo test --force` 44/44 ·
`pnpm test:root` 702/702 · `cargo test` exit 0 · repro 3/3 hành vi lỗi đã hết.

### Track 0 — Sửa lỗi hiển thị

- **Mojibake 36 chỗ trong sidecar** (`apps/desktop/src-tauri/sidecar/server.mjs`):
  text tiếng Việt bị đọc sai kiểu cp1252 rồi lưu lại thành UTF-8. Người dùng thấy
  `chÆ°a ÄÆ°£c cáº¤u hÌnh` thay vì "chưa được cấu hình", emoji `ðŸŽ‰` thay vì 🏆.
  Đây là thứ **mọi người dùng mới đều nhìn thấy đầu tiên** và dễ tưởng app bị lỗi font.
  Sửa bằng `scripts/fix-mojibake.mjs` — chỉ repair khi kết quả hợp lệ tuyệt đối
  (không sinh ký tự thay thế, không sinh ký tự điều khiển), nên ký tự đang **đúng**
  như `—` được giữ nguyên.

### Track 1 — Nghiên cứu 5 dự án tham khảo

- 5 dự án khảo sát sâu: `aider` (Apache-2.0), `stagehand` (MIT), `continue`
  (Apache-2.0), `openhands` (MIT), `claude-code` (**proprietary** — chỉ học ý
  tưởng kiến trúc, tự viết lại, không sao chép văn bản; bản clone không chứa source agent).
- Xếp hạng lại theo giá trị thực tế: `aider` hạng 1, `claude-code` hạng 6.

### Track 2 — Mười điểm cải tiến (đều có số liệu trước → sau)

| #   | Điểm                                                                          | Tính năng                | Trước                                       | Sau                                           |
| --- | ----------------------------------------------------------------------------- | ------------------------ | ------------------------------------------- | --------------------------------------------- |
| 1   | Tool `search_replace` cascade 4 tầng + lỗi **hành động được**                 | A5 AI edit-apply         | chỉ khớp chính xác (40% tình huống thực tế) | **100%**; file không bị ghi khi còn khối hỏng |
| 2   | Vòng verify lint→test có trần, **hết trần thì DỪNG hỏi người dùng**           | A6 Multi-file edit queue | không hề kiểm tra gì                        | `retry → retry → retry → escalate`            |
| 3   | Cache best-effort cho browser observe/act/extract                             | D4 Browser control       | 5 lần gọi LLM / 5 `act()`                   | **1 lần** (−80%)                              |
| 4   | `attempts` đẩy lên UI/telemetry + trần retry cấu hình được                    | A30 WebView panel        | không đi đâu, trần cứng 2                   | qua `ctx.onMetric`                            |
| 5   | Content-addressed incremental indexing                                        | A24 CodeGraph view       | dựng lại toàn bộ kho                        | đổi 95/200 file → chỉ re-index 95 file        |
| 6   | Context provider fan-out, try/catch độc lập từng nguồn + dedup theo vùng dòng | D1 Memory/RAG            | 1 nguồn chết là mất sạch ngữ cảnh           | **2/3 nguồn sống**; dedup 2 chunk trùng → 1   |
| 7   | Compaction thành sự kiện 4 outcome + đo chất lượng nén                        | A2 Dashboard             | im lặng, không ai biết                      | `CompactionMonitor` + `retention`             |
| 8   | Tầng MCP health 4 trạng thái + TTL, verdict **không persist**                 | D3 MCP                   | chỉ có `connected: boolean`                 | phân biệt `unknown` với `degraded`            |
| 9   | Completion-promise contract + cổng chặn                                       | A3 Chat streaming        | tự nói "xong" không bằng chứng              | `CompletionGate`, hết 3 lượt thì dừng hỏi     |
| 10  | Bản kê bắt buộc cho subagent + đo tỉ lệ sửa nhầm file                         | A13 Agents view          | không có                                    | `EvidenceManifest`                            |

### Phát hiện: đừng đổi chiến lược compaction mặc định

Đo trên transcript 198.690 token có đường dẫn và tên hàm thật:

| Chiến lược              | Giảm token | **Giữ lại thông tin then chốt** |
| ----------------------- | ---------- | ------------------------------- |
| `summary`               | 99%        | **0,8%**                        |
| `sliding_window`        | 61%        | 38,6%                           |
| `trajectory` (mặc định) | 54%        | **77,4%**                       |

Nhìn số token thì `summary` thắng áp đảo, nhưng nó **giữ lại 0,8% đường dẫn và tên
hàm** — agent sẽ không biết mình đang sửa cái gì, và lỗi đó hiện ra âm thầm.
Mặc định hiện tại là cân bằng tốt nhất nên **giữ nguyên**, chỉ thêm sự kiện để đo.

Bài học: chỉ số "giảm token" một mình là chỉ số **nguy hiểm** — nó thưởng cho
hành vi ném bỏ thông tin. Mọi tối ưu sau này phải đi kèm một chỉ số chất lượng.

### Vòng review + debug (2026-09-27) — 14 lỗi tìm được, đã sửa hết

Đợt này viết bộ test đối kháng riêng (38 test, `tests/demo2-adversarial/`) cố
làm hỏng từng module mới, cộng một lượt rà soát độc lập cho phần Rust + script.
Kết quả: **14 lỗi thật**, đã sửa hết và thêm test hồi quy cho từng cái.

**Nghiêm trọng nhất — BUG-006: "incremental indexing" không tăng tốc gì.**
Doc comment khẳng định _"không tốn công tokenize lại"_, nhưng `reindex()` gọi
`BM25Index::build()` với toàn bộ chunk nên tokenize lại 100%. Đo được: đổi 1/400
file mất 8163 µs, đổi 400/400 file mất 7138 µs — **tỉ lệ reindex giảm 499 lần mà
thời gian không giảm**. Test chỉ assert trên tỉ lệ nên vẫn xanh: số liệu đẹp,
sự thật thì không. Sửa bằng cách cache dạng **đã tokenize** và tách
`BM25Index::from_token_counts()` khỏi `build()`. Đo lại: dựng lạnh **34,3 ms**,
đổi 1/400 file **7,8 ms** (nhanh gấp 4,4 lần, tokenize giảm 727 lần).
Chạy lại: `cargo run --release -p ghita-retrieval --example bench_incremental`.

**BUG-001 — `search: ''` khớp ở mọi vị trí.** Model sinh thẻ bị cắt cụt sẽ khiến
lệnh ghi bậy nội dung vào file. Đã chặn và báo lý do cụ thể.

**BUG-010 — `fix-mojibake.mjs` sửa nhầm file KHÔNG phải mojibake, im lặng.**
Bản đầu chỉ kiểm "bytes giải ra UTF-8 hợp lệ", nên `É©` (tiếng Pháp) bị đổi thành
`ɩ` mà không cảnh báo. Đã thêm điều kiện "trông như mojibake thật": ký tự dẫn
đầu cp1252 **và** ký tự kế nằm trong 0x80–0xBF — nhờ đó `Ärger` (tiếng Đức) và
`É©` (tiếng Pháp) giữ nguyên. `--write` giờ luôn tạo bản `.bak`.

**BUG-013 — chỉ số `bestStrategy` chọn theo tiêu chí mà chính file cảnh báo là
nguy hiểm.** Nó xếp theo số token thấp nhất, nên tôn vinh `summary` (giảm 99%
token nhưng chỉ giữ lại 0,8% thông tin). Đã đổi: loại chiến lược có retention
< 50% trước, rồi mới ưu tiên giữ thông tin — kết quả chuyển sang `trajectory`.

**Còn lại:** khoá `k1`/`b` bị bỏ qua khi nội dung không đổi (đổi tham số vô tác
dụng); `plan()` trả vector không ổn định giữa các process; `plan()` hash kho hai
lần; `index_size` thực chất là số từ khoá chứ không phải số chunk; script bỏ sót
ký tự điều khiển C1; `searchReplaceBatch` ném thay vì trả lỗi gọn; xoá dòng để
lại dòng trống; `🎉 Xong!` không bị chặn; hai module trả `'abort'`/`'escalate'`
cho cùng một việc.

**Phát hiện thêm:** `track7/act-cache.ts` đã tồn tại từ trước và cache đúng thứ
Điểm 3 nhắm tới (SQLite, TTL, SHA-256) nhưng **không được nối vào đâu**. Đã nâng
`AIPageCache` lên SHA-256 để không kém — với cache hành động trình duyệt, va
chạm hash nghĩa là **click nhầm phần tử**. Hai bản nên gộp ở mốc sau.

### Vòng review mở rộng ra toàn repo (2026-09-27) — 29 lỗi nữa

Mở rà từ phần demo2 sang những nơi chưa từng được soi: 9.700 dòng
`packages/agents` không ai gọi, các view "có vỏ không ruột", hai cache trình duyệt,
8 cảnh báo clippy bị trì hoãn. **29 lỗi thật, đã sửa 13 cái nặng nhất.**

Nặng nhất ở `packages/agents`:

- **BUG-015** — glob `**` bị thay hai lần trong `markdownGate.ts`: chuỗi thay thế
  `(?:.*/)?` chứa ký tự `*` nên bị lượt sau cắn, thành `.[^/]*`. Hệ quả:
  `**/*.md` chỉ khớp 1 cấp thư mục → **bỏ sót mọi file markdown từ độ sâu 2 trở
  lên**, đồng thời không loại trừ được `dist/**` ở độ sâu con.
- **BUG-016** — `enforceInboxCap` xoá `mailbox_messages` mà không xoá
  `mailbox_deliveries` (schema bật foreign keys) → ném `FOREIGN KEY constraint
failed`, `send()` thứ tư ném exception và rollback: **mất tin nhắn**.
- **BUG-017** — `chunkArray` với `maxConcurrency = 0` → `i += 0` không bao giờ
  tăng: **vòng lặp vô tận nuốt CPU**, làm OOM worker Node.
- **BUG-018** — `sleep(backoff)` không `await` trong `execGit`: 5 lần retry chạy
  liền trong 24 ms thay vì 1,5 s. Đúng cái race giữa các agent mà module này sinh
  ra để chống lại, bị vô hiệu hoá.
- **BUG-019** — PII redaction dựng lại message bằng `new Ctor(redacted, {metadata})`
  mất `toolCalls`: chỉ cần MỘT email trong nội dung assistant là **toàn bộ lệnh
  gọi tool của agent bị xoá**, vòng tool-calling gãy.

Còn sửa: timer timeout không huỷ (BUG-020), `retries` lệch 1 (021), timer 30 s rò
rỉ sau khi reply tới sớm (022), hai key khác nhau ghi đè nhau sau sanitize — mất
dữ liệu âm thầm (023), extension giả cho file không có đuôi (024), evaluator sập
vì finding dữ liệu bẩn (025), đồng bộ cha–con âm thầm mất (026), plan không ổn
định (027).

Ở UI — các lỗi người dùng nhìn thấy ngay:

- **BUG-028** — `used` bị chặn 128000 nhưng `percentage` tính từ giá trị chưa chặn
  → Dashboard hiện đồng thời "128000/128000" (=100%) và **"156%"**.
- **BUG-029** — `chat_done` dùng `.map` chỉ đổi placeholder; placeholder đã bị
  `chat_error` xoá thì `.map` là no-op → **nội dung trả về biến mất không dấu vết**.
- **BUG-030** — id hardcode dùng `-` còn catalog dùng `.` → dedup khớp **0/6**,
  MỌI plugin hiện 2 thẻ, cài bản này bản kia vẫn hiện nút "Cài đặt".
- **BUG-031** — `summary: [summary]` bọc object vào mảng → nhánh "chưa có dữ liệu"
  không bao giờ chạy, luôn thấy một dòng toàn số 0.
- **BUG-032** — graph là singleton nhưng `discoverAndIndex` không `clear()` → đổi
  workspace thì kết quả gồm node của **cả hai repo**.
- **BUG-033/034** — kéo node không trừ scroll (node nhảy ngược khi cuộn xa); cho
  phép tạo chu trình thì `Flow.runDAG` ném lỗi lúc chạy.

Hạ tầng đo lường:

- **BUG-035** — `tests/` ở gốc **không bao giờ được typecheck**. Đã thêm
  `tsconfig.json` gốc + turbo task `quality:tests`, nối vào `pnpm typecheck` và
  `dogfood`. `tsconfig.tests-full.json` ghi lại **103 lỗi type còn nợ**, phần lớn
  là API drift — test tham chiếu tới thứ không tồn tại
  (`PROTOCOL_EVENT.APPROVAL_RESPONSE`, `CommunicationGateway.simulateMessage`,
  `SkillInvocation.args`): luồng approval hiện **không được kiểm chứng gì**.
- **BUG-036** — 8 cảnh báo clippy trong `napi.rs`: chỉ **1** là lint thật
  (`manual_is_multiple_of`); 7 còn lại là cảnh báo giả vì các hàm có `#[napi]` đã
  được đăng ký sang JS. Đã sửa lint thật và ghi chú cho `#[allow(dead_code)]`.

**Phát hiện lớn nhất: addon Rust chưa bao giờ được JS nạp.** `loadNative()` toàn
repo chỉ được gọi một lần cho `tokenizer`. Toàn bộ addon `retrieval` (BM25, RRF,
vector search, splitter) nằm im — JS fallback luôn chạy. Đi kèm BUG-006, điều này
cho thấy phần Rust hoá hiện tại có công sức port nhưng chưa có đường dẫn chạy thật.

### Chưa nối UI (cần mốc sau)

Các lớp dưới đã có và đã test, nhưng **chưa** được nối vào giao diện:
`AIPageCache`, `CompactionMonitor`, `McpHealthStore`, `VerifyLoop`, `CompletionGate`.
10/10 điểm có bằng chứng ở tầng thư viện, chưa có ở tầng màn hình.

### Kiểm chứng

`turbo test` 13/13 task · ai-engine 70 test file · browser-control 11 · agents 29 ·
mcp 2 · `cargo test -p ghita-retrieval` 39/39 · `cargo fmt` sạch · `sync-version` OK ·
`check-artifacts` OK · 23 chỉ số trong `docs/demo2-baseline.json`.

## [1.2.0-demo1] - 2026-08-31 (chưa phát hành — chờ owner nghiệm)

### Track 1 — Ổn định 100%

- **Feature verification matrix** (`docs/feat-matrix-1.2.0.md`): 55 dòng tính năng user-facing (34 desktop, 8 mobile, 1 vscode, 12 engine cross-cutting) — **55/55 ✅** với bằng chứng tự động.
- **Bằng chứng mới**: `views-render.test.tsx` (15 test — mọi view desktop mount không throw + regression BUG-005), `components-render.test.tsx` (16 test — 15 component tương tác + click export chat Markdown thật), `useModelSelection.test.ts` (4 test — model options động), `apps/mobile screens-load.test.tsx` (5 test module-load), `splitters.parity.test.ts` (20 test JS↔Rust).
- **Bug đã sửa** (`docs/bugs-demo1.md`):
  - **BUG-001** (nghiêm trọng, Windows): native `split_fixed` cắt theo byte offset → **panic abort cả ingest worker** trên tài liệu CJK/tiếng Việt (`end byte index is not a char boundary`) — CI Linux không thấy vì addon không build trong test job. Viết lại UTF-16-unit + char-boundary an toàn + clamp overlap đúng JS. Rust 24→30 test, ingest JS 32/32, parity 20/20.
  - **BUG-004**: native `split_markdown` chỉ nhận H2, JS nhận H1–H3 + re-wrap `## ` → chunk khác nhau giữa máy dev và CI. Mirror JS chính xác; thêm tham số overlap vào `split_markdown_native`.
  - **BUG-005**: `check_update` (updater đã ký) không có UI gọi — tính năng không tới được người dùng. Nút "Check for updates" trong Settings → About, i18n 4 key × 6 locale, regression test.
  - **BUG-002/003** (splitCode/splitRecursive native): CLOSED-BY-DECISION — đo cho thấy JS <1ms và native string-slice chậm hơn JS qua FFI; quyết định ghi trong `docs/rust-demo1-design.md`.
  - **Review+debug pass (fuzz adversarial)**: bắt thêm 2 bug — **BUG-006**: JS `splitFixed` fallback cắt đôi surrogate pair (emoji → lone surrogate hỏng text) + lặp vô hạn khi `chunkSize≤0` + nhảy ký tự khi overlap âm; fix bằng đường code-point-safe mirror Rust, giữ fast path BMP. **BUG-007**: Rust `split_markdown` xử lý heading whitespace-only (`'##   '`) khác JS (regex match capture rỗng); fix truthiness-style. Regression: `splitters.fuzz.test.ts` 93 test + `editProposal.lcs-fuzz.test.ts` 7 adversarial + `check-bench-probe-parity.mts` (probe==production 310/310).

### Track 2 — Tối ưu thuật toán (3/3 vùng ≥20%)

- **Diff-stat** (`lcsLength`, apps/desktop): naive DP O(n·m) → **common prefix/suffix trim + Hunt–Szymanski LIS** (parity float-identical, golden test 200 fixture ngẫu nhiên): realistic 5k dòng đổi 1% **1120.6 ms → 1.5 ms (−99.9%)**; worst-case **1698.9 → 2.0 ms**; probe chính thức bench-cpu [E] **1452.9 → 0.9 ms** — baseline `docs/perf-baseline.json` cập nhật, gate "within 10% of baseline" xanh.
- **Memory scoreAll** (`packages/memory`): pairwise O(n²) set-scan → **adaptive bitset/inverted-index** (chi phí ước lượng `N²·words` vs `Σ postings²`, chọn cái nhỏ hơn; skip theo id-equality đúng bản gốc): 1k entries **522.7 ms → 21.9 ms JS (−95.8%)**.
- **Native splitter**: ASCII fast path + streaming `char_indices` (bỏ Vec<char> toàn input): đường native CJK **4.3 → 3.2 ms (−26%)** và đúng semantics.
- Profiling chi tiết + xếp hạng điểm nóng: `docs/profiling-1.2.0-demo1.md`; bench tái hiện: `examples/bench-demo1.mts`, `examples/bench-demo1-split.mts`.

### Track 3 — Rust hóa nhỏ gọn

- **`shared_counts` port sang `crates/retrieval`** (module `importance.rs`): phần đếm shared-token của scoreAll chạy native (bitset popcount / inverted-index accumulate, so sánh ngưỡng bằng IEEE f64 đúng JS, duplicate-id group skip qua `group[]`). `MemoryCompactor.scoreAll` wire `native ?? js` — 1k entries **21.9 → 11.9 ms** (tổng **−97.7%** so với 522.7 ms gốc). Parity test trực tiếp 4/4 + golden 4/4 cả hai nhánh.
- Ứng viên PageRank/textops bị phế truất có bằng chứng (dead code / JS đã <1ms) — `docs/rust-demo1-design.md`.
- Rust gates: `cargo test -p ghita-retrieval` **30/30**, clippy `--features addon -D warnings` 0, fmt sạch, addon rebuild + parity JS xanh.

### Gates (chạy 2026-08-31, toàn bộ xanh)

typecheck 44/44 · lint 43/43 · turbo test 44/44 (desktop 209, memory 270, ingest 52) · knip 0 · audit-security baseline 44 không tăng · cargo fmt/test/clippy workspace 0 warning · desktop-smoke 4/4 · e2e-smoke 4/4 · evals 79/100 PASS · coverage T0/T1 6/6 · integrity + check-artifacts OK · smells ok · audit:policy + licenses OK · i18n 432 strings × 6 locale · **dogfood 18/18**.

## [1.1.5] - 2026-08-24

### Track 6 — Quality Gates & Publish Readiness

- **Zero-warning sweep**: typecheck 44/44 · eslint 43/43 · knip exit 0 · clippy workspace 0 warning.
- **Full test**: turbo test 44/44 · **evals gate 79/100** (baseline 75) PASS · **coverage T0/T1 đạt floor**: security 90.4%/82.8% (lines/branches, floor 80/75), agents 58.8%/74.1%, communication 53.6%/80.7%, ai-engine 64.6%/76.4%, memory 52.0%/75.7%, skills 59.0%/69.9%.
- **Smoke**: desktop-smoke **4/4 PASS** — sửa import thiếu `.ts` trong `editProposalStore` khiến node type-stripping không resolve được; startup modules **983ms** (trước đây 1993ms — hiệu ứng Monaco lazy-load của Track 4). E2E smoke **4/4**: ingest-cli, evals-internal, security-scanner, mcp-interop.
- **Security re-audit**: `audit-security.mjs` exit 0 — baseline 44 findings không tăng sau Track 2–5.
- **Docs**: SECURITY.md cập nhật posture 1.1.5 (keyring là nguồn chuẩn, pairing cần xác nhận desktop + token mã hóa AES-GCM, CSP nghiêm ngặt, FS scope, approvals desktop-only); README badge / ROADMAP header đồng bộ 1.1.5.
- **Installer final**: `release/GHITA-CODING-AGENT-Setup-v1.1.5.exe` (27.4 MB), **SHA-256 `a70d998fe524aa9f8f9fbd38057fc3b09f26f75fb3cac3de41b7d9eff34b2e75`** (đã verify ngược). Version 1.1.5 đồng bộ toàn monorepo; CHANGELOG phát hành 2026-08-24.

### Track 5 — Rust Acceleration & Security

- **Tokenizer (S)**: BPE vocabulary (o200k/cl100k/r50k) khởi tạo đúng **một lần mỗi process** qua `OnceLock` static — trước đây rebuild full vocab trên MỖI cache miss; `count_messages_tokens` hưởng lợi trực tiếp. **Micro-bench** (`examples/bench_vocab.rs`, release, 200 unique texts — toàn cache miss): OLD **40.682 ms** (vocab rebuild ~203 ms/text) vs NEW **226 ms init một lần + 7 ms steady-state** → **~5.812×** trên đường cache-miss, token totals khớp 100% (4000 == 4000).
- **Code-graph**: Tarjan SCC viết lại dạng **iterative** với call-stack tường minh — hết nguy cơ tràn stack trên dependency chain sâu; 16/16 test pass gồm `tarjan_cycle_detection`.
- **Cosine wiring**: `memory/search.ts` và `knowledge.ts` trước đây hardcode bản JS chậm dù binding SIMD nằm ngay trong package — giờ ưu tiên `getNativeCosine()` (SIMD native) và fallback JS khi addon vắng mặt.
- **Diff một đường**: `useLineDiffStat` bỏ pass JS O(n·m) ban đầu trong Tauri runtime — chỉ còn đường native off-thread; JS giữ làm fallback cho CLI/web.
- **Secscan parity + spans + redaction**: bộ fixtures secret dùng chung mirror giữa Rust (`secret_parity_fixtures_match_ts_corpus`) và TS (`tests/secret-parity.test.ts`) — drift giữa rule literal Rust và regex engines TS sẽ vỡ test ở cả hai phía. `ScanResult` bổ sung `match_starts`/`match_ends` (UTF-8 byte offsets, additive); helper `redactSpanned()` mới trong `@ghita/security` redact đúng span từ scanner. `SecretDetector` (enterprise) route qua native: một pass combined-regex của secscan làm pre-filter — nội dung sạch bỏ qua trọn vòng 80+ regex JS; JS giữ là nguồn chuẩn cho span/redaction; customPatterns vẫn được cover vì pre-filter dựng từ pattern list của chính instance. Guardrails `detectSecrets` cũng route native pre-filter tương tự (rules dựng từ 7 pattern của chính module); parity test mở rộng khẳng định đủ 7 category guardrails trên fixture corpus — và đã bắt ngay một drift thật: pattern `openai_key` của guardrails không nhận `sk-proj-` (đã đồng bộ với enterprise/secscan/scanner).
- **Docloader DOCX + PDF thật**: triển khai `extract_docx` bằng `zip` (inflate) + `quick-xml` — đọc được document DEFLATE-compressed (trường hợp phổ biến, JS cũ chỉ xử lý được zip STORED), xử lý XML escape + xuống dòng theo paragraph; và `extract_pdf` bằng `pdf-extract` (lopdf) — ingest trước đây bỏ qua hoàn toàn PDF khi không inject reader. Cả hai expose qua napi (`extractDocxJs`/`extractPdfJs`); `ingest/loaders.ts` ưu tiên native qua native-bridge (reader inject giữ ưu tiên cao nhất), fallback JS giữ nguyên. Test gồm PDF tự sinh với xref table hợp lệ. Deps mới opt-in features `docx`/`pdf` (zip-rs, quick-xml, pdf-extract).
- **Deferred có chủ đích (đã chốt với owner)**: gộp HNSW vào crates/retrieval và chuyển memory rust-napi loader sang native-bridge để lại cho sau 1.1.5 (loader hiện tại đã hoạt động và có test); PDF parse đã thực hiện theo lựa chọn của owner.
- Gates: cargo workspace test 66/66 · clippy 0 warning · typecheck 44/44 · turbo test 44/44 · eslint 43/43.

### Track 4 — Performance & Resources

- **Memory DB (L win)**: SQLite mở với `WAL` + `synchronous=NORMAL` + `auto_vacuum=INCREMENTAL`; autoVacuum chạy `PRAGMA incremental_vacuum` thay vì full-file `VACUUM` mỗi 10 lần ghi (trước đây rewrite toàn bộ DB dưới exclusive lock, đơ sidecar giữa cuộc chat); prepared statements cache cho hot path `indexChatMessage`. **Micro-bench 2.000 inserts: 14.0–23.6s → ~225–260ms (~60–90×)**.
- **KvStore (Rust)**: `PRAGMA journal_mode=WAL` khi mở; thêm `set_many(keys, values)` — N key chỉ tốn 1 commit thay vì N fsync round-trip.
- **Streaming UI**: `MarkdownMessage` được `memo()` với bảng components ổn định; trong lúc stream render plain-text (markdown parse O(n²) theo độ dài phản hồi trước đây chạy mỗi flush 50ms); post-chunk hooks coalesce theo batch ~40ms (`streamWithHooks`) thay vì gọi per-token.
- **Startup**: Monaco (~2MB + 5 workers) không còn nằm trong entry chunk — lazy-load đúng lúc CodeEditor mount đầu tiên; MarketplaceView/SymbolOutline chuyển sang deep imports (@ghita/skills/marketplace/\*, @ghita/code-graph/ast-parser) để khỏi kéo PTY pool/MCP server/better-sqlite3 vào renderer bundle.
- **Parallelization**: `testAll()` providers, MCP `connectAll()`, và cache-warmer sources chạy song song (hết cộng dồn latency tuần tự); semantic-dedup `bulkAdd` embed batch 8 luồng.
- **Sidecar & tools**: Ralph loop `tsc --noEmit` chuyển sang `execFile` async (trước đây block event loop tới 30s); edit-review đọc file và checkpoint ghi file qua `fs/promises`; `listDirectory` có cap 500 entries/depth 12, trả compact JSON kèm chú thích truncate.
- **Compaction**: `scoreAll` pre-tokenize mỗi entry một lần vào Map (bỏ vòng tokenize O(n²) trên tối đa 5.000 entries).
- Gates: typecheck 44/44 · eslint 43/43 · turbo test 44/44 (fresh run).

### Track 3 — Feature Honesty (trung thực sản phẩm)

- **Tool catalog**: gỡ claim "200+ tools" khỏi ROADMAP; catalog được mô tả đúng là metadata-only (handler thực thi cần adapter + credentials).
- **Sandbox Dashboard**: thay dashboard luôn rỗng (poll 3s vào placeholder) bằng thẻ "Planned for v2.0" trung thực, kèm ghi chú sandbox built-in (Landlock/Seatbelt/Job Object) vẫn hoạt động.
- **Voice**: `SpeechToText` mặc định dùng Whisper API thật và **throw** khi thiếu API key — không còn chế độ fake transcript ngầm (`local-stub` chỉ chạy khi opt-in rõ ràng); package đánh dấu Incubating trong README.
- **Bluetooth**: bỏ copy sai "connect via Bluetooth directly" khỏi thông báo Cloud Discovery ở cả 6 locale; `mobile-companion.BluetoothPairing` gắn nhãn SIMULATION ONLY và từ chối pair thiết bị chưa discover.
- **Marketplace**: `PaymentGateway` gắn cờ `simulated` + cảnh báo runtime "không có tiền thật di chuyển"; supply-chain scan cảnh báo rõ khi `VT_API_KEY` được cấu hình nhưng external lookup chưa implement; `ScanCache.hitRate()` đo hit/miss thật thay vì placeholder 1/0.
- **README**: bảng Core/Product/Incubating cập nhật cho 1.1.5 với ghi chú trung thực từng package incubating (marketplace revenue simulated, voice chưa có consumer, mobile-companion là harness…).
- Gates: typecheck 44/44 · eslint 43/43 · turbo test 44/44.

### Track 2 — Bug Fixes (45 phát hiện đã xác thực)

- **Orchestration**: mailbox đạt at-least-once thật sự — `check()` chuyển sang trạng thái `in_flight` và tự redeliver sau visibility timeout 60s nếu consumer crash trước khi ack; cron scheduler không còn bắn lặp nhiều lần trong cùng một phút (dedup theo minute-key) và tái tạo interval timer sau stop/start (hết chết âm thầm); subagent timeout giờ hủy work qua AbortSignal thay vì bỏ mặc chạy tiếp; `awaitGate` có deadline 10 phút.
- **Code-graph**: LSP client frame JSON-RPC theo **byte length** (Buffer) — hết treo/mất message với văn bản Unicode; mọi request có deadline 15s; `stop()` race shutdown với 2s để server treo không kẹt vĩnh viễn.
- **AI Engine**: stream retry/fallback không còn nhân đôi phần text đã yield (phát error-chunk + partialContent); retry phân loại lỗi non-retryable (401/400/422…) + backoff nhân với jitter + tôn trọng abort signal; MCP transport hỗ trợ string JSON-RPC id (map keyed by String(id)); tool-call JSON hỏng được cảnh báo thay vì biến mất im lặng; cancel HTTP body khi consumer break sớm (`reader.cancel`); embed/image/speech/transcribe nhận `signal`; semantic cache lưu đúng finishReason.
- **UI lifecycle**: shared socket là single-instance (socket.io tự reconnect — hết hiện tượng clobber listener chéo); useChatSocket gỡ đúng listener của mình qua handler refs; Terminal không còn kill PTY khi đổi font/cwd và tự dọn Tauri listeners sau unmount; VS Code extension disconnect socket cũ trước khi connect mới và resolve khi reconnect_failed; mobile gom alert reconnect thành tối đa 1 thông báo/30s.
- **Communication**: daemon rollback các worker đã start khi start lỗi; multiplexer destroy pending socket khi connect timeout (hết kẹt trạng thái connecting); Discord clear heartbeat cũ trước HELLO thứ hai (+unref); iMessage poller có in-flight guard chống chồng vòng poll.
- **Unbounded sweep**: rate limiter quotas fail-CLOSED với limit chưa đăng ký, bucket map tự eviction, resetAt chính xác nhờ fractional carry; relay-server rate-limiter evict entry hết hạn; violationLog/PTY log giới hạn dung lượng; memory FTS deindex snapshot cũ khi save (hết từ khóa mồ côi); `retry()` dùng backoff nhân + jitter và bỏ qua lỗi non-retryable.
- Regression tests: mailbox redelivery ×3 · LSP unicode framing ×2 · cron dedup/restart ×2 · retry classification ×2. Gates: typecheck 44/44 · eslint 43/43 · turbo test 44/44.

### Track 1 — Security Hardening

- **CSP**: production `script-src 'self'` (bỏ `unsafe-inline`/`unsafe-eval`), shim chuyển ra `public/boot-shims.js`, `devCsp` riêng cho HMR; bổ sung `ipc: http://ipc.localhost`.
- **FS scope**: các lệnh ghi (`fs_write_text`/`fs_mkdir`/`fs_rename`/`fs_remove`) yêu cầu thư mục đã được cấp quyền qua native dialog (`fs_request_access`, persist `fs-scope.json`); `fs_remove` chặn drive-root/home/tổ-tiên-home; dialog duyệt lệnh hiển thị cả đầu lẫn đuôi lệnh dài; 5 unit test bảo vệ.
- **Keyring**: vault hệ điều hành là nguồn chuẩn — xóa mirror plaintext `api-config.json` khi vault ghi OK (file chỉ còn là fallback khi vault hỏng).
- **Vùng trust local**: `/health` chỉ trả pairing code/devices khi có header `x-ghita-session-token`; `approve_command`/`reject_command` chỉ desktop (thiết bị paired không thể tự duyệt); pairing PHẢI có xác nhận trên desktop (`pairing_request` → `pairing_decision`, auto-từ-chối sau 60s); khóa bind host bỏ override `GHITA_BIND_HOST`.
- **Skills**: `openApp`/`closeApp` spawn argv không shell; PolicyEnforcer match trên biến thể de-obfuscate + pattern command-substitution/iex-cradle/base64-pipe.
- **Kênh truyền**: proxy preview lọc Cookie/Authorization + hop-by-hop headers; device token mã hóa AES-256-GCM với PSK = pairing code (mobile giải mã qua `@noble/ciphers`).
- **Khác**: update yêu cầu dialog đồng ý; `terminal_create` validate shell + cwd; denylist native +10 mẫu phá hoại. Gates: cargo test 59/59 · clippy 0 · audit-security exit 0 · smoke test `/health` OK.

### Track 0 — Cleanup & Sync (chuẩn bị phát hành chính thức)

- **Comment hygiene toàn codebase**: xóa banner/kẻ bảng, tag provenance ("Phase N", "Track N", "deep review pass") và chuyển bình luận nội bộ tiếng Việt sang tiếng Anh ngắn gọn hoặc loại bỏ (~6.600 dòng) trên 977 file TS/TSX/MJS; 7 crate Rust chuyển header sang `//!` module docs chuẩn. Mật độ comment `packages/` 12% → 7.8%.
- **Khối code chết**: bỏ failover block đã vô hiệu trong `apps/mobile/src/services/socketService.ts`.
- **Suppressor discipline**: mọi `eslint-disable`/`@ts-expect-error` đều có lý do kèm theo.
- **Repo hygiene**: `.gitignore` chặn installer/binary (`*.msi *.msix *.appx *.dmg *.deb *.rpm *.AppImage *.snap`) và state AI-assistant; bỏ khỏi git tài liệu kế hoạch nội bộ, docs trùng lặp, eval report sinh tự động.
- Gates: typecheck 44/44 · eslint 43/43 · knip exit 0 · `sync-version --check` OK.

## [1.1.5-beta2] - 2026-08-22

- Beta2 build (216 files): hoàn thiện các track kế tiếp của 1.1.5, bổ sung vitest workspace config.

## [1.1.5-beta1] - 2026-08-21

### Track 1 — Sandbox & Hooks & Headless (an toàn thực thi)

- **`crates/sandbox` (T1.1)**: sandboxed spawn zero-dependency với 3 profile (`workspace`/`read-only`/`strict`), deny-glob matching (`**`/`*`/`?`), env scrub allowlist, write-target policy cho redirect, WSL1 detection. Enforcement theo OS tự degrade: **Landlock** (Linux, raw syscalls + `NO_NEW_PRIVS` trong `pre_exec`) · **Seatbelt** (macOS `sandbox-exec` SBPL sinh động) · **Supervised** (Windows: Job Object kill-on-close FFI + policy precheck; AppContainer là tier kế tiếp). Napi addon `spawnSandboxed` (feature `addon`, dyn-symbols) build + load qua `@ghita/native-bridge` OK; smoke: lệnh lành chạy exit 0, `**/*.pem` deny-glob chặn trước spawn. 7 cargo tests + landlock test trên Linux CI. Docs `docs/sandbox.md`.
- **Hooks system (T1.2)**: `HookManager` + schema `.ghita/hooks.json` v1 — 6 sự kiện (SessionStart/PreToolUse/PostToolUse/PostToolUseFailure/Stop/PreCompact), action `shell` (exit 2 hoặc JSON decision chặn — đúng contract Claude Code) / `http` webhook / `block`; depth-guard chống đệ quy (max 2), per-rule cooldown, dedup window, fail-open. Wire vào ReAct runtime ở cả 2 path `run`/`runDurable` cạnh PolicyEngine; `PreToolUse` block cho observation `Hook blocked tool …` như policy deny. Docs `docs/hooks.md`. 14 tests.
- **Headless/CI mode (T1.3)**: `runHeadless` (packages/agents) + CLI `scripts/headless.mjs` — streaming-json event stream ổn định (`session_start`→`message`/`tool_call`/`tool_result`→`turn_end`→`done`), `--tools` allowlist, `--max-turns`, `--fork-session`, `--session-id`; exit codes ngữ nghĩa **0 ok / 1 lỗi / 2 exhausted** (durable runId → `ReActIterationLimitError`). CLI dry-run scripted LLM chạy được e2e không network/API key. 5 tests.
- **Untrusted-data discipline (T1.4)**: `wrapUntrusted`/`OPERATOR_CHARTER` (`@ghita/shared`) — mọi ToolMessage vào LLM context bọc `<tool_output data-source="untrusted" origin="…">` với **anti-breakout** (escape close/open tag phía trong payload); journal `steps[]` giữ observation thô. Charter tự prepend vào system prompt (opt-out `untrustedOutput: false`). Áp ở cả `run` + `runDurable` (kể cả observation policy-deny/hook-block).
- **Exec policy (T1.5)**: `checkCommand` (`@ghita/security` governance) — parse compound command (split `&&`/`||`/`;`/`|` ngoài quote, tokenize respecting quote, binary normalize Windows path/.exe, family match `mkfs`→`mkfs.ext4`) → verdict `allow/deny/ask` với deny thắng. Default rules: **deny `git push --force`/`-f`**, ask `--force-with-lease`, deny `rm -rf`, `dd of=/dev/…`, `mkfs*`, `shutdown`, `reboot`. 12 tests.
- Gates: cargo test workspace 29/29 (thêm ghita-sandbox 7) · clippy/fmt sạch · vitest agents 149 · security 147 · shared 229 · typecheck 0 lỗi · eslint 0 lỗi mới.

## [1.1.1] - 2026-08-16

### Track 8 hoàn tất — Native Acceleration (v1.1.1)

- **Tree-sitter AST native** (`crates/codegraph/src/ast.rs` + `parseFiles` napi/rayon): parse TS/TSX/JS/MJS/CJS/Python; symbol/import/edge extraction **parity 420=420 nodes** với TS Compiler API (A/B trên repo thật, 0 lệch). **1 000 file TS: 817 → 55.6 ms (14.7×)**; 10 000 file: 624 ms (<5 s target). JS fallback giữ nguyên (`forceJs` option).
- **LCS diff-stat native** (`apps/desktop/src-tauri/src/diff.rs`): `line_diff_stat_command` async trên thread pool — hết giật UI khi AI edit file lớn (JS baseline 5k dòng **~1 453 ms** main-thread → native **300 ms** off-thread, 4.8×). Renderer: `nativeDiff.ts` → `useLineDiffStat` → `DiffStatBadge` (fallback JS).
- **Memory addon dựng được + load được**: `packages/memory/rust-napi` chuyển `dyn-symbols` (hết lỗi libnode.dll); loader `rustAddon.ts` ESM-safe (`createRequire`) + probe `../../rust-napi/index.node`; e2e HNSW/cosine/batch/decay OK, 215 tests pass.
- **Build matrix + scripts**: `scripts/build-native.mjs` (+ npm script `build:native`) build 4 addon; `.github/workflows/build-native.yml` (win/linux/mac) — tạo local, chưa activate; bench `[D] ast-parse` + `[E] diff-stat` trong `bench-cpu.mjs`/`bench-native.mjs`.
- Thay đổi đã commit/push (cd5184d); gộp vào release v1.1.5-beta1.

## [1.1.0] - 2026-08-10

### Release & Installer — Track 13/14 (2026-08-10)

- **Installer v1.1.0 Windows NSIS**: `release/GHITA-CODING-AGENT-Setup-v1.1.0.exe` (single-file, currentUser, EN+VI) + SHA-256 checksum; version/identifier đồng bộ `com.ghita.coding-agent`; profile release tối ưu (LTO thin, strip, panic-abort).
- **Release blocker CR-019 fixed**: `src/shims.ts` thiếu `PassThrough`/`spawnSync`/`createRequire`/`parseArgs` làm vỡ build desktop (trên Node 24 hiện segfault 0xC0000005) — thêm stream/child_process/module/util mocks + alias `node:module`; `vite build` desktop xanh (4596 modules).
- **Zero-warning đạt 100%**: `pnpm typecheck` (44/44) · `pnpm lint` (43/43, 78 lint vi phạm style đã sửa, 0 warning) · `pnpm knip` (exit 0) · `cargo clippy -D warnings` (desktop + 3 napi crates, dead-code napi = expected) · `cargo fmt --check` 0.
- **Zero-bug verification xanh**: `pnpm test` (44/44 tasks), cargo test (crates 12 tests + desktop — debug link chỉ ở windows-gnu), evals-gate 79/100 (≥75), e2e-smoke 4/4, desktop-smoke 4/4 (startup 1344ms), bench CPU/RAM PASS, coverage T0/T1 failures=0.
- **Updater**: workflow `release.yml` sẵn sàng (Windows/Linux/macOS/Android/iOS matrix + `updater-manifest` → `latest.json`); bản ghi ký yêu cầu `TAURI_SIGNING_PRIVATE_KEY` (CI only).
- Ghi chú: build desktop local nên dùng **Node 22** (khớp CI); Node 24 + vite 6.4.2 → segfault giả.

### Quality Gates — Track 12 (đóng vòng review-fix)

- **Bug→test gate**: `scripts/check-bug-tests.mjs` — mọi finding fixed phải có TestFile (4/4).
- **Coverage floor nâng**: security 80, ai-engine 60, agents 58, skills 55, communication 53, memory 51 — verify bằng số liệu coverage thật (`check-coverage-tiers --allow-missing`: 0 failures).
- **E2E smoke**: `scripts/e2e-smoke.mjs` — 4/4 PASS (ingest, evals, scanner, MCP interop).
- **Workflow mới**: `.github/workflows/quality-gates.yml` — nightly + PR: bug-tests + property/unit + smoke + coverage + bench CPU/RAM.

### Fixed — Track 11 (bug fix & hardening, từ deep review Track 10)

- **SSRF guard hoàn thiện + regression** (`web-fetch`): protocol allowlist, chặn private/reserved IP + cloud metadata, DNS all-records + IP pinning — 11 test mới (`web-fetch.ssrf.test.ts`).
- **Path containment hoàn thiện + regression** (`workspace-tools`): lexical + symlink-safe (realpath ancestor) — 4 test mới (`workspace-tools.security.test.ts`).
- **`LRUCache.delete()` không trừ bytes** khỏi bộ đếm `totalBytes` khi xoá entry — đã sửa + test.
- **Native secscan không hỗ trợ look-around regex** (rules JS có `(?!...)`) → addon trả lỗi rõ và engine tự **fallback JS** — scan vẫn đúng mọi rule.
- **Bug→test mapping gate**: `scripts/check-bug-tests.mjs` (mọi finding fixed phải có TestFile) ✅.
- **Property testing** (fast-check) cho splitters + tool-call repair: không throw, bất biến round-trip, deterministic coerce.
- **E2E integration smoke**: `scripts/e2e-smoke.mjs` — ingest CLI, evals suite, security scanner, MCP interop: **4/4 PASS**.

### Added — Reference-Driven Upgrade (7 tracks / 50 mục tiêu từ đối chiếu 53 dự án tham khảo)

- **Track 1 — Evals & MCP**: `@ghita/evals` (evidence-based scoring 5 chiều, CLI `evals run/compare/replay`, internal/browser/skills suites, longitudinal SQLite, CI gate `scripts/evals-gate.mjs`); `@ghita/mcp` chuẩn SDK (client stdio/SSE/HTTP, server + deny-default hooks, in-memory pair); code-graph/browser/memory/skills → MCP servers; xoá JSON-RPC tự viết; interop check `scripts/mcp-interop-check.mjs` + workflow `evals.yml`.
- **Track 2 — Skills v2**: schema v2 (`allowed-tools`, `sandbox_permissions`, `metadata.version/internal`, `license`, `sources`), v2 importer + structural contract (scripts/ ⇒ tests/), execution-boundary enforcement, Docker skill sandbox (deny-default), license engine + THIRD_PARTY_NOTICES, skill-lock v3 (folderHash), discovery 3 tầng + shadow, skill-creator eval-loop, instinct metrics, export đa-harness.
- **Track 3 — Plugins & Marketplace**: Claude plugin/marketplace import, installer (`plugins install <user>/<repo>@tag`), agent-driven `$plugin-installer` skill, catalog tiers (system/curated/experimental/quarantine), supply-chain scan (hash + heuristics → verdict), trust tiers + pin/rollback.
- **Track 4 — AI Engine & Chat**: tool-call repair, 2-phase tool approvals, adaptive bandit router (Thompson sampling), model roles (10 roles), pricing DB sync, distributed/dual-mode caches; chat stream-parts UI thật (`useAIChat`) + Workflow DAG visualizer (bỏ stub).
- **Track 5 — Agents**: HITL first-class (`request_human_input` + webhook resume), lifecycle API (launch/pause/resume/enumerate), git worktree isolation + fanout swarm, auto-commit policy, PR review pipeline 2-pass, declarative subagents, flow persistence SQLite + `withHumanFeedback`, error compaction, remote job status.
- **Track 6 — Memory & RAG**: `@ghita/ingest` (loaders md/json/csv/docx/pdf, splitters, indexer dedup + incremental, CLI `ghita-ingest`, redact secrets), engine sink → KnowledgeEngine, hybrid retriever (BM25+vector RRF, MMR, parent-doc), skill `document.ingest`, memory auto-capture hooks (dedup 5 phút), contradiction/supersede, provenance + rollback.
- **Track 7 — Terminal & Browser**: `@ghita/terminal-session` (buffer serialize/restore, flow control XOFF/XON, resize pixel), browser ActionRegistry, ActCache (SQLite, replay 0 LLM), outcome verifier + retry, network interception + HAR export, trace-light.
- Versions: toàn bộ monorepo đồng bộ `1.1.0` (56 vị trí qua `scripts/sync-version.mjs`).

## [1.0.0] - 2026-08-06

### Added — Antigravity-style agentic editing (the v1.0 centerpiece)

- **Antigravity edit-review gate**: agent file edits (`write_file` /
  `replace_file_content`) no longer write blindly. Each edit is shown to the
  user as a Monaco diff for review, and the agent **pauses** until the user
  accepts or rejects. Rejected edits return a clear refusal to the agent so it
  self-corrects instead of retrying the same change. (All permission modes
  except `auto`.)
- **Multi-file edit queue** (`EditProposalTray`): every pending AI edit across
  files is listed in one tray with per-file +/- line stats, Accept/Reject per
  file, and Accept All / Reject All. Collapsible, with a badge count.
- **Edit checkpoints + undo**: before the sidecar writes an accepted edit, the
  original file is snapshotted under `.ghita/checkpoints/<runId>/` (new files get
  a `.NEW_MARKER`), so a rejected/undone run can restore the prior state.
- **"Apply to file"** on chat code blocks: turns any AI-generated code block
  into a reviewable diff proposal instead of a blind copy/paste.
- New sidecar events: `edit_proposal`, `edit_apposal_response`, `edit_applied`.
  Extended the agent's system prompt to explain the review flow.
- Agent runs in non-`auto` permission mode now have a 10-minute overall timeout
  (vs 3 minutes) to leave the user time to review diffs.

### Added — Editor & IDE

- **Quick File Open** (`Ctrl+Shift+P` / `Ctrl+Shift+O`): VS Code-style fuzzy
  file picker over open tabs and recently-opened files (basename, acronym, and
  subsequence matching). Rehydrates evicted buffers from disk on selection.
- **Recent-files history**: the 20 most recently opened files are persisted and
  surfaced in Quick File Open.
- **Editor status bar**: live cursor position (Ln/Col), selection length, and
  word count beneath the Monaco surface.
- **Auto-save** (toggle in Settings → Performance): saves the active file 1.5s
  after the user stops typing.
- **Shortcuts overlay** (press `?`): searchable reference of every keyboard
  shortcut, grouped by General / Editor / Panels.

### Added — Chat & AI UX

- **Chat export to Markdown**: one-click download of the current conversation
  with role labels and timestamps.
- **Chat history cap** (RAM): the in-memory message list is capped at 200
  messages; older messages remain in the persistent session store.

### Added — Installation & DevEx

- **One-command setup**: `scripts/setup.ps1` (Windows) and `scripts/setup.sh`
  (Linux/macOS) check prerequisites, install deps, build all packages and the
  sidecar.
- **`pnpm doctor`**: diagnostics for Node/pnpm/Rust/toolchain, workspace state,
  disk/RAM, and the sidecar port. Used as a gate by the setup scripts.
- **Auto-save**, **Low-RAM mode**, **Performance** section in Settings.
- Rewrote README Quick Start around the one-command setup + `pnpm doctor`.

### Added — Performance & RAM (30+ techniques, highlights)

- **LRU file cache** (`O01`): `fileContentCache` is now bounded to 128 entries
  and evicts the least-recently-used files, never dropping an open tab's buffer
  (which would lose unsaved edits).
- **Low-RAM mode** (`S36`): a single toggle that disables the editor minimap,
  smooth scrolling, smooth caret animation, font ligatures, and rounded
  selections, and tightens the terminal scrollback (1000 vs 5000 lines).
- **Chat message cap** (`O02`): see Chat above.
- Terminal scrollback tightened in Low-RAM mode (`O06`).

### Changed

- All package/workspace versions synchronized to **1.0.0**.
- `package.json` gains `pnpm doctor` and `pnpm setup` scripts.
- Agent system prompt now explains the edit-review flow.

### Fixed

- `pnpm doctor` correctly detects the pinned pnpm on Windows (corepack shim).
- Editor cursor-tracking hooks moved above the diff-view early-return so React
  rules-of-hooks is satisfied (lint-clean).

## [0.8.0] - 2026-08-02

### Added

- **Native filesystem access**: new Tauri commands `fs_read_dir`, `fs_read_text`,
  `fs_write_text`, `fs_metadata`, `fs_mkdir`, `fs_remove`, `fs_rename` bypass the
  restricted `plugin-fs` scope so the editor can open/edit files in ANY folder
  (Documents/Desktop/Downloads no longer required). Encoding-aware read/write
  (UTF-8 BOM, UTF-16 LE/BE, latin-1 fallback) prevents mojibake.
- **Ctrl+N** now creates AND opens a new file in the current folder (the welcome
  hint advertised it, but the binding never existed).
- Error surfacing in the File Explorer: non-permitted/inaccessible folders now
  show a clear error toast instead of silently rendering an empty tree.

### Fixed

- **Mở / edit file không lỗi**: browser `plugin-fs` scope failures were the root
  cause of "cannot open file" — replaced with native fs commands (see Added).
- **Blank editor tabs after restart**: persisted tabs (path-only) are now
  re-hydrated from disk when focused, instead of showing empty content forever.
- **AI proposal accept discarding unsaved manual edits**: a confirmation prompt
  now guards against overwriting the user's own changes.
- **Double Ctrl+S**: Monaco's keybinding and the window-level handler both fired
  save → duplicated writes/toasts. Monaco's binding was removed; one source owns
  save/save-all.
- **New file never opening in editor** after creation.
- **DocsGriller** no longer returns an empty stub: real heuristic analysis of
  the markdown content (cross-document contradictions, Socratic questions from
  decision markers, design-decision extraction); response now uses camelCase to
  match the frontend contract.
- **Ralph self-healing** no longer uses a fake "mock compiler": generated code is
  written to a temp file and really type-checked with `tsc` (esbuild fallback).
- **Windows console windows**: sidecar spawn and approved-command spawn now use
  `CREATE_NO_WINDOW`; all remaining Node `execFileSync`/`execFile` call-sites
  (builtins, mobile-adb, docsGriller, dynamicGenerator) now pass
  `windowsHide: true`. Launching the app no longer flashes terminal windows.

### Removed (no more demo/simulated data)

- **Ecosystem view**: removed the fake gRPC/Agent-Protocol daemon cards and the
  `Math.random` log/request simulator. Replaced with the real sidecar server
  status (port, LAN addresses, version).
- **Quota view**: removed fabricated sample usage that inflated the budget gauge.
- **Monitoring view**: removed synthetic error-group naming; shows real telemetry
  only (empty until real errors occur).
- **SaaS catalog**: `loadComposioCatalog` no longer registers 150+ non-functional
  stub tools (`composio:*`) — the agent can never propose a dead integration.
- **OAuth**: `OAuthHandoffManager.handleCallback` and
  `ComposioSkillAdapter.interceptAndRefreshToken` no longer mint mock tokens;
  they surface a clear error so no connection is faked.
- **Communication channels** (Telegram/Slack/Discord/iMessage): mock-mode paths
  no longer report fake success; missing/MOCK tokens return honest failure.
- **Mobile Bluetooth pairing**: removed fabricated `VIRTUAL-01/02` devices; shows
  a truthful "Bluetooth unavailable" state.

### Performance

- Chat messages are memoized per-message (`MessageBubble`) so streaming updates
  re-render only the changed message, not the whole history.
- Polling loops (Ecosystem, Devices, Sandbox, Quota, Monitoring, MobileScreen,
  Model selector) now pause while the window is hidden / tab inactive via a new
  `useActivePolling` hook.
- `CodeEditor` dirty-check uses a cheap length comparison instead of a full
  O(n) string compare per keystroke.

### Changed

- All package/workspace versions synchronized to **0.8.0**.
- Removed dead `EditorTabBar.tsx` and `FileExplorerDirtyBadge.tsx`.

### Deep review & debug pass (post-release hardening)

#### Data-loss prevention

- **Oversized-file truncation guard**: reading a file larger than the 5 MiB cap
  now returns `isTruncated`; the editor opens it read-only and **blocks saving**
  so the truncated preview can never overwrite the original file.
- **DocsGriller symlink crash**: the recursive doc scan could stack-overflow on
  symlink cycles; now tracks visited canonical paths with a depth cap.
- **Reload-vs-typing race**: auto-reload of a rehydrated tab no longer clobbers
  keystrokes typed while the disk read was in flight.
- **Encoding-safe AI proposal accept**: when applying an AI-proposed edit to a
  file whose encoding isn't cached yet, the real on-disk encoding is resolved
  before writing (no more UTF-8-corrupting UTF-16/latin-1 files).

#### Correctness

- UTF-16 files are no longer mislabelled as "binary" — the NUL-byte sniff now
  runs on the _decoded_ text instead of the raw bytes.
- Ecosystem view clears the last-known server status on poll failure instead of
  keeping a stale green "RUNNING" while the sidecar is gone.
- Chat "scroll to bottom" is anchored to the correct container.
- `PermissionGateManager` is now fail-closed (no dialog handler ⇒ denied)
  instead of failing open.
- `composioAdapter` no longer permanently isolates an app when its token simply
  expires — credential refresh clears the isolation so a good token works.
- Telegram/Discord/Slack/WhatsApp gateways no longer report fake success in mock
  mode; missing tokens surface honest failure.

#### Performance & UX

- Removed duplicate initial poll effects (Quota, Monitoring, SandboxDashboard)
  — `useActivePolling` already fires once on mount, so views no longer double
  the first request.
- Keyboard shortcuts (Ctrl+S/W/O/N) now honor the `shortcutsEnabled` setting and
  are skipped while typing in an input/textarea/select or when the command
  palette is open.

### Removed

- **`plugin-fs` fully removed**: the Tauri `fs` plugin, its frontend package,
  its Rust registration, and all `fs:*` capabilities are gone. The native
  fs commands (added in "Added") are the single filesystem path.
- Orphan `codeView.fieldTransferred` i18n key and invalid `toast.warning` calls
  (react-hot-toast has no `warning`) replaced with the correct API.

### Fixed (found during real-machine install verification)

- **Orphaned sidecar after app death**: if the app was force-killed or crashed,
  the bundled Node sidecar survived and kept squatting on the HTTP/gRPC ports;
  the next launch could not bind and drifted to a different port. The sidecar
  is now placed in a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
  (`windows-sys`), so the kernel reaps it whenever the app process dies for ANY
  reason — no code path required. Verified live: `taskkill /F` on the app kills
  the sidecar and the next launch rebinds 8080/50051 immediately.
- **Monaco editor stuck on "Đang chuẩn bị..." spinner**: the default
  `@monaco-editor/react` loader fetches Monaco from `cdn.jsdelivr.net`. Any
  machine offline / behind a firewall / on a slow link would never finish
  loading and the user could not edit files. `monaco-editor@0.55.1` is now a
  direct dependency, and `src/lib/monaco-setup.ts` configures
  `loader.config({ monaco })` + `MonacoEnvironment.getWorker` so the editor
  runs entirely from the local bundle (5 workers bundled: editor, json, css,
  html, ts). Verified: app exe grew ~2.8 MB (the bundled Monaco ESM) and the
  editor now works offline.

### Fixed (deep review pass #2 — verified)

#### P0 (would silently break key flows)

- `capabilities/default.json` was missing `dialog:allow-message` (and
  `ask`/`confirm`). `execute_approved_command` calls `app.dialog().message`
  which the dialog plugin rejects without those permissions, so every approved
  command short-circuited to "Explicit user approval is required." Added the
  three `dialog:allow-*` permissions.
- `start_server` would set `s.starting = true` then `?`-propagate out of
  `spawn_blocking.await` on a join error, never clearing the flag. Every
  subsequent `start_server` would then early-return with "Server is already
  starting" until the app was restarted. Reset the flag explicitly on any
  join failure.

#### P1 (data-loss / correctness / security)

- `start_server` did not `try_wait()` before the `is_some()` check, so a
  silently-crashed sidecar left `s.child = Some(dead)` wedged forever. Mirrored
  the `try_wait` reap pattern from `get_server_status`.
- Frontend handlers (`handleContentChange`, `handleSave`, `handleSaveAll`,
  `useAiEditProposal.acceptProposal`, surface effect) all snapshotted
  `openFiles` from the React closure. An `onChange` arriving one tick after a
  tab close could write the closed-tab array back into the store and
  **resurrect** the closed tab. Switched every write to
  `useAppStore.getState().codeOpenFiles.map(...)` and mirrored the
  `handleSave` modified-recheck into `handleSaveAll`.
- `acceptProposal` did not guard against (a) the file being changed externally
  between proposal creation and accept, or (b) the file being a truncated
  preview > 5 MiB. Now re-reads the file before writing, aborts if it drifted
  from `originalContent`, and refuses to write when `cache.isTruncated`.
- Slack gateway was acking every envelope, training Slack to retry on
  malformed/unhandled events. `dispatchEvent` now returns `true`/`false` and
  the socket only acks envelopes whose handler actually consumed the event.
- Sidecar gRPC bind failure (ports 50051–50059 all busy) silently kept the
  sidecar running with a dead channel — every ReAct call would no-op. Now
  emits `ipcEmit('server_error', { type: 'grpcUnavailable' })` and
  `process.exit(1)` so the Tauri host can restart against a fresh port.
- `dynamicGenerator.runGit` used `execAsync(\`git add "${hubPath}/\*.json"\`)`,
which is shell-injectable if `hubPath`contains a quote. Switched to`execFile('git', [...args], { windowsHide: true })` everywhere and updated
  the test mocks.
- `runtime-security.mjs` allowed any loopback peer to authenticate as the
  desktop client when `SESSION_TOKEN` was unset. Tightened to require the
  token to match even on loopback (the Tauri host always sets a non-empty
  token).
- `imessage.ts` (macOS) lacked `windowsHide: true` for consistency with the
  rest of the codebase. Added to all three `execFileAsync` call sites.

#### P2 (perf / correctness)

- Sidecar now emits `__GHITA_IPC__:http_listening {port, ...}` right after
  `httpServer.listen` resolves. The Rust stdout reader thread updates
  `ServerState.port` so `/health` probes and `get_server_status` can't drift
  from the actual bound port (closes the `find_free_port` TOCTOU window).
- `vite.config.ts` pre-bundles `monaco-editor` and includes it in the
  `monaco-vendor` chunk to cut the dev-server cold start.
- `CodeEditor.tsx` theme is hoisted to a module-level `GHITA_DARK_THEME`
  constant and registered through `ensureGhitaDarkTheme`, so toggling
  between editor and diff mode no longer clobbers the theme with the
  less-coloured diff variant.
- `CodeEditor.tsx` diagnostics effect: dropped `value` from the deps array
  so `setModelMarkers` doesn't fire on every keystroke.
- `DocsGrillerDashboard.tsx` resolves a relative `docsPath` against the
  workspace `terminalCwd` so the Rust side never sees a path relative to an
  unrelated CWD.

## [0.7.3] - 2026-08-01

### Fixed

#### Critical / Security

- **C1**: Register missing `run_grill_session` Tauri command handler (already present in 0.7.1, verified)
- **C2**: Disable cloud discovery (`publishToCloud`) — pairing codes + LAN IP + hostname no longer leaked to public KV endpoint

#### High Priority

- **H1**: Sidecar Node process is now properly reaped on Tauri shutdown via `cleanup_before_exit`
- **H2**: Added `zsh` to the shell capability allowlist (`shell:allow-execute` in `default.json`) so `terminal_create` with `shell: 'zsh'` works correctly
- **H3**: Iframe sandbox already removed `allow-same-origin` (verified in WebViewPanel)
- **H4**: CSP already includes `https://www.google.com/s2/favicons` in `img-src` (verified in tauri.conf.json)

#### Medium Priority

- **M6**: `rateLimitCleanupInterval` is now cleared on `SIGTERM`/`SIGINT`/`exit` to prevent event loop leaks
- **M9**: Workflow dependency validation now runs at load time via `AdvancedWorkflowEngine.validate()` instead of throwing at execution time
- **M10**: IPC parse errors are now logged with `eprintln!` (already present)

#### Low Priority / Code Quality

- **L1**: Fire-and-forget `terminal_kill` IPC now logs errors via `console.warn`
- **L3**: `parseInt` calls in `ApModuleCard.tsx` and `GrpcModuleCard.tsx` now include radix `10`
- **L5**: `start_server` now polls `get_server_status` until server is ready (10s timeout) instead of hardcoded 1.5s sleep

#### UI/UX Improvements

- **Command Palette**: ArrowUp/ArrowDown now wrap around (last → first, first → last)
- **Welcome Screen**: Shows "No recent workspaces" message when workspace list is empty
- **Settings**: Added "Reset to Defaults" button that restores all settings to their default values
- **Settings**: Added Cursor Style option (Block / Underline / Bar) in Terminal Preferences
- **Chat Panel**: Added floating "Scroll to bottom" button when user has scrolled up in message list
- **Terminal**: Fire-and-forget IPC errors now logged with `console.warn`

### Changed

- Version bumped to 0.7.3 across all manifests
- Updated `default.json` capability allowlist to include `zsh`
- Added `terminalCursorStyle` to Zustand store with persistence
- Added `resetSettings` action to appStore

## [0.7.1] - 2026-08-01

### Added

- **Headless/Background Mode** — Run GHITA CODING AGENT completely without UI windows (no splash, no main window, no terminal/console)
  - CLI flag: `--headless` or `-h`
  - Environment variable: `GHITA_HEADLESS=1` or `GHITA_HEADLESS=true`
  - Sidecar server auto-starts in background (Socket.io + gRPC)
  - All backend services available: proxy, PTY terminals, computer-use, mobile pairing
  - Graceful shutdown on SIGTERM/Ctrl+C with cleanup of child processes
  - `--help` flag shows usage information

### Changed

- Default window visibility set to `false` in `tauri.conf.json` (both main and splash windows)
- Windows subsystem already set to `windows` (no console window on Windows)

## [0.7.0] - 2026-07-31

### Theme: VS Code-inspired UX

#### UI/UX

- **Activity Bar** — left-side icon-based navigation with VS Code-style indicator accent, covering Code, Search, Source Control, Run & Debug, Extensions, and Settings.
- **Command Palette** (`Ctrl+P`) — fuzzy-search quick-action palette with categorized navigation, toggle terminal/chat/sidebar commands, and keyboard-driven selection (↑↓ navigate, ↵ select, Esc close).
- **Welcome Screen** — first-launch and no-workspace screen with Open Folder button, recent-workspace list, and keyboard-shortcut cheat sheet.
- **Workspace persistence** — `activeWorkspace`, `recentWorkspaces` (top 10), and `showWelcome` flag persisted in local storage.
- **Editor preferences** — font size, word wrap, minimap, line numbers, and tab size persisted via Zustand store and applied live in Monaco editor.
- **Terminal preferences** — font size and font family persisted and applied to xterm.js instances.
- **Settings overhaul** — new Editor Configuration section (font size, word wrap, minimap, line numbers, tab size), Terminal section (font size, font family), and Keyboard Shortcuts reference section.

### Fixed

- Activity bar aligns with VS Code pattern for persistent left导航.
- Command palette integrates with existing `useAppStore` state for tab switching and panel toggles.

### Changed

- Version bumped to 0.7.0 across all manifests (`package.json`, `tauri.conf.json`, root `package.json`, `en.ts`).

## [0.6.2] - 2026-07-31

### Fixed

- Terminal no longer blank/missing on app launch — eager-loaded instead of lazy, removed `xtermReady` rendering gate.
- CSP updated: `worker-src 'self' blob: data:` and `script-src 'self' 'unsafe-inline' 'unsafe-eval'` so xterm.js workers load without requiring the sidecar to be restarted.
- Sidecar auto-restart guard resets after an update event, so API calls reconnect without a full app restart.

### Changed

- Version bumped to 0.6.2.

## [0.6.0] - 2026-07-30

### Theme: Durable, governed coding-agent runtime

#### Added

- **Durable ReAct execution**: stable run IDs, atomic checkpoints before and after tool calls, cancellation, explicit confirmation before replaying pending tools, and resume support after interruption.
- **Desktop run journal**: bounded, permission-restricted, redacted run history with list, inspect, prune, and checkpoint-resume flows.
- **Workspace memory journal**: per-workspace durable memory with credential screening, metadata redaction, explicit remember/forget tools, and bounded relevant-memory prompt injection.
- **Live code intelligence tools**: codebase indexing, symbol search, symbol context, and token-bounded PageRank repository maps, with cache invalidation after workspace mutations.
- **Runtime browser skills**: enabled browser/computer-use skills are exposed to the agent as governed tools; mutating actions remain subject to approval policy.
- **Mobile resume control**: mobile clients can inspect interrupted runs and explicitly confirm or reject replay of pending actions.
- **Native tool-call support for OpenAI-compatible, Anthropic, and Gemini providers**, including provider-neutral tool-call messages, provider-native result turns, and structured call extraction.

#### Security

- Replaced plaintext API-key persistence with the operating-system credential vault and one-time migration from legacy configuration.
- Isolated desktop session authentication from mobile pairing, hashed device tokens at rest, added one-time pairing credentials and pairing rate limits.
- Enforced deny-by-default policy decisions at the actual sidecar tool boundary.
- Removed broad Tauri shell permissions and routed approved commands through a native gate with destructive-command checks and a bounded 1-second to 5-minute timeout.
- Hardened workspace path resolution against symlink and junction escapes.
- Added SSRF protection for proxy destinations while retaining explicit loopback support for local preview.

#### Quality and accessibility

- Restored the native Rust suite to a compiling, passing state and added integration coverage for command, proxy, session-token, and timeout boundaries.
- Added focused regression suites for runtime authentication, run journals, memory journals, tool calling, policy governance, checkpoint resume, and workspace sandboxing.
- Added semantic alert dialogs and keyboard-operable chat history controls.
- Added blocking `rustfmt` and native test jobs to CI and release workflows; desktop packaging failures are no longer ignored.

---

## [0.4.9] - 2026-07-30

### Theme: Agent capability expansion + Windows/Android hardening

#### Added

- **Security scanner** (`@ghita/security`): local rule-based, fully-offline code scanner emitting findings/coverage documents with a 0–100 score.
- **Agent governance** (`@ghita/security`): deny-default `PolicyEngine` + OWASP Agentic AI Top 10 heuristic checks; wired into the ReAct agent as a pre-tool-call guard.
- **Agent Work Loop harness** (`@ghita/agents`): five-dimension / fifteen-check evaluator with evidence-bounded scoring + `scripts/blast-radius.mjs` and `scripts/mapping-gate.mjs`.
- **Instinct registry** (`@ghita/skills`): context-triggered skill auto-suggestion with priority + conflict resolution.
- **5 new dedicated AI providers**: xAI (Grok), OpenRouter, Together AI, Perplexity, Azure OpenAI — now **15 dedicated providers** total.
- **Browser act/extract/observe** (`@ghita/browser-control`): high-level AI page API with selector self-heal and zod-compatible schema extraction.
- **GUI grounding** (`@ghita/computer-use`): two-step locate→verify with retry policy; removed the mock-screenshot fallback from the production loop.
- **Repo-map ranking** (`@ghita/code-graph`): PageRank symbol ranking within a token budget.
- **Memory decay/reinforcement** (`@ghita/memory`): access-based strength with `reinforce(id)` + time decay.
- **Skill pack importer** (`@ghita/skills`): license-checked bulk SKILL.md import + curated "Community Essentials" pack.

#### Changed — Windows optimization

- Added an optimized Cargo `[profile.release]` (LTO, strip, `codegen-units=1`, `panic=abort`).
- Split Monaco and xterm into their own Vite vendor chunks for faster WebView cold start.
- Verify the SHA-256 of the bundled `node` runtime before spawn (audit M8); fall back to system `node` on mismatch.
- NSIS installer set to current-user with English/Vietnamese; added `scripts/bench-startup.mjs`.

#### Changed — Android

- Socket reconnect is now unbounded with exponential backoff + jitter (shared `computeBackoffDelay`).
- Bumped `targetSdk` to 35; declared `FOREGROUND_SERVICE(_CONNECTED_DEVICE)` and `CAMERA` permissions.
- Added shared adaptive-streaming quality selection and a QR pairing payload codec.

#### Notes

- Native Tauri plugin wiring (single-instance, tray, notification, deep-link) and Android device UI (QR camera screen, foreground-service module, biometric prompt, tablet layout) are staged behind a native build and tracked for a follow-up.

---

## [0.3.6] - Unreleased

### Theme: Production hardening

- Established `0.3.6` as the canonical version across workspace, native and packaging manifests.
- Extended integrity checks to cover Cargo, Tauri, Android, iOS, Snap and runtime constants.
- Replaced mock-only communication gateway lifecycles with real Discord, Slack and Telegram transports.
- Added bounded duplicate-event suppression and protocol tests for reconnect backoff and invalid signatures.
- Added body-size, origin, metrics-authentication and bounded rate-limit protections to the AI gateway.
- Blocked destructive commands at the Node skill adapter boundary and bounded process output.
- Replaced the mobile placeholder build with a real Metro production bundle.
- Made coverage, audit, license, documentation, Playwright and artifact-integrity checks blocking release gates.
- Release remains unpublished until every gate in `docs/release-plan-v0.3.6.md` is green.

---

## [0.2.5] - 2026-07-27

### Theme: Version Integrity + Core Hardening

- Unified version `0.2.5` across root package.json, all workspace packages, apps, manifest, docs, and security constants.
- Added regression test suites for agents core (`astLock`, `markdownGate`, `pipeline`, `subagent`, `scheduler`).
- Added security-path deny-default tests (`computer-use`, `browser-control`, `communication`).
- Quality slash: `as_any` reduced to 77 (target ≤130).
- Created release checklist (`docs/release-checklist-v0.2.5.md`).

### Security

- Security-path regression tests locked for deny-default surfaces.

### Testing

- Agents package: 15 test files, 114 tests passing.
- Security package coverage maintained ≥94%.

---

## [0.1.5] - 2026-07-23

### Theme: Trust Hardening

Integrity-first release. Prioritizes honest quality gates, core-package tests, and maintainability over new product features.

### Added

- Tiered coverage policy (`docs/coverage-policy.md`, `docs/coverage-tiers.json`) with honest floors
- Integrity scripts: `sync-version`, `check-artifacts`, `check-coverage-tiers`, `count-smells`
- CI `integrity` job (version/artifacts/smell budget) + honest coverage gate
- Core unit suites for security, agents, communication, ai-engine, memory, skills
- Security-path tests for computer-use / browser-control deny defaults
- Runnable dry-run examples: agent-workflow, browser-automation, computer-use
- Desktop maintainability split (helpers/presentational components; original UI preserved)

### Fixed

- Version drift across package.json / docs / security constants → unified `0.1.5`
- Removed tracked junk artifacts (`nul`, logs, sqlite ledgers)
- pnpm toolchain mismatch (root + CI locked to `11.5.2`)
- Desktop god-file split regressions (WebView nav, Devices server panel, Ecosystem router, agent timeline restored from original JSX)

### Changed

- Dogfood is integrity-first and enforces T0/T1 coverage summaries + floors
- Coverage no longer claims a fake global 80% floor
- Package READMEs for T0/T1 rewritten with real API/security/test docs
- README documents Core vs Incubating packages

### Security

- Expanded sanitizer / CORS / rotator / audit-runner unit coverage (~94% lines)
- Deny-by-default regression tests for destructive computer-use commands
- Pairing lockout / guardrail / SSRF helper tests for communication core

### Coverage floors (gate scope)

| Package       | Floor | Notes                                             |
| ------------- | ----: | ------------------------------------------------- |
| security      |   70% | full package                                      |
| agents        |   55% | impl surface (excludes adapters/git/types barrel) |
| communication |   50% | core surface (excludes live token adapters)       |
| ai-engine     |   45% | unit-testable core surface                        |
| memory        |   50% | impl surface                                      |
| skills        |   45% | impl surface                                      |

## [0.0.5] - 2026-07-XX

### 🎯 Theme: Stable Foundation — 44 audit fixes + 5 Q3 features

First official release. Closes all 44 findings from the codebase audit (run on 2026-06-13) and ships 5 Q3 2026 features with full UI integration.

### ✨ Added

#### 🧪 Q3 2026 features (full UI)

- **Notification System** — Bell icon in header with badge counter, dropdown panel, mark-read on open, dismiss button, OS-level notifications via Tauri `show_notification` command. Hook: `useNotifications`. Component: `NotificationTray`.
- **Monitoring Dashboard** — Real-time stats grid (total errors, error groups, active alert rules, telemetry events), top errors list from `ErrorGrouper`, telemetry log. View: `MonitoringView`. Auto-refresh every 15s.
- **Quota & Rate Limiting** — Monthly budget gauge (color-coded by usage %), rate limit cards, usage summary table, recent usage log. Persistence to `appDataDir/budget.json`. View: `QuotaView`.
- **Code Knowledge Graph** — Workspace path input, builds AST graph via `CodeKnowledgeGraph`, kind statistics, filter by name/file, results table. View: `CodeGraphView`.
- **Voice I/O (STT)** — Mic button in chat input, Web Speech API integration with graceful fallback, live interim transcript, listening indicator. Hook: `useVoiceInput`. Component: `VoiceInputButton`.

#### 🔒 Security (10 P1 fixes)

- **2.14** SSRF + DNS Rebinding — both `input-sanitizer.ts` and `communication/security.ts` now resolve DNS once, validate IP, fetch by IP with `Host` header
- **2.7** PII stream — 32-token sliding window buffer before PII regex
- **2.11** Secret rotator — rotated key now returned and stored; `getActiveKey()` exposes it
- **2.18** Daemon restart — real stop → start cycle (not just state update)
- **2.8** Stream content filter + secret detector — wired into `chatStream` middleware
- **2.10** HTTP timeout — `AbortController` cancels in-flight requests
- **2.3** Workflow setTimeout — `clearTimeout` in `finally`
- **2.4** Workflow circular false positive — `try/finally` cleans `inProgress`
- **2.5** Subagent initial sync — diff against empty parent state at version 0
- **2.6** Subagent queue — FIFO when at `maxConcurrency`

#### 🖥️ A11y + Tauri hardening (16 P2 fixes)

- **1.1, 1.2** Keyboard nav on FileExplorer, ApiManager (`role="treeitem"`, `tabIndex`, `onKeyDown` for Enter/Space)
- **1.3** `.focus-ring` global class with `!important` outline; removed `outline: 'none'` from 4 files
- **1.4** `id`/`htmlFor` pairing on ApiManager form inputs
- **1.5** Mobile touch coords: letterbox/pillarbox math in `ScreenPreview`
- **1.6** `accessibilityRole="button"` on `TouchableOpacity` in `RemoteControlScreen`
- **1.7** LocaleCode unified to `vi, en, zh, ru, ja, ko` across packages
- **1.8** Hardcoded chat strings → `t('chat.copy')` etc, all 6 locales translated
- **2.1** DebateEngine JSON: string-aware brace matching
- **2.2** Workflow deps: validation + cycle detection (Kahn's algorithm)
- **2.9** Budget persistence: `budget.json` v1 with daily/monthly reset scheduler
- **2.12** Keychain: throw on decrypt failure (no destructive clear)
- **2.13** Hardcoded keychain password: `process.env.GHITA_KEYCHAIN_PASSWORD`
- **2.15** `import crypto from 'node:crypto'` in session.ts
- **2.16** Tier 3 `get(id)`: direct SQLite ID lookup (no vector search)
- **2.17** Skill guard hash: include `index.js` content
- **2.19** Tier manager math: `+` not `-`
- **3.1** Tokio panic: `tauri::async_runtime::block_on`
- **3.2** Sidecar production path: `resource_dir()` + dev fallback
- **3.3** IPC hijacking RCE: `GHITA_SESSION_TOKEN` env, constant-time compare
- **3.4** Capabilities: `bash` + `sh` in `shell:allow-execute`
- **3.5** PTY shell: `#[cfg(target_os = "...")]` for `bash`/`zsh`/`powershell.exe`
- **3.6** UTF-8 buffer: carry incomplete bytes across reads
- **3.7** CSP: `frame-src 'self' http://localhost:* http://127.0.0.1:*`
- **3.8** Terminal session leak: `sessions.remove()` on EOF
- **3.9** Port liberation: scan free port starting from configured (no `taskkill`)

#### 📱 Android (8 P2 fixes)

- **4.1** `MainActivity.onCreate(null)` to prevent Fragment restore crash
- **4.2** Proguard `-keep class kjd.reactnative.bluetooth.** { *; }`
- **4.3** `<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />`
- **4.4** Remove duplicate `includeBuild` in `settings.gradle`
- **4.5** `Platform.Version >= 31` skips `ACCESS_FINE_LOCATION`; `android:maxSdkVersion="30"`
- **4.6** Release task detection: any of `release|bundle|assemble|install`
- **4.7** `<uses-feature android:name="android.hardware.bluetooth" android:required="false" />`
- **4.8** `cleartextTrafficPermitted="false"` in `network_security_config.xml`, debug config separate

#### 🍎 iOS Build

- iOS ad-hoc build verified on Xcode 15+ / iOS 16+ Simulator (`CODE_SIGNING_ALLOWED=NO`)
- Build artifact: `apps/mobile/ios/build/Build/Products/Debug-iphonesimulator/GhitaMobile.app`
- App Store submission deferred to 0.0.6 (requires paid Apple Developer account + TestFlight setup)

### 🔧 Changed

- iOS beta build pipeline retained (ad-hoc only, `CODE_SIGNING_ALLOWED=NO`)
- Knip + `pnpm audit` checks in CI
- All packages have `sideEffects: false` (preserved from beta)
- New `reactflow` dep added to desktop for code graph visualization

### 📊 Key Metrics

| Metric                  | v0.0.4 | v0.0.5-beta | v0.0.5                  |
| ----------------------- | ------ | ----------- | ----------------------- |
| Audit findings closed   | 0/44   | 0/44        | **44/44**               |
| Features with full UI   | 0      | 0           | **5**                   |
| Packages with tests     | 15/22  | 22/22       | 22/22                   |
| Coverage threshold avg  | ~28%   | ~35%        | ~35%+ (root ≥50%)       |
| macOS auto-updater      | ❌     | ✅          | ✅                      |
| iOS release build       | ❌     | ✅ ad-hoc   | ✅ ad-hoc               |
| IPC token enforcement   | ❌     | ❌          | **✅**                  |
| PII stream coverage     | ❌     | ❌          | **✅**                  |
| Sidecar production path | ❌     | ❌          | **✅**                  |
| Total dependencies      | 239    | ~222        | ~225 (react-flow added) |

---

## [0.0.5-beta] - 2026-06-25

### 🎯 Theme: Quality & Platform — 5 trụ cột cho beta

Giải quyết 5 điểm yếu được chẩn đoán: over-engineering risk, coverage thấp, thiếu macOS/iOS, packages chưa có test, và dependency bloat.

### ✨ Added

#### 🧪 Testing (144 tests mới)

- **browser-control**: 103 tests across 4 files — `BrowserController`, `TabManager`, `MemoryTabStorage`, `SearchEngine`, `createStealthContext`, `applyStealth`, `withStealth`, `aiClick`, `aiExtract`, `collectCandidates`, `resolveSelectorByIntent`
- **code-graph**: 28 tests — `KnowledgeGraph` (add/remove/traverse/path/cycle/JSON), `SearchEngine` (exact/prefix/substring/scope/filePrefix/minScore)
- **gui**: 37 tests — `LayoutPresetManager` (save/restore/rename/delete/persist), `ShortcutRegistry` (register/trigger/validate), `ThemeManager` (kind/accent/fontSize/cssVars), `ClipboardService`
- **monitoring**: 18 tests — `ErrorGrouper` (ingest/group/top/stats), `AlertEngine` (evaluate/threshold/cooldown/enable-disable)
- **notification**: 16 tests — `NotificationHistory` (add/markRead/unread/filter/clear), `NotificationTemplate` (variable/nested/default/escape/plural/raw)
- **quotas**: 18 tests — `RateLimiter` (check/limit/reset/peek/stats), `UsageTracker` (record/cost/pricing/query/summary)
- **voice**: 27 tests — `AudioRingBuffer` (push/read/wrap/RMS/clear), `VoiceActivityDetector` (speech-start/speech-end/silence), `TextToSpeech` + `SilentTtsProvider`

#### 🍎 Platform: macOS + iOS

- **macOS auto-updater**: `darwin-x86_64` + `darwin-aarch64` entries in `latest.json` release manifest
- **macOS sidecar path**: Fixed `node.exe` → cross-platform `node` via `std::env::consts::EXE_SUFFIX`
- **macOS shell default**: Terminal now defaults to `zsh` on macOS (default since Catalina), `bash` on Linux, `powershell.exe` on Windows
- **iOS build pipeline**: New `build-ios` job in `release.yml` — builds `.app` with `CODE_SIGNING_ALLOWED=NO` for ad-hoc distribution
- **iOS code signing script**: `scripts/ios-sign.mjs` — Debug/Release modes, automatic CocoaPods install
- **iOS CLI platform**: Added `@react-native-community/cli-platform-ios` to mobile devDependencies

#### 📦 Dependency & Build Optimization

- **Knip**: Installed `knip` for unused dependency detection, added `pnpm knip` script, `knip.json` config
- **17 unused dependencies removed**: `playwright-stealth`, `node-pty`, `debug`, `socket.io-client`, `socket.io-parser`, `lint-staged`, `clsx`, `tailwind-merge`, `sharp`, `@testing-library/user-event`, `@babel/runtime`, `@react-native/codegen`, `@react-native/community-cli-plugin`, `@react-native/gradle-plugin`, `@react-native/typescript-config`, `@testing-library/jest-native`, `@testing-library/react-native`, `react-test-renderer`
- **sideEffects: false**: Added to all 22 workspace packages for deeper tree-shaking
- **Turborepo inputs**: Added `inputs` globs to all tasks in `turbo.json` for precise cache invalidation
- **Renovate**: Major updates now require manual review (auto-merge disabled), security labels enabled

#### 🔒 CI/CD Improvements

- **Coverage gate**: Now fails hard if any package is missing `coverage-summary.json` (no more silent skips)
- **Coverage thresholds raised**: agents 0→30, ai-engine 30→40, memory 10→30, security 15→30, communication 30→35, computer-use 30→35, marketplace 30→35, skills 30→35, shared 25→30
- **New coverage thresholds**: a11y, i18n, integration, mobile-companion, relay-server, migration (20/10/20/20)
- **Mutation testing**: Expanded Stryker scope to include `browser-control`
- **Security audit**: Added `pnpm audit` + `knip` checks to CI `security-audit` job

#### 📊 Market Validation

- **Opt-in telemetry**: `UsageTelemetry` class in `packages/monitoring` — local-only, no cloud calls, tracks feature usage patterns
- **Dogfooding script**: `scripts/dogfood.mjs` — automated smoke-test of all core flows (build→lint→test→coverage→audit→knip)
- **PR checklist**: Updated `CONTRIBUTING.md` — tests pass required, new features need tests (EN + VI)

### 🔧 Changed

- `ROADMAP.md`: iOS beta marked as done in v0.0.5
- `CONTRIBUTING.md`: Enhanced PR checklist with test requirements
- `renovate.json`: Major updates restricted, security labels added

### 📊 Key Metrics

| Metric                            | v0.0.4      | v0.0.5-beta  |
| --------------------------------- | ----------- | ------------ |
| Packages có coverage output       | 12/22 (55%) | 22/22 (100%) |
| Packages có test script           | 15/22 (68%) | 22/22 (100%) |
| Packages zero test                | 7           | 0            |
| Threshold trung bình (statements) | ~28%        | ~35%         |
| Total dependencies                | 239         | ~222 (-7%)   |
| macOS auto-updater                | ❌          | ✅           |
| iOS release build                 | ❌          | ✅           |
| sideEffects tree-shaking          | 0/22        | 22/22        |
| CI coverage gate                  | Silent skip | Fail hard    |

---

## [0.0.3-beta2] - 2026-06-02

### 🏗️ Architecture

- **Monorepo**: pnpm workspaces + Turborepo with 6 packages (`ai-engine`, `agents`, `skills`, `memory`, `shared`, `communication`) and 3 apps (`desktop`, `mobile`, `vscode-extension`).
- **21-Phase Sprint Plan** completed across 5 sprints spanning Foundation → Orchestration → Discovery → Protocols → Release.

### ✨ Added

#### Sprint 1 — Foundation

- **P1: Cost Tracking & Budget** — Per-request cost logging, budget alerts, cost limit middleware (`ai-engine/src/cost/`).
- **P2: Adaptive Router** — Complexity-based model selection with provider recommendation and dynamic fallback (`ai-engine/src/router/`).
- **P3: Stealth Browser Automation** — AI browser automation (Browser Use), stealth browsing (CloakBrowser), multi-tab session management (`browser-control/src/`).
- **P4: Tool Registry & Composio** — 200+ tool integration registry, custom tool builder, Composio SaaS adapter (`ai-engine/src/tools/`).

#### Sprint 2 — Orchestration & Infrastructure

- **P5: Multi-Agent Orchestration** — ReAct runtime loop, DAG flow orchestrator, task delegation pipeline (`agents/src/react/ + flow/`).
- **P6: Sub-Agent Spawner** — Sub-agent spawning with isolated context, inter-agent communication, parent-child state sync (`agents/src/subagent/`).
- **P7: Plugin & Sandbox Hardening** — Plugin manifest + lifecycle, Docker sandbox security model, threat logging (`skills/src/plugin-system.ts`).
- **P8: Gateway Daemon & Guardrail** — Background daemon, DM pairing security, content filter & PII redaction (`communication/src/`).

#### Sprint 3 — Discovery & Evaluation

- **P9: Skill Marketplace & Auto-Create** — ClawHub-style marketplace, skill auto-create from trajectories, dynamic skill generator (`skills/src/marketplace/`).
- **P10: Model Auto-Discovery** — Auto-discovery with cache + TTL, secure key loader with redaction, provider health checks (`ai-engine/src/discovery/`).
- **P11: LLM-as-Judge Evaluator** — Rubric-based LLM evaluator, reasoning trace extraction (thinking blocks), Ralph self-correcting loop (`ai-engine/src/enterprise/`).
- **P12: Hooks Runner & Git Safety** — Pre/post hook runner, security checkers, middleware pipeline, git safety net & auto-commit (`ai-engine/src/hooks/`).

#### Sprint 4 — Protocols & Memory

- **P13: MCP Transport & Protocols** — Stdio/HTTP MCP transport, tool auto-repair gate with LLM healing, MCP server factory for filesystem/sqlite/github (`ai-engine/src/mcp/`).
- **P14: Rust Semantic Memory** — Rust FTS5 + cosine similarity addon, memory compaction & indexing, cross-session search (`memory/src/semantic/`).
- **P15: Knowledge Graph RAG** — Entity & relation extractor, knowledge graph query compiler with subgraph traversal, context-enriched prompt builder (`memory/src/knowledge/graph.ts`).
- **P16: Debate Panel & Group Protocol** — Multi-agent debate engine (Innovator/Devil's Advocate/Editor-in-Chief), group protocol, workflow step engine (`agents/src/orchestrator/`).

#### Sprint 5 — IDE, Mobile & Release

- **P17: IDE UI & Workspace** — Monaco editor integration (lazy-loaded), file explorer with dirty detection, workspace tab system (`apps/desktop/src/views/`).
- **P18: VS Code Extension Sync** — VS Code Extension WebSocket sync via Socket.io, Monaco diagnostics & Diff View, terminal integration with xterm.js + PTY (`apps/vscode-extension/`).
- **P19: Multimodal UI & Evals** — OCR + video multimodal pipeline, vision action parser (UI-TARS), visual workflow builder & evals engine (`ai-engine/src/platform/`).
- **P20: BLE Touch Remote & Release** — BLE discovery service & permissions (Android 12+), Socket.io touch event transport, screen touch coordinates mapping (`apps/mobile/src/`).
- **P21: Wrap-up & Release** — Full test verification (497/497 pass), verification report, performance audit, release notes.

### 🧪 Testing

- **37 test files** covering all 21 phases.
- **497 unit tests** — all passing.
- **100% pass rate** with zero flaky tests.
- Comprehensive mocking for React Native, Socket.io, and MCP transports.

### 📊 Key Metrics

| Metric        | Value    |
| ------------- | -------- |
| Total Phases  | 21/21 ✅ |
| Total Tasks   | 63/63 ✅ |
| Test Files    | 37       |
| Test Cases    | 497      |
| Pass Rate     | 100%     |
| Test Duration | ~15s     |

### 🔧 Dependencies

- Node.js ≥ 20.0.0
- pnpm 10.14.0
- Turborepo 2.3.0
- TypeScript 5.6.0+
- React Native 0.76.9
- Vitest 3.2.4

---

## [0.0.2] - 2025-12-01

### Added

- Initial monorepo structure with desktop and mobile apps.
- Basic AI engine with LiteLLM integration.
- Socket.io communication layer.
- Bluetooth discovery service.
- Basic skill registry.

---

## [0.0.1] - 2025-09-01

### Added

- Project inception.
- Core architecture design.
- Initial prototype.
