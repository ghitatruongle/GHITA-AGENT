# v1.2.0-demo2 — Catalog 10 điểm cải tiến (T2 / P2.1 + P2.2)

> **Trạng thái:** P2.1 ✅ · P2.2 ✅ (đo offline được 4/10 chỉ số bằng số thật) · **P2.3 ⏳ chờ owner duyệt**
> **Ngày:** 2026-09-27 · **Nhánh:** `v1.2.0-demo2` (từ `main` = `159548c`)
> **Bộ đo:** `pnpm benchmark:demo2` → `tests/demo2-baseline/baseline.ts` → ghi `docs/demo2-baseline.json`
> **License:** học pattern, tự viết lại, ghi nguồn. `claude-code` **proprietary** — ý tưởng 9, 10 tự viết từ đầu.

---

## 1. Catalog 10 điểm (2 điểm × 5 dự án)

### Điểm 1 — Tool edit dạng SEARCH/REPLACE với cascade matching

**Nguồn:** `aider` (Apache-2.0) — `aider/coders/editblock_coder.py:128-240`

Hiện GHITA **không có** đường edit dạng này (grep `search_replace|applyPatch|str_replace` trong `packages/ai-engine/src` → 0 hit). Aider thử dần từ chính xác tới mơ hồ: exact → bỏ leading-whitespace → bỏ dòng trống đầu → xử lý `...` ellipsis của GPT → fuzzy edit distance. Quan trọng hơn: khi fail, nó trả lỗi **có thể hành động** — liệt kê block nào đã pass, chỉ yêu cầu gửi lại block nào fail, kèm "did you mean" và các dòng gần nhất trong file.

**Tính năng đích:** A5 — AI edit-apply (`views/CodeView.tsx` + `hooks/useAiEditProposal`)

### Điểm 2 — Vòng verify lint→test có trần

**Nguồn:** `aider` (Apache-2.0) — `aider/coders/base_coder.py:930-943, 1597-1622`

Sau khi sửa file, chạy lint rồi test; nếu fail thì đưa output vào vòng tiếp theo, tối đa **3 lượt** (`max_reflections`). Điểm cốt lõi: hết trần thì **dừng lại hỏi người dùng**, không đoán tiếp. Lint-fixer chạy bằng một coder clone sạch để không làm nhiễu lịch sử chính.

**Tính năng đích:** A6 — Multi-file edit queue + undo (`stores/editProposalStore.ts`)

### Điểm 3 — Cache best-effort cho browser observe/act/extract

**Nguồn:** `stagehand` (MIT) — `packages/extension/services/actService.ts:233-260`, `cacheService.ts`

Cache hit → replay deterministic, **không gọi LLM**. Cache key **cố ý loại model config** khỏi key để đổi model không invalidate cache. Nguyên tắc quan trọng nhất: **mọi lỗi cache đều phải throw** để rơi về đường inference đầy đủ — đây chính là self-heal path cho selector cũ. Báo cáo token cached/uncached riêng.

Lưu ý khi thiết kế cho GHITA: prompt của `resolveSelectorByIntent` chứa **toàn bộ danh sách candidate** (`ai-browser.ts:92-100`), nên key phải gồm a11y-tree chứ không chỉ instruction.

**Tính năng đích:** D4 — Browser control (`packages/browser-control/src/stagehand.ts`)

### Điểm 4 — Đưa self-heal lên UI + telemetry

**Nguồn:** `stagehand` (MIT) — `packages/extension/services/actService.ts:347-426`

> **Hiệu chỉnh sau khi đo:** self-heal **đã tồn tại** trong GHITA. `AIPageController.act()` đã có vòng retry tối đa 2 lần (`stagehand.ts:90-127`) và đã có test (`stagehand.test.ts:80-94`). Điểm này **không phải** "bật self-heal" — mà là phần còn thiếu: `ActResult.attempts` chưa đi đâu vào UI/telemetry, trần retry cứng 2 không cấu hình được, và không có metric nào đo tỉ lệ hồi phục.

**Tính năng đích:** A30 — WebView panel (`components/WebViewPanel.tsx`)

### Điểm 5 — Content-addressed incremental indexing

**Nguồn:** `continue` (Apache-2.0) — `core/indexing/CodebaseIndexer.ts`, `FullTextSearchCodebaseIndex.ts`

`cacheKey = hash(nội dung file)`; đổi branch chỉ re-index phần thay đổi. Tách 4 loại index độc lập: CodeSnippets (tree-sitter), FullTextSearch (SQLite FTS5), Chunk, vector.

**Tính năng đích:** A24 — CodeGraph view (`views/CodeGraphView.tsx`)

