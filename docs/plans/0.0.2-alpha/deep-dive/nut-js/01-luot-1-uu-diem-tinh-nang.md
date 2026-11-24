# nut-js — Lượt 1: Tổng quan, tính năng & ưu điểm áp dụng

> **Dự án:** nut-tree/nut.js v4.2.0 (commit cuối 01/05/2024) — library desktop automation đa nền tảng cho Node.js · **Apache-2.0** (6/6 package — không phải MIT) · TS ~11k dòng; native addon `@nut-tree/libnut-*` 2.7.1 là binary prebuilt nằm ngoài repo (libnut-core) · clone: `refer_project/desktop/nut-js`
> **Phương pháp:** 2 subagent khảo sát song song 22/11/2026, chỉ đọc mã nguồn. Subagent 1 = tổng quan & tính năng; Subagent 2 = ưu điểm & áp dụng vào Ghita.

## Tóm tắt nhanh (tổng hợp)

- Monorepo pnpm: `core/*` (nut.js, provider-interfaces, shared, configs) + `providers/*` (libnut, clipboardy) + examples + e2e Electron/Playwright.
- Tính năng đủ: mouse (move theo path + easing, drag, scroll 4 chiều), keyboard (105 phím + multimedia, hotkey), screen.find thống nhất 5 loại needle (ảnh, text OCR, window title, màu RGBA, GUI element), window management, clipboard, Jest matchers.
- Kiến trúc provider: 15 interface + registry + env var tắt default provider; OCR và image-finder là **plugin trả phí ngoài repo** (`@nut-tree/plugin-ocr` closed $35/tháng).
- **Kết luận cho Ghita:** KHÔNG dùng làm dependency (runtime Tauri mismatch + npm prebuilt đã rút khỏi registry công cộng — cần subscription); nên **port 5 pattern** vào `packages/computer-use` (registry probe/fallback, validateSearchRegion + waitFor AbortSignal, window clamp cho maximized, Bresenham+easing smooth move, MatchRequest/providerData generic) — bổ trợ layer giữa cho enigo/device_query ở Rust.
- License sạch Apache-2.0 nhưng giá trị thực nằm ở libnut-core (repo khác) và plugin closed — repo này chỉ đáng học thiết kế.

---

# nut-js — Subagent 1: Tổng quan & tính năng

> Repo khảo sát: `D:\GHITA AGENT\refer_project\desktop\nut-js` (clone nut-tree/nut.js, HEAD detached tại tag **v4.2.0**, commit cuối `e413fa1` ngày 2024-05-01 — clone nông, chỉ 1 commit local; tags còn: v3.1.2 → v4.2.0).

## 1. Dự án là gì

- **nut.js (Native UI Toolkit)** là thư viện **automation desktop đa nền tảng** (Windows / macOS / Linux-X11) cho Node.js: điều khiển chuột, bàn phím, đọc màn hình, tìm kiếm trên màn hình theo ảnh/text/màu, quản lý cửa sổ và clipboard (`README.md:21-27`).
- **Vấn đề giải quyết**: tự động hóa/test UI native (ngoài trình duyệt) — tương đương AutoHotkey/PyAutoGUI nhưng bằng TypeScript, điểm khác biệt là "navigate screen based on image matching" (`README.md:26-27`).
- **Ai dùng**: dev viết test E2E desktop (Jest), bot RPA/script automation, ứng dụng Electron cần điều khiển máy. Tác giả: dry Software UG (haftungsbeschränkt) — `core/nut.js/package.json:6-10`.
- **Mô hình sử dụng**: thuần **library** (không CLI). Import singleton dùng ngay: `const { mouse, keyboard, screen, clipboard } = require("@nut-tree/nut-js")`. Cài qua `npm i @nut-tree/nut-js` (bản prebuilt trả phí) hoặc **tự build từ source** (miễn phí) — `README.md` mục "The Price of Open Source" + "Installation".
- **Monorepo pnpm** (`package.json:1-19`, `pnpm-workspace.yaml`), 4 nhóm workspace:
  - `core/`: `nut.js` (package chính `@nut-tree/nut-js` 4.2.0), `provider-interfaces` (`@nut-tree/provider-interfaces`), `shared` (`@nut-tree/shared` — enum/objects/types chung), `configs` (tsconfig/jest dùng chung).
  - `providers/`: `libnut` (`@nut-tree/libnut` — meta-package native), `clipboardy` (`@nut-tree/default-clipboard-provider`).
  - `examples/`: keyboard-test, mouse-test, screen-test, jest-test, typescript-test.
  - `e2e/`: `window-test` — app Electron test bằng Playwright (`e2e/window-test/main.js`, `test.spec.js`).