### Điểm 6 — Context provider fan-out, cách ly lỗi + dedup theo vùng dòng

**Nguồn:** `continue` (Apache-2.0) — `core/context/retrieval/pipelines/`, `core/context/retrieval/util.ts`

Gọi nhiều nguồn (FTS, embeddings, git diff gần đây, file đang mở) với **try/catch riêng từng nguồn** — một nguồn chết không làm hỏng cả pipeline. Dedup chunk theo `(filepath, startLine, endLine)`.

**Tính năng đích:** D1 — Memory / RAG search + ingest (`packages/memory`, `packages/ingest`)

### Điểm 7 — Compaction thành sự kiện có thể đo

**Nguồn:** `openhands` (MIT) — `src/hooks/use-await-context-compaction.ts`

> **Hiệu chỉnh sau khi đo:** compaction của GHITA **chạy thật và giảm token tốt**. Vấn đề không nằm ở hiệu quả mà nằm ở chỗ **không ai biết nó có chạy không**: không có sự kiện nào được phát ra, không phân biệt `compacted` / `no_change` / `timeout`. Ngoài ra chiến lược mặc định `trajectory` lại là chiến lược **kém nhất** (xem bảng baseline).

OpenHands chờ event `Condensation` rồi poll `per_turn_token` cho tới khi giảm, phân 3 outcome, timeout 90s.

**Tính năng đích:** A2 — Dashboard tổng quan (`views/DashboardView.tsx`)

### Điểm 8 — MCP health 3 trạng thái + TTL

**Nguồn:** `openhands` (MIT) — `src/api/mcp-health/mcp-health-store.ts`, `probe-mcp-server-health.ts`

Trạng thái `checking | healthy | degraded | unknown`, có TTL, và **verdict cố ý không persist** — reload là mọi server về `unchecked`, vì verdict chỉ còn giá trị bằng độ mới của probe. Auth probe dùng logic 3 trị (authenticated / unauthenticated / unknown), `unknown` thì hiện form API key thay vì đoán.

**Tính năng đích:** D3 — MCP connect + tool call (`packages/mcp`)

### Điểm 9 — Completion-promise contract + event `Stop`

**Nguồn:** `claude-code` (**PROPRIETARY** — chỉ học ý tưởng, tự viết lại) — pattern từ `plugins/ralph-wiggum/hooks/stop-hook.sh`

Agent muốn kết thúc vòng lặp phải xuất marker kèm bằng chứng; hook `Stop` chặn exit nếu chưa có. Thêm event `Stop` vào `docs/hooks.md`.

**Tính năng đích:** A3 — Chat streaming (`views/CodeView.tsx`)

### Điểm 10 — Subagent evidence manifest

**Nguồn:** `claude-code` (**PROPRIETARY** — tự viết lại) — pattern từ `plugins/feature-dev/commands/feature-dev.md`

Subagent read-only bắt buộc trả về danh sách 5–10 file quan trọng; agent chính phải đọc lại file đó trước khi hành động — giảm việc tin mù và giảm sửa nhầm file.

**Tính năng đích:** A13 — Agents view (`views/AgentsView.tsx`)

---

## 2. Map 1-1 — 10 tính năng, không trùng dòng nào

| Điểm | Tính năng                    | Mã feat-matrix | Loại    |
| ---- | ---------------------------- | -------------- | ------- |
| 1    | AI edit-apply                | **A5**         | desktop |
| 2    | Multi-file edit queue + undo | **A6**         | desktop |
| 3    | Browser control              | **D4**         | engine  |
| 4    | WebView panel                | **A30**        | desktop |
| 5    | CodeGraph view               | **A24**        | desktop |
| 6    | Memory / RAG search + ingest | **D1**         | engine  |
| 7    | Dashboard tổng quan          | **A2**         | desktop |
| 8    | MCP connect + tool call      | **D3**         | engine  |
| 9    | Chat streaming               | **A3**         | desktop |
| 10   | Agents view                  | **A13**        | desktop |

Kiểm tra: 10 dòng, 10 mã khác nhau. Không đụng B1–B8 (mobile) và C1 (vscode) — 5 ứng viên không có gì để nói về mảng đó.

---

## 3. Baseline "trước" — đo thật, 2026-09-27

Nguồn: `pnpm benchmark:demo2` → `docs/demo2-baseline.json`. Đo offline, **không cần API key**.

| Điểm | Chỉ số                                         | Trước       | Loại            | Mục tiêu                             |
| ---- | ---------------------------------------------- | ----------- | --------------- | ------------------------------------ |
| 3    | Số lần gọi LLM cho **5 act() giống hệt nhau**  | **5 calls** | đo thật         | **1** (chỉ lần đầu) — giảm 80%       |
| 4    | Số lần thử khi click hỏng lần đầu              | **2**       | đo thật         | giữ 2, nhưng có metric               |
| 4    | Số lần thử khi hỏng không hồi phục được        | **2**       | đo thật         | trần **cấu hình được**               |
| 7    | Token trước compact (900 lượt)                 | **176.300** | đo thật         | —                                    |
| 7    | Giảm token — `sliding_window`                  | **57%**     | đo thật         | —                                    |
| 7    | Giảm token — `summary`                         | **99%**     | đo thật         | —                                    |
| 7    | Giảm token — `trajectory` (mặc định)           | **49%**     | đo thật         | đổi mặc định hoặc chọn theo ngữ cảnh |
| 1    | Số tool edit SEARCH/REPLACE trong ai-engine    | **0**       | _không tồn tại_ | ≥ 1                                  |
| 5    | Thời gian re-index sau đổi branch              | **0**       | _không tồn tại_ | đo được sau khi có                   |
| 8    | MTTD phát hiện MCP chết                        | **0**       | _không tồn tại_ | < 15s                                |
| 9    | Có cưỡng chếc marker `<task-done>` không       | **0**       | _không tồn tại_ | có                                   |
| 10   | Subagent có bắt buộc trả `filesToRead[]` không | **0**       | _không tồn tại_ | có                                   |

`kind: structural-absent` nghĩa là **khả năng chưa tồn tại**, KHÔNG phải đã đo được 0. Bộ đo ghi rõ để không ai tưởng đã xong.

### Kết quả đáng chú ý nhất

1. **Không có cache, 5/5 lần gọi LLM.** Một người dùng click cùng một nút 5 lần thì GHITA hỏi LLM 5 lần. Mục tiêu 1 call là rất khả thi.
2. **Chiến lược compaction mặc định là tệ nhất.** `trajectory` giảm 49%, trong khi `summary` giảm 99% — gấp đôi. Không có gì trong code giải thích tại sao chọn mặc định kém nhất.
3. **Self-heal đã có sẵn** → Điểm 4 hẹp lại thành "đưa lên UI + cho cấu hình", giảm đáng kể công việc so với dự kiến.
4. **4/10 chỉ số đo được số ngay**; 6/10 là cấu trúc chưa tồn tại, cần build mới rồi mới đo được.

---

## 4. Cái gì CHƯA đo được, và vì sao

| Cần gì                                         | Vì sao                                | Khi nào đo được                                           |
| ---------------------------------------------- | ------------------------------------- | --------------------------------------------------------- |
| Chỉ số phụ thuộc agent thật (Điểm 1, 2, 9, 10) | Cần LLM chạy tool thật rồi so kết quả | Cần API key hoặc Ollama — **quyết định của owner ở P2.3** |
| Re-index time của Điểm 5                       | Cần chạy `cargo bench` trên repo thật | T3 P3.3 khi đã có content-addressed cache                 |
| MCP MTTD của Điểm 8                            | Chưa có tầng health để đo             | T3 P3.2                                                   |

### Vấn đề chặn: `evals` tự chấm điểm cho chính nó

`packages/evals/src/runner.ts:13-20` trả về `task.fixture`; `suites.ts` viết sẵn marker `expected` vào fixture. Score vì thế gần như luôn max. **Con số "evals 79/100" trong ROADMAP không đo được gì.**

Mình **chưa** sửa ở P2.2, vì adapter thật bắt buộc cần gọi LLM — cùng một điều kiện với nhóm chỉ số đầu bảng. Thay vào đó mình dựng bộ đo riêng (`tests/demo2-baseline/`) đo được phần đo offline ngay. Việc thay `defaultAdapter` nên quyết cùng lúc ở P2.3: **có cấp API key/Ollama cho mốc demo2 hay không.**

---

## 5. Câu hỏi cho owner (P2.3)

1. **Duyệt nguyên 10 điểm**, hay muốn đổi/giảm? (Có thể đổi sang `oh-my-pi` — hash-anchored edit + LSP — nếu bạn muốn Điểm 1 mạnh hơn.)
2. **Đổi chiến lược compaction mặc định** `trajectory` → `summary` không? (49% → 99%, nhưng cần kiểm tra chất lượng nén chứ không chỉ số token.)
3. **Có cho chạy agent thật không?** Quyết định này mở ra 4 chỉ số còn lại + sửa được `evals` tự chấm. Không có nó thì demo2 chứng minh được 6/10 điểm bằng số.
4. **Có gộp mojibake 36 chỗ vào demo2 không?** (Không thuộc 5 dự án nên chưa có trong catalog.)

---