## 2. Kho tính năng đầy đủ (theo chủ đề)

### 2.1 Mouse (`core/nut.js/lib/mouse.class.ts`)

- `setPosition`, `getPosition` (:44, :67); `move(path: Point[])` di chuyển theo **đường path nhiều điểm** (:82).
- Click: `leftClick`, `rightClick` (:117, :124), `click(Button)` (:266), `doubleClick(Button)` (:285), giữ/nhả nút `pressButton`/`releaseButton` (:228, :247) → cho phép tự compose click giữ.
- `drag(path)` kéo-thả (:209); scroll 4 chiều `scrollDown/Up/Left/Right(amount)` (:133-190).
- Config: `autoDelayMs: 100`, `mouseSpeed: 1000 px/s` (:25-28).
- **Movement API** (`lib/movement.function.ts`): builder path `straightTo(point)`, `up/down/left/right(px)` tính từ vị trí hiện tại (:8-39); **easing pluggable** qua `EasingFunction` + mặc định `linear` (`lib/mouse-movement.function.ts:6-33`); đường thẳng nội suy bằng Bresenham (`lib/util/bresenham.class.ts`).

### 2.2 Keyboard (`core/nut.js/lib/keyboard.class.ts`)

- `type(...string|Key)` gõ chuỗi hoặc phím (:54); `pressKey(...keys)` / `releaseKey(...keys)` (:91, :115) → **hotkey tổ hợp** (press rồi release).
- Config `autoDelayMs: 300` (:28).
- `Key` enum chuẩn **105 phím US** + phím số, NumPad, điều hướng + **multimedia keys** (AudioMute, AudioVolUp, AudioPlay, AudioPrev…) (`core/shared/lib/enums/key.enum.ts`, ~155 dòng enum, Audio* tại :144-155).

### 2.3 Screen (`core/nut.js/lib/screen.class.ts`) — trung tâm của thư viện

- Kích thước: `width()`, `height()` (:146, :156).
- **Tìm kiếm thống nhất `find()` / `findAll()`** đa loại needle qua overload (:166-333): ảnh template, `singleWord`/`textLine` (text/OCR), `windowWithTitle`, `pixelWithColor` (tìm pixel theo màu RGBA), `WindowElementQuery` (element trong cửa sổ) — các query type định nghĩa tại `core/shared/lib/objects/query.class.ts:5-37`.
- `waitFor(needle, timeoutMs=5000, updateInterval=500, params)` poll có **AbortSignal** (:521-560, `core/shared/lib/objects/optionalsearchparameters.class.ts:16-19`).
- **Find hooks `on(needle, callback)`** — đăng ký callback kích hoạt khi needle xuất hiện (:576-604).
- Ảnh: `capture(fileName, fileFormat PNG/JPEG...)` (:607), `grab()` trả Image in-memory (:642), `captureRegion`/`grabRegion` (:661, :708); `fetchFromUrl(url)` load ảnh từ URL (`lib/imageResources.function.ts:21`); `imageResource(fileName)` nạp template từ resourceDirectory.
- `colorAt(point)` đọc màu pixel (:734); `highlight(region)` vẽ overlay làm nổi vùng tìm thấy, config `highlightDurationMs`/`highlightOpacity` (:484-506).
- Config: `confidence: 0.99` (ngưỡng match mặc định), `autoHighlight`, `resourceDirectory` (:119-127); validate search region chặt (min 2x2 px, không NaN, không vượt màn hình — :34-64).
- **Lưu ý**: `screen.read` (đọc text OCR) có trong sample README nhưng **đã không còn trong code v4.2.0** — OCR giờ hoàn toàn qua plugin ngoài `@nut-tree/plugin-ocr` (tìm text bằng `screen.find(singleWord(...))`).