## Bằng chứng

| File                                    | Nội dung                         |
| --------------------------------------- | -------------------------------- |
| `docs/plans/2026-09-27-v1.2.0-demo2.md` | Plan chi tiết 4 track / 19 phase |
| `tests/demo2-baseline/baseline.ts`      | Bộ đo, chạy offline              |
| `docs/demo2-baseline.json`              | 14 chỉ số kèm ghi chú từng cái   |
| `pnpm benchmark:demo2`                  | Lệnh chạy lại                    |

---

## 6. Kết quả T3 (2026-09-27) — trước / sau

Đo bằng `pnpm benchmark:demo2`. Mọi gate xanh: `turbo test` 13/13 task.

| Điểm   | Chỉ số                                       | Trước                    | Sau                                       | Kết quả       |
| ------ | -------------------------------------------- | ------------------------ | ----------------------------------------- | ------------- |
| **1**  | Tỉ lệ khớp cascade trên 5 tình huống thực tế | 40% (chỉ khớp chính xác) | **100%**                                  | ✅ đạt        |
| **1**  | File còn nguyên khi còn khối hỏng            | không có khái niệm       | **1 (có)**                                | ✅ đạt        |
| **3**  | Số lần gọi LLM cho 5 `act()` giống hệt       | 5                        | **1**                                     | ✅ đạt (−80%) |
| **4**  | `attempts` đi đâu?                           | không đi đâu             | qua `ctx.onMetric`                        | ✅ đạt        |
| **4**  | Trần retry                                   | cứng 2                   | cấu hình được                             | ✅ đạt        |
| **7**  | Sự kiện compaction                           | không có                 | `CompactionMonitor` 4 outcome             | ✅ đạt        |
| **8**  | Tầng MCP health                              | không có                 | 4 trạng thái + TTL, verdict không persist | ✅ đạt        |
| **9**  | Cổng chặn hoàn thành                         | không có                 | `CompletionGate`, trần 3 rồi dừng hỏi     | ✅ đạt        |
| **10** | Bản kê subagent                              | không có                 | `EvidenceManifest` + đo tỉ lệ sửa nhầm    | ✅ đạt        |
| **2**  | Dừng hỏi người dùng khi hết lượt thử         | không hề kiểm tra        | **có** (trần 3 lượt)                      | ✅ đạt        |
| **5**  | Re-index khi đổi 95/200 file                 | dựng lại toàn bộ kho     | **chỉ 95/200 file**                       | ✅ đạt        |
| **6**  | Nguồn context còn sống khi 1 nguồn chết      | mất sạch nếu chung try   | **2/3 còn sống**                          | ✅ đạt        |
| **6**  | Dedup theo vùng dòng                         | không có                 | 2 chunk trùng → 1                         | ✅ đạt        |

### Phát hiện quan trọng: đừng đổi chiến lược compaction

Đo trên transcript 198.690 token có đường dẫn và tên hàm thật:

| Chiến lược                  | Giảm token | **Retention** (giữ lại đường dẫn/tên hàm) |
| --------------------------- | ---------- | ----------------------------------------- |
| `summary`                   | 99%        | **0,8%**                                  |
| `sliding_window`            | 61%        | 38,6%                                     |
| **`trajectory` (mặc định)** | 54%        | **77,4%**                                 |

Nhìn số token thì `summary` thắng áp đảo. Nhưng nó **giữ lại 0,8% thông tin then chốt** — đường dẫn file và tên hàm biến mất gần hết. Agent sau đó sẽ không biết đang sửa cái gì, và lỗi đó hiện ra âm thầm, rất khó phát hiện.

Chiến lược mặc định hiện tại (`trajectory`) giữ 77,4% — rõ ràng là cân bằng tốt nhất. **Quyết định của owner "rủi ro thấp nhất" là đúng: giữ nguyên mặc định, chỉ thêm sự kiện để đo.**

Bài học rút ra: chỉ số "giảm token" một mình là chỉ số **nguy hiểm** — nó thưởng cho hành vi ném bỏ thông tin. Mọi tối ưu sau này phải đi kèm một chỉ số chất lượng.

### Bài học từ chính quá trình đo

Lần đầu đo retention ra **100% cho cả 3 chiến lược** — tưởng là tốt. Hoá ra là vì transcript mô phỏng không chứa đường dẫn hay tên hàm nào, nên không có gì để mất. Một phép đo vô nghĩa cho kết quả vô nghĩa. Phải sửa transcript cho có nội dung thật mới lộ ra kết luận ở trên.

---

## 7. Ghi chú về Điểm 5 (Rust)

`crates/retrieval/src/incremental.rs` — std-only, **không thêm dependency nào**
(dùng `DefaultHasher` của std), nên `cargo test` vẫn chạy offline như trước.

Cơ chế: cache `path -> Vec<chunk>` từ lần index trước. File không đổi thì lấy
lại chunk đã cắt, không tốn công cắt lại lẫn tokenize lại.

Kiểm chứng (`branch_switch_reindexes_only_the_difference`): đổi branch làm
**95/200 file đổi** → 95 file modified, 105 file unchanged, tỉ lệ chunk phải
dựng lại **< 0,55**. Trước demo2, `BM25Index::build()` luôn nhận toàn bộ chunk
nên tỉ lệ đó là 1,0 — tức là tốn công gấp đôi.

`cargo test -p ghita-retrieval` → 39/39 xanh · `cargo fmt --check` sạch ·
`cargo clippy` không có cảnh báo nào trong `incremental.rs`.

**Lưu ý về clippy:** `cargo clippy --all-features` báo 8 cảnh báo, **tất cả nằm
trong `napi.rs`** — code của demo1, không phải của demo2. Cụ thể là
`manual_is_multiple_of`, mới sinh ra từ toolchain `cargo 1.98.0` trên máy này.
Nên xử riêng ở mốc sau, không gộp vào demo2.

Một lần lỗi đáng ghi lại: `cargo fmt -p ghita-retrieval` định dạng **cả crate**,
vô tình sửa luôn `napi.rs` của demo1. Đã hoàn nguyên bằng `git checkout --`.
Lần sau chạy `cargo fmt` nên giới hạn đúng file cần thi.

---

## 8. Vòng review + debug (2026-09-27) — 9 lỗi tìm được, đã sửa hết

Đợt demo1 đã chứng minh một điều: **test xanh không có nghĩa là không có bug**. Lần này viết bộ test đối kháng riêng (38 test, `tests/demo2-adversarial/`) cố làm hỏng từng module, cộng một lượt rà soát độc lập cho phần Rust + script.

### Lỗi TypeScript (5)

| Mã      | Vấn đề                                                        | Hệ quả                                                         |
| ------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| BUG-001 | `search: ''` khớp ở **mọi vị trí**                            | Model sinh ra thẻ bị cắt cụt là lệnh ghi bậy nội dung vào file |
| BUG-002 | `expandToWholeLines` cắt khoảng trắng cuối, nuốt mất `\n`     | Xoá một dòng thì để lại **dòng trống**                         |
| BUG-003 | `searchReplaceBatch` ném thẳng lỗi sandbox ra ngoài           | Agent nhận exception thay vì thông điệp gọn để tự sửa          |
| BUG-004 | `detectFalseDone` bỏ sót câu có emoji đứng đầu                | `🎉 Xong!` không bị chặn                                       |
| BUG-005 | `CompletionGate` trả `'abort'`, `VerifyLoop` trả `'escalate'` | Hai module cùng nghĩa, hai tên khác nhau                       |

### Lỗi Rust — nghiêm trọng nhất (1)

**BUG-006: "incremental" không tăng tốc gì cả.** Doc comment khẳng định _"không tốn công cắt lại lẫn tokenize lại"_, nhưng `reindex()` gọi `BM25Index::build()` với **toàn bộ** chunk, mà `build` tokenize lại 100%. Cache chỉ giữ text thô, nên phần tiết kiệm duy nhất là `split_demo` — gần như miễn phí.

Đo được trước khi sửa (400 file, `--release`):

| Tình huống       | Thời gian | `reindex_ratio` |
| ---------------- | --------- | --------------- |
| 1/400 file đổi   | 8163 µs   | 0,0020          |
| 400/400 file đổi | 7138 µs   | 0,9975          |

**Tỉ lệ giảm 499 lần mà thời gian không giảm** — thậm chí chậm hơn. Test chỉ assert trên `reindex_ratio` nên vẫn xanh. Đây là loại lỗi tệ nhất: **số liệu đẹp, sự thật thì không**.

**Cách sửa:** cache dạng **đã tokenize** (`path -> Vec<(HashMap<String,u32>, len)>`) thay vì text thô; tách `BM25Index::from_token_counts()` khỏi `build()` để tái dùng kết quả tokenize của file không đổi. Đo lại sau khi sửa:

| Tình huống               | Thời gian   | Chunk tokenize lại |
| ------------------------ | ----------- | ------------------ |
| Dựng lạnh (400 file mới) | **34,3 ms** | 5090               |
| Đổi 1/400 file           | **7,8 ms**  | **7**              |
| Đổi 200/400 file         | 12,7 ms     | 1400               |