### 2.4 Window management (`core/nut.js/lib/window.class.ts` + `lib/window.function.ts`)

- API cấp cao: `getWindows()`, `getActiveWindow()` (`window.function.ts:9-24`).
- `Window` per-handle: `getTitle` (:35), `getRegion` (:43), `move(newOrigin)` (:73), `resize(newSize)` (:79), `focus` (:85), `minimize` (:89), `restore` (:93 — mới thêm ở 4.2.0).
- **Inspect GUI elements**: `getElements(maxElements)` trả cây `WindowElement` (type, region, title, value, isFocused, selectedText, isEnabled, role, children — `core/shared/lib/types/window-element.interface.ts:5-16`) qua `ElementInspectionProviderInterface` (:97, interface tại `core/provider-interfaces/lib/element-inspection-provider.interface.ts:6`); `find/findAll/waitFor/on` trên element theo mô tả `WindowElementDescription` (id/role/type/title/value/selectedText — :105-221).

### 2.5 Clipboard (`core/nut.js/lib/clipboard.class.ts`)

- Chỉ text: `setContent(text)` (:19), `getContent()` (:27). Default provider dùng `clipboardy 2.3.0` (`providers/clipboardy/package.json:29-31`).

### 2.6 Testing & integration

- **Jest matchers**: `expect(mouse).toBeAt(point)`, `toBeIn(region)`, `toShow(needle)`, `toHaveColor(rgba)` (`lib/expect/jest.matcher.function.ts:6-41`).
- `Assert` class (`lib/assert.class.ts`); logging pluggable `useLogger` / `useConsoleLogger` (`index.ts:36-40`, `lib/provider/log/`).
- macOS: tự check + request quyền Accessibility & Screen Recording từ 2.3.0 (`README.md` mục Permissions); Linux: chỉ **X11, KHÔNG hỗ trợ Wayland** (`README.md` mục Linux).

### 2.7 Kiến trúc provider (plugin system) — xương sống

- **15 interface** tại `core/provider-interfaces/lib/`: clipboard, keyboard, mouse, screen, window, image-finder, text-finder, window-finder, color-finder, element-inspection, image-reader/writer/processor, log, data-source/sink.
- `providerRegistry` singleton đăng ký/tra cứu provider (`lib/provider/provider-registry.class.ts:35-96` — pattern `hasX/getX/registerX` cho từng loại).
- **Default provider có sẵn** trong repo: libnut (mouse/keyboard/screen/window), clipboardy (clipboard), Jimp 0.22.10 (image reader/writer/processor — `lib/provider/io/jimp-image-*.class.ts`, `lib/provider/image/jimp-image-processor.class.ts`), color-finder tự viết.
- **Provider tùy chọn phải cài plugin ngoài repo**: ImageFinder (vd `@nut-tree/template-matcher`), TextFinder/OCR (`@nut-tree/plugin-ocr`), WindowFinder, ElementInspector — không có thì `screen.find(ảnh)` ném "No ImageFinder registered".
- Tắt default provider qua env var `NUT_JS_DISABLE_DEFAULT_PROVIDERS` / per-provider (`lib/constants.ts:1-16`) — feature "Optional default providers" của 4.0.0 (`CHANGELOG.md:24`).

## 3. Trạng thái kỹ thuật