Đổi một file nhanh gấp **4,4 lần**, khối lượng tokenize giảm **727 lần**. Chạy lại bằng:
`cargo run --release -p ghita-retrieval --example bench_incremental`.

### Lỗi Rust — trung bình (3)

| Mã      | Vấn đề                                                                | Cách sửa                                                                           |
| ------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| BUG-007 | `k1`/`b` bị bỏ qua khi nội dung không đổi                             | So tham số, khác thì dựng lại — trước đó đổi tham số bị **bỏ qua vĩnh viễn**       |
| BUG-008 | `plan()` trả vector không có thứ tự ổn định (HashMap seed ngẫu nhiên) | `sort()` cả 4 danh sách — trước đó `PartialEq` vô nghĩa, log/JSON đổi mỗi lần chạy |
| BUG-009 | `plan()` hash lại toàn bộ kho **hai lần**                             | Tính một lần, cộng trong cùng vòng                                                 |

Ngoài ra: `ReindexReport.index_size` thực chất là **số từ khoá** chứ không phải số chunk (BM25Index::size() trả số term) — đã đổi tên thành `indexed_terms` và thêm `chunk_count` riêng, vì đặt cạnh `total_chunks` rất dễ so nhầm.

### Lỗi script + bộ đo (5)

| Mã      | Vấn đề                                                                                                      | Cách sửa                                                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| BUG-010 | `fix-mojibake.mjs` **sửa nhầm file sạch, không cảnh báo**                                                   | Chỉ sửa đoạn trông như mojibake: ký tự dẫn đầu **và** ký tự kế nằm trong 0x80–0xBF. `É©` (tiếng Pháp) và `Ärger` (tiếng Đức) giờ được giữ nguyên |
| BUG-011 | Script ghi đè không có bản lưu                                                                              | `--write` luôn tạo `.bak`; mặc định chỉ xem                                                                                                      |
| BUG-012 | `hasControl` bỏ sót vùng C1 (0x80–0x9F)                                                                     | Thêm khoảng C1 — claim "không có ký tự điều khiển" trước đó là sai                                                                               |
| BUG-013 | `B3c.bestStrategy` chọn theo **số token thấp nhất** — đúng cái tiêu chí mà chính file cảnh báo là nguy hiểm | Loại chiến lược có retention < 50% trước, rồi mới ưu tiên giữ thông tin. Kết quả đổi từ `summary` (0,8%) sang `trajectory` (77,4%)               |
| BUG-014 | `B10b` không phân biệt "từ chối vì khối hỏng" với "sandbox hỏng"                                            | Kiểm `outcome === 'partial' && applied === 1 && failed === 1`                                                                                    |

Ngoài ra: `baseline.ts` có 5 lỗi kiểu (union `kind` thiếu `'implemented'`) **mà CI không bắt được** vì không có root tsconfig phủ `tests/`; `main()` được gọi giữa file dù tham chiếu hằng khai báo phía dưới (chạy được nhờ `await` đầu tiên treo đủ lâu — xoá await là `ReferenceError`); `delete globalThis.ghitaWorkspaceRoot` xoá mất giá trị nếu môi trường vốn có.

### Phát hiện thêm: Điểm 3 có bản trùng chức năng

`packages/browser-control/src/track7/act-cache.ts` (179 dòng) **đã tồn tại từ trước**, cache hành động trình duyệt theo đúng pattern Stagehand mà Điểm 3 nhắm tới — SQLite, TTL, khoá theo `intent + url + domSignature`, SHA-256. Đáng tiếc nó **không được nối vào đâu cả** (chỉ tự tham chiếu trong `track7/`), còn `AIPageCache` mới thì đã nối vào `AIPageController.act()`.

Hai bản nên gộp ở mốc sau. Trong lúc đó `AIPageCache` đã được nâng lên dùng **SHA-256 từ `node:crypto`** thay cho hash 64-bit tự chế — vì với cache hành động trình duyệt, **va chạm hash không chỉ làm hỏng cache mà còn trả về selector của trang khác, tức là click nhầm phần tử**.

### Cách kiểm chứng bản vá mojibake

Sợ nhất khi sửa hàng loạt là làm hỏng chuỗi đang đúng. Đã kiểm ba tầng:

1. Chạy lại hàm repair trên bản GỐC lấy từ git → kết quả **khớp tuyệt đối** với file hiện tại (sau khi chuẩn hoá CRLF).
2. Chạy hai lần liên tiếp → lần thứ hai sửa 0 đoạn, tức **idempotent**.
3. So từng dòng đã đổi: 42 dòng, **không còn ký tự điều khiển C0/C1**; 17 dòng có ký tự ngoài BMP đều là em-dash và emoji — tức là chữ thật, không phải hư hại.