| Mục                | Giá trị                                                                                                                                                                                                            | Bằng chứng                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version            | **4.2.0** (monorepo + tất cả package)                                                                                                                                                                              | `package.json:2`, `core/nut.js/package.json:2-3`                                                                                                                 |
| License            | **Apache-2.0** (KHÔNG phải MIT) cho toàn bộ package                                                                                                                                                                | `core/nut.js/package.json:4`, `core/nut.js/LICENSE:1-3`, `providers/libnut/package.json:36`, `core/provider-interfaces/package.json`, `core/shared/package.json` |
| Ngôn ngữ           | **TypeScript 5.3.3** thuần ở tầng JS; **native layer là prebuilt binary ngoài repo**: `@nut-tree/libnut-{darwin,linux,win32} 2.7.1` (N-API, C++ từ repo libnut-core riêng)                                         | `core/nut.js/package.json:66-72` (devDeps typescript), `providers/libnut/package.json:32-35`                                                                     |
| Native API surface | `keyTap/typeString/moveMouse/mouseClick/dragMouse/scrollMouse/getScreenSize/getWindows/getWindowRect/focusWindow/resizeWindow/moveWindow...`                                                                       | `providers/libnut/libnut.d.ts:192-240`                                                                                                                           |
| Kích thước         | ~243 files; TS: nut.js ~7.27k dòng (gồm spec), provider-interfaces ~0.6k, shared ~1.3k, providers ~1.9k                                                                                                            | đếm `find ... -name "*.ts" \| xargs wc -l`                                                                                                                       |
| Runtime            | Node >= 16; Win/macOS/Linux (x64, arm64)                                                                                                                                                                           | `core/nut.js/package.json:75-90` (engines, os, cpu)                                                                                                              |
| Activity           | Commit cuối **2024-05-01**; repo vẫn public nhưng đã **gỡ package public khỏi npm** (blog "I give up") — tự build từ source miễn phí, prebuilt chỉ qua **subscription trả phí** (token registry riêng)             | `git log -1`, `README.md` mục "The Price of Open Source" + "Pre-built packages"                                                                                  |
| Community vs Pro   | **Không có code phân biệt trong repo** (grep "pricing/subscription/license key" trong lib = 0 kết quả). Phân biệt thuần ở tầng phân phối: source = free (Apache-2.0), prebuilt npm = trả phí qua nutjs.dev/pricing | grep toàn bộ `core/`, `providers/`                                                                                                                               |
| CI                 | GitHub Actions: `ci.yaml` (ubuntu + matrix os/node), `snapshot_release.yaml`, `tagged_release.yaml`                                                                                                                | `.github/workflows/`                                                                                                                                             |
| E2E                | Electron app + Playwright                                                                                                                                                                                          | `e2e/window-test/`, `CHANGELOG.md:26`                                                                                                                            |

## 4. 5 điểm độc đáo nhất

1. **Kiến trúc provider hoá toàn diện** — mọi khả năng (chuột, phím, screen, tìm ảnh/text/window/element, clipboard, log, đọc/ghi ảnh) đều là interface có thể thay thế (`core/provider-interfaces/lib/` 15 file) + registry runtime + env var tắt default (`lib/constants.ts`) → tiến tới "build every single plugin yourself" như README tuyên bố.
2. **Một API `screen.find/findAll/waitFor/on` thống nhất cho 5 loại needle** — ảnh template, từ/câu text (OCR), cửa sổ theo title/RegExp, pixel theo màu RGBA, GUI element trong cửa sổ — cùng cơ chế hook callback khi phát hiện (`screen.class.ts:166-333, 576-604`; `query.class.ts:5-37`).
3. **Tích hợp test-first với Jest**: matchers native `toBeAt/toBeIn/toShow/toHaveColor` cho assert desktop E2E, ví dụ examples là file `*.spec.js` chạy Jest thật (`lib/expect/jest.matcher.function.ts`, `examples/mouse-test/index.spec.js`).
4. **Mouse movement "có đạo"**: path-based `mouse.move(straightTo/up/down/left/right)` với EasingFunction pluggable + tốc độ px/s config, nội suy Bresenham — cho phép mô phỏng chuyển động người thật và drag theo path tuỳ ý (`movement.function.ts`, `mouse-movement.function.ts`, `bresenham.class.ts`).
5. **Vượt qua pixel: inspect GUI element của cửa sổ** (`Window.getElements/findElement` trả cây WindowElement có role/value/isFocused/children) — kết hợp accessibility inspection với image matching trong cùng thư viện (`window.class.ts:97-143`, `window-element.interface.ts`).

## 5. Ghi chú nhanh cho việc tham khảo/viết lại

- OCR **không nằm trong repo** — chỉ có interface `TextFinderInterface`; thực tế dùng `@nut-tree/plugin-ocr` (ONNX/tesseract) bên ngoài.
- Native addon (libnut-core C++) **không nằm trong repo này** — chỉ có TypeScript wrapper `providers/libnut` gọi qua `import_libnut.ts` + d.ts; muốn build toàn bộ phải clone thêm libnut-core.
- README sample dùng `screen.read(...)` đã lỗi thời so với code v4.2.0.
- Hạn chế nền tảng đáng nhớ: macOS cần quyền Accessibility/Screen Recording; Linux chỉ X11 (Wayland không hỗ trợ).
- Model kinh doanh: open-source code + bán prebuilt/registry token → nếu tái dùng, source build được nhưng tốn công build native.

---

# nut-js — Subagent 2: Ưu điểm & áp dụng vào Ghita

Repo: `refer_project/desktop/nut-js` (nut-tree/nut.js monorepo v4.2.0). Cấu trúc: `core/{nut.js, provider-interfaces, shared, configs}` + `providers/{libnut, clipboardy}` + `examples` + `e2e`. Lưu ý quan trọng: **repo này 100% TypeScript**, native C++ nằm ở repo khác (`nut-tree/libnut-core`, Node-API + CMake, Apache-2.0); repo chỉ giữ TS wrapper + `.d.ts` (`providers/libnut/import_libnut.ts:3-7` switch theo platform sang `@nut-tree/libnut-win32/linux/darwin`).

## 1. Ưu điểm nổi bật (xếp hạng)