---

## 9. Vòng review mở rộng ra toàn repo (2026-09-27) — 29 lỗi nữa, đã sửa 13

Đợt trước rà phần demo2 mới viết. Đợt này mở rộng ra những nơi đã biết là yếu
nhưng chưa từng được soi: **9.700 dòng `packages/agents` không ai gọi**, các view
"có vỏ không ruột", hai cache trình duyệt, và 8 cảnh báo clippy bị trì hoãn.

Cách làm: hai lượt rà độc lập chạy test tạm để **chứng minh** từng lỗi, cộng bộ
test đối kháng tự viết. Kết quả **29 lỗi thật**, sửa được 13 cái nặng nhất ngay.

### Đã sửa — `packages/agents` (9 lỗi)

| Mã      | Lỗi                                                                                                                                     | Hệ quả nếu để nguyên                                                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BUG-015 | `checker/markdownGate.ts` — glob `**` bị thay **hai lần**: chuỗi thay thế `(?:.*/)?` chứa ký tự `*` nên bị lượt sau cắn, thành `.[^/]*` | `**/*.md` chỉ khớp tối đa 1 cấp thư mục → **bỏ sót mọi file markdown từ độ sâu 2 trở lên**, và không loại trừ được `dist/**` ở độ sâu con → quét nhầm file build     |
| BUG-016 | `mailbox/store.ts` — `enforceInboxCap` xoá `mailbox_messages` nhưng không xoá `mailbox_deliveries`                                      | Schema bật `foreign_keys = ON` → ném `FOREIGN KEY constraint failed`, **`send()` thứ tư ném exception và rollback: mất tin nhắn**                                    |
| BUG-017 | `flow/flow.ts` — `chunkArray` với `maxConcurrency = 0` → `i += 0` không bao giờ tăng                                                    | **Vòng lặp vô tận nuốt CPU**, làm OOM worker Node                                                                                                                    |
| BUG-018 | `git/workflow.ts` — `sleep(backoff)` **không được `await`**                                                                             | 5 lần retry chạy liền trong 24 ms thay vì 1,5 s — đúng cái race giữa các agent mà module này sinh ra để chống lại, bị vô hiệu hoá                                    |
| BUG-019 | `middleware/context-middleware.ts` — PII redaction dựng lại message bằng `new Ctor(redacted, { metadata })`                             | Chỉ cần MỘT email trong nội dung assistant là **toàn bộ `toolCalls` bị xoá** — vòng tool-calling gãy                                                                 |
| BUG-020 | `flow/flow.ts` — timer timeout của step không được huỷ                                                                                  | Process "xong việc" nhưng bị giữ thêm đúng bằng `step.timeout`. `workflow-advanced.ts` đã vá đúng chỗ này (có comment "audit fix 2.3") nhưng bản ở `flow` thì bỏ sót |
| BUG-021 | `flow/flow.ts` — `retries = attempt + 1`                                                                                                | `maxRetries: 0` vẫn báo `retries: 1` — số liệu retry sai, mọi dashboard dựa trên nó sai theo                                                                         |
| BUG-022 | `subagent/channel.ts` — reply đến sớm thì `clearTimeout(timer)` chạy trước khi `timer` được gán                                         | Sau khi `request()` ĐÃ trả về thành công vẫn còn timer 30 s treo, giữ process sống                                                                                   |
| BUG-023 | `storage/filesystem.ts` — key sanitize thay ký tự lạ bằng `_`                                                                           | `user/name` và `user.name` cùng ra `user_name` → **hai key khác nhau ghi đè lên nhau, mất dữ liệu âm thầm**; `keys()` trả tên đã sanitize nên `clear()` xoá hụt      |
| BUG-024 | `instincts/instinct-engine.ts` — `Makefile` (không có dấu chấm) sinh extension giả `.makefile`                                          | Rule khai báo trùng tên file kích hoạt oan (`Dockerfile` → `.dockerfile`)                                                                                            |
| BUG-025 | `harness/work-loop.ts` — `checkToDimension` throw với check id lạ, được gọi trong `.filter()` cho mọi finding × dimension               | Một finding dữ liệu bẩn làm hỏng toàn bộ quá trình đánh giá — **mất sạch báo cáo review của phiên đó**                                                               |
| BUG-026 | `subagent/sync.ts` — `snapshot()` cắt lịch sử rồi mới tìm snapshot trước đó → không thấy                                                | `syncToParent` âm thầm trả `null`, parent không nhận được gì sau lần đầu                                                                                             |
| BUG-027 | `flow/flow.ts` — `plan()` duyệt `HashMap` không sort                                                                                    | Output log/JSON đổi mỗi lần chạy; `PartialEq` trên plan vô nghĩa                                                                                                     |

### Đã sửa — UI (4 lỗi người dùng thấy ngay)

| Mã      | Lỗi                                                                                           | Hệ quả                                                                                                          |
| ------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| BUG-028 | `useChatSocket.ts` — `used` bị chặn ở 128000 nhưng `percentage` tính từ giá trị **chưa chặn** | Vượt ngưỡng thì Dashboard hiện đồng thời "128000/128000" (=100%) và **"156%"**                                  |
| BUG-029 | `useChatSocket.ts` — `chat_done` dùng `.map` chỉ đổi placeholder                              | Nếu placeholder đã bị `chat_error` xoá thì `.map` là no-op → **nội dung trả về biến mất không dấu vết**         |
| BUG-030 | `MarketplaceView.tsx` — id hardcode dùng `-` còn catalog dùng `.`                             | Dedup khớp **0/6** → MỌI plugin hiện 2 thẻ, cài bản này bản kia vẫn hiện nút "Cài đặt"                          |
| BUG-031 | `QuotaView.tsx` — `summary: [summary]` bọc object vào mảng                                    | `summary.length` luôn = 1 → nhánh "chưa có dữ liệu" không bao giờ chạy, người dùng luôn thấy một dòng toàn số 0 |
| BUG-032 | `CodeGraphView.tsx` — graph là singleton, `discoverAndIndex` không `clear()`                  | Đổi workspace từ A sang B: kết quả gồm node của **cả hai repo**, còn `totalFiles` chỉ đếm repo mới              |
| BUG-033 | `WorkflowView.tsx` — kéo node không trừ `scrollLeft/scrollTop` của canvas `overflow-auto`     | Cuộn xa rồi kéo: node nhảy ngược về góc trái, lệch đúng bằng phần đã cuộn                                       |
| BUG-034 | `WorkflowView.tsx` — `handleConnect` chỉ chặn tự vòng, không kiểm tra tổ tiên                 | Cho phép tạo chu trình → `Flow.runDAG` ném `Circular dependency detected` lúc chạy                              |

### Đã sửa — hạ tầng đo lường (2)

- **BUG-035**: `tests/` ở gốc **không bao giờ được typecheck** — `turbo typecheck` chỉ chạy script của từng package, mà script đó chỉ soi `src/`. Đã thêm `tsconfig.json` gốc + turbo task `quality:tests`, nối vào `pnpm typecheck` và `dogfood`.
- **BUG-036**: 8 cảnh báo clippy trong `napi.rs`. Chỉ **1** là lint thật (`manual_is_multiple_of`); 7 cảnh báo còn lại là **cảnh báo giả** — các hàm đều có `#[napi]` nên đã được đăng ký sang JS, phân tích dead-code của clippy không nhìn thấy mã sinh ra. Đã sửa lint thật và ghi chú lý do cho `#[allow(dead_code)]` thay vì 7 dòng rải rác.

### Phát hiện lớn nhất: addon Rust chưa bao giờ được JS nạp

`packages/native-bridge` cung cấp `loadNative(name)`, nhưng `grep` toàn repo chỉ ra
**đúng một** call site — `loadNative('tokenizer')` trong `token-counter.ts`. Nghĩa là
toàn bộ addon `retrieval` (BM25, RRF fusion, vector search, splitter) **chưa bao giờ
được nạp**: JS fallback luôn chạy. Đi kèm với BUG-006 ("incremental" không tăng tốc),
điều này cho thấy phần Rust hoá hiện tại chủ yếu nằm im — có công sức port nhưng
không có đường dẫn chạy thật.

### Còn lại — đã ghi nhận, chưa sửa (16)

Số còn lại đều đã xác minh là lỗi thật nhưng hoặc là **cần quyết định sản phẩm**
(workflow không lưu — nên nối backend hay gỡ tab khỏi UI? cài marketplace nên tải
code thật hay ghi nhãn "manifest-only"?), hoặc là **code chết chưa ai gọi**
(`ActCache.invalidate()` là no-op, `MonitoringView` không thể có dữ liệu vì không ai
`track()`). Xoá hay nối thì cần owner quyết, không phải lỗi sửa tay được.

Ngoài ra `tsconfig.tests-full.json` ghi lại **103 lỗi type trong `tests/`** — phần
lớn là API drift: test tham chiếu tới thứ không tồn tại
(`PROTOCOL_EVENT.APPROVAL_RESPONSE`, `CommunicationGateway.simulateMessage`,
`SkillInvocation.args`). Ba cái đầu đáng chú ý vì chúng cho thấy **luồng approval
hiện KHÔNG được kiểm chứng gì**.