1. **Hexagonal architecture với provider interfaces thuần TS** — mọi capability OS là interface riêng: `MouseProviderInterface` (`core/provider-interfaces/lib/mouse-provider.interface.ts:6`), `ScreenProviderInterface` (`screen-provider.interface.ts:8`), `WindowProviderInterface` (`window-provider.interface.ts:8`), `ImageFinderInterface` (`image-finder.interface.ts:8`), `ElementInspectionProviderInterface` (`element-inspection-provider.interface.ts:6`). Core `nut.js` không import native trực tiếp — chỉ biết qua `ProviderRegistry` DI.
2. **ProviderRegistry DI + capability probe + Noop fallback** (`core/nut.js/lib/provider/provider-registry.class.ts:35-298`): `hasMouse()/getMouse()` probe trước khi dùng, getter throw với message rõ ràng khi thiếu provider (:55-62), log provider mặc định `NoopLogProvider` để không crash khi chưa register (:267-274). Default providers auto-register nhưng có env-var opt-out từng loại (`lib/constants.ts:1-12`, registry :308-329).
3. **API ergonomics kiểu fluent + movement DSL**: `mouse.move(straightTo(centerOf(region))).click(Button.LEFT)` — mỗi method trả `this` (`core/nut.js/lib/mouse.class.ts:44-112`); `straightTo/up/down/left/right` là async function trả `Point[]` path (`core/nut.js/lib/movement.function.ts:6-40`); query DSL `singleWord/textLine/windowWithTitle/pixelWithColor` (`core/nut.js/index.ts:81-99`); thêm jest matchers (`lib/expect/`).
4. **Mouse movement model tách 3 lớp: path + timing + easing**: Bresenham line rasterizer thuần toán ~70 dòng (`core/nut.js/lib/util/bresenham.class.ts:3-68`), timestep tính từ speed px/s + `EasingFunction` inject được (`core/nut.js/lib/mouse-movement.function.ts:15-31`), `drag` = pressButton + move + releaseButton (`mouse.class.ts:209-222`).
5. **DPI/pixel-density xuyên suốt**: `Image` mang `pixelDensity {scaleX, scaleY}` (`core/shared/lib/objects/image.class.ts:29-33`); screen provider tính density từ bitmap thật vs logical size (`providers/libnut/lib/libnut-screen.class.ts:7-15`); kết quả match/`colorAt` chia ngược density về tọa độ logical (`screen.class.ts:744-747`, `lib/provider/color/color-finder.class.ts:26-28`). Đây đúng bài toán scaleFactor Ghita đang xử lý.
6. **Search pipeline kỷ luật**: `validateSearchRegion` chặn negative/NaN/<2px/out-of-bounds trước khi match (`core/nut.js/lib/screen.class.ts:39-84`); `waitFor` retry-loop generic với deadline + AbortSignal + báo cáo last rejection reason (`core/nut.js/lib/util/timeout.function.ts:7-76`); find hooks `screen.on(image, cb)` (`screen.class.ts:585-597`).
7. **Escape hatch `providerData` generic** — `OptionalSearchParameters<PROVIDER_DATA_TYPE>` (`core/shared/lib/objects/optionalsearchparameters.class.ts:7-22`) + `MatchRequest<NEEDLE, PROVIDER_DATA_TYPE>` (`core/shared/lib/objects/match-request.class.ts:3-9`): cho phép provider riêng nhận tham số riêng (vd `partialMatch` cho OCR) mà không phá interface chung.
8. **Window API đầy đủ + schema a11y tree `WindowElement`**: focus/move/resize/minimize/restore theo handle (`window-provider.interface.ts:8-62`); `WindowElement` = {type, region, title, value, role, isEnabled, children[]} (`core/shared/lib/types/window-element.interface.ts:3-14`) + `findElement(windowHandle, description)` — blueprint grounding bằng accessibility tree. Có kinh nghiệm thực tế: clamp region cửa sổ với màn hình cho maximized window (`core/nut.js/lib/window.class.ts:43-71`, bugfix #559 trong `CHANGELOG.md`).
9. **Error handling + type guard nhất quán**: `isImage/isPoint/isRegion` tự sinh từ object keys (`image.class.ts:133-148`), validate đầu vào ở mọi API public, wrap lỗi kèm context (`screen.class.ts:303-309`).
10. **Monorepo pnpm sạch + test đều**: shared/configs tách riêng, spec sát kèm mỗi class, changelog chi tiết tới v4.2.0.

## 2. Áp dụng vào Ghita

### (a) Dùng trực tiếp làm dependency của packages/computer-use — KHÔNG khuyến nghị

- **License**: sạch — 6/6 `package.json` đều `"license": "Apache-2.0"` + `core/nut.js/LICENSE` (Apache-2.0), không vi phạm ràng buộc cấm GPL/AGPL.
- **Nhưng npm distribution đã rút khỏi registry công cộng**: `README.md:39-49` ("removed public packages from npm"), `README.md:275-281` prebuilt chỉ cho subscription trả phí; `@nut-tree/nl-matcher` trên npm giờ cần đăng nhập (đã verify). Muốn dùng phải build libnut-core (CMake + MSVC) từ source.
- **Runtime mismatch**: nut.js là Node native addon (N-API); apps/desktop Ghita là Tauri — không nạp được vào webview/Rust trực tiếp, chỉ chạy được trong Node sidecar. Hướng hiện tại của Ghita (TauriOperator + crates Rust + napi addon `src/napi.rs` + `packages/native-bridge` loadNative()) đã đúng và rẻ hơn.
- **So với UI-TARS pattern**: nut.js KHÔNG có grounding model — nó là action + verification layer. Bổ trợ được UI-TARS: `waitFor(image)` verify sau hành động, `colorAt` kiểm tra pixel, highlight overlay debug, a11y tree inspect. Giá trị: **trung** (chỉ nếu sau này Ghita làm Node sidecar).

### (b) Patterns đáng lấy (port sang TS/Rust)

| Pattern                                                       | Nguồn nut.js                                                                        | Đích Ghita                                                                                                                                                   | Giá trị    | Độ khó                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------------------------- |
| Registry + `hasX()/getX()` probe + Noop fallback              | `provider-registry.class.ts:51-62,267-274`                                          | `operators/types.ts:63-93` (Ghita đã có `Operator` + `healthCheck()`, `OperatorKind` còn giữ `'nutjs'` ở :25) — xác nhận hướng đúng, thêm probe-style getter | Cao        | Dễ                              |
| `validateSearchRegion` + `waitFor` deadline/AbortSignal       | `screen.class.ts:39-84`, `timeout.function.ts:7-76`                                 | `vision/grounding.ts` + ReAct loop: guard region trước khi match, retry có deadline + báo last error                                                         | Cao        | Dễ                              |
| Window region clamp cho maximized/ âm                         | `window.class.ts:43-71`                                                             | capture theo cửa sổ active trong TauriOperator (crop screenshot)                                                                                             | Cao        | Dễ                              |
| Bresenham path + timestep px/s + easing                       | `bresenham.class.ts:3-68`, `mouse-movement.function.ts:15-31`                       | port sang Rust cho drag/smooth move của TauriOperator (enigo không có sẵn smooth path)                                                                       | Trung-Cao  | Dễ (thuần toán, ~100 dòng Rust) |
| `MatchRequest/MatchResult/providerData` generic               | `match-request.class.ts:3-9`, `optionalsearchparameters.class.ts:7-22`              | interface matching cho `vision/` để sau swap template-matcher (Rust `template-matching`/opencv crate) làm fallback offline của UI-TARS                       | Trung      | Dễ                              |
| Env-var opt-out default providers                             | `constants.ts:1-12`                                                                 | `packages/native-bridge` loadNative(): cờ env disable native trong sandbox                                                                                   | Trung      | Dễ                              |
| Schema `WindowElement` a11y tree + `findElement(description)` | `window-element.interface.ts:3-14`, `element-inspection-provider.interface.ts:6-12` | grounding fallback không cần vision model: port Windows UI Automation bằng windows-rs, expose qua napi.rs                                                    | Cao        | Khó                             |
| macOS permission pre-check (chuỗi warning chuẩn)              | `README.md:205-236`                                                                 | nếu Ghita mở rộng macOS                                                                                                                                      | Thấp-Trung | Trung                           |

### (c) So sánh với enigo/device_query khi port sang Rust

- **Primitive input** (move/click/type/key): enigo đã phủ đủ tương đương `MouseProviderInterface`/`KeyboardProviderInterface` — không cần port logic nut.js ở tầng này; device_query chỉ đọc trạng thái (tương đương `currentMousePosition`). nut.js không có global input listener nên không tham chiếu được ở đó.
- **Layer giữa — phần nut.js đáng port nhất** vì enigo/device_query không có: path generation (Bresenham), easing/timestep, region validation, waitFor-retry, window clamp. Đây là nơi Ghita nên "học" nut.js.
- **Image matching**: nl-matcher (OpenCV, source Apache-2.0 ở `nut-tree/TemplateMatcher`) chỉ là template matching — mô hình UI-TARS của Ghita mạnh hơn cho grounding; chỉ lấy pattern MatchRequest/MatchResult, không port thuật toán.

## 3. Hạn chế / rủi ro

1. **Ecosystem trả phí lẫn quanh repo**: repo này sạch (Apache-2.0 6/6), nhưng các phần "hay nhất" cho grounding — OCR (`@nut-tree/plugin-ocr`, closed, $35/tháng), window-search, element-inspection — là package ngoài đánh dấu `(*)` trong `README.md:105-124`, KHÔNG có source công khai ở đây. Prebuilt npm cần subscription token (`README.md:275-281`). Cần verify từng package con nếu lỡ thêm dependency từ npm nut-tree.
2. **Native build Windows**: code C++ thật nằm ở `nut-tree/libnut-core` (Node-API, CMake, Apache-2.0) — muốn tự build phải MSVC + CMake; deps version cứng `@nut-tree/libnut-win32@2.7.1` (`providers/libnut/package.json`), prebuilt không còn public → rủi ro supply-chain nếu pin npm cũ.
3. **Độ chín**: v4.2.0, changelog đều đặn, có CI/SonarCloud — chín về core; nhưng mô hình kinh doanh đã đổi (subscription), npm public rút → khó dùng "as-is". Stack phụ thuộc cũ: jimp 0.22, clipboardy 2.3, Node >=16.
4. **Nền tảng**: Linux chỉ X11, Wayland KHÔNG hỗ trợ (`README.md:254-260`); `ScreenProviderInterface` chỉ main screen, không multi-monitor (`screen-provider.interface.ts:8-58`). Không ảnh hưởng Windows-first của Ghita nhưng cần biết.
5. **Capture raw BGR**: libnut trả Bitmap BGR (`providers/libnut/lib/libnut-screen.class.ts:38`, `libnut.d.ts:8-16`) — mọi consumer phải convert; Ghita nên chuẩn hoá RGBA ở lớp capture.

## 4. Ba thứ KHÔNG nên học

1. **`busyWaitForNanoSeconds`** (`core/nut.js/lib/sleep.function.ts:8-19`): busy-wait spin `process.hrtime` để timing chuột — chặn 100% event loop, CPU burn; trong agent async của Ghita là anti-pattern. Rust: dùng `std::thread::sleep` / timer native per-step.
2. **Registry singleton có side-effect khi import** (`provider-registry.class.ts:300-329`): module tự new + auto-register default providers qua `require()` ngay khi import — khó test, khoá cứng 1 instance toàn cục, khó substitute. Ghita giữ DI qua struct instance (Operator) là đúng.
3. **Meta-package + side-effect import để register provider ngầm** (`providers/libnut/import_libnut.ts:3-7`; `examples/screen-test/index.spec.js` chỉ `require("@nut-tree/nl-matcher")` để kích hoạt register): "magic" khó trace, plugin registry ẩn. Ghita nên register tường minh qua `loadNative()` + factory function có tên.

## Kết luận

nut.js đáng học nhất ở **kiến trúc provider interface + search pipeline kỷ luật + movement model**, không đáng học ở thuật toán (template matching đã lỗi thời so với grounding model) và không nên dùng làm dependency runtime (npm rút khỏi registry, native C++ ngoài repo, Tauri runtime mismatch). 5 pattern giá trị cao/dễ port cho Ghita: registry probe, validate+waitFor+abort, window clamp, Bresenham+easing smooth move, providerData generic — tất cả khớp vào `packages/computer-use/src/operators/` + `vision/` và crates Rust (bổ trợ enigo/device_query ở layer giữa mà chúng không có).

### Nguồn web đã dùng

- [nutjs.dev/plugins/nl-matcher](https://nutjs.dev/plugins/nl-matcher), [nut-tree/TemplateMatcher](https://github.com/nut-tree/TemplateMatcher), [nut-tree/libnut-core](https://github.com/nut-tree/libnut-core), nutjs.dev pricing (plugin-ocr $35/month).
