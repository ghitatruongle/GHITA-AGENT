# nut-js — Lượt 2: Kiến trúc & thuật toán

> **Dự án:** nut-tree/nut.js v4.2.0 · clone: `refer_project/desktop/nut-js`
> **Phương pháp:** 2 subagent đọc sâu song song 22/11/2026, chỉ đọc mã nguồn. Subagent 1 = kiến trúc; Subagent 2 = thuật toán & kỹ thuật cốt lõi.

## Tóm tắt nhanh (tổng hợp)

- **Kiến trúc hexagonal thật sự:** `core/provider-interfaces` chứa 16 port interface (mouse/keyboard/screen/3 finder/window-finder+provider/element-inspection/clipboard/image reader-writer-processor/log/data-source-sink); `core/nut.js` là adapter Jimp + DI registry; `providers/libnut` bọc native prebuilt (N-API, chọn binary bằng require theo platform `import_libnut.ts:3-7`).
- **DI:** singleton `DefaultProviderRegistry` tự đăng ký 5 adapter TS khi import; native 5 nhóm đăng ký có điều kiện qua 6 env var `NUT_JS_DISABLE_DEFAULT_*_PROVIDER`; capability probe `hasX()` dùng phòng thủ; plugin (ocr/template-matcher) ghép bằng import singleton + register.
- **Thuật toán đáng học:** path chuột = Bresenham variant error-accumulator (`bresenham.class.ts:4-63`) + easing timesteps (duration = 1e9/speed ns); screen.find 5 needle dispatch qua discriminated union `{type, by}` + type-guards; MatchRequest {haystack, needle, confidence, providerData} + confidence default 0.99 + pixelDensity scale/unscale HiDPI + trick BGR↔RGB; validateSearchRegion chặn âm/NaN/<2px/vượt màn hình; waitFor poll có AbortSignal + lastRejectionReason; clamp region tràn màn hình/maximized (`window.class.ts:43-71`); hotkey `keys.reverse()` + keyTap.
- **Tránh lặp lại:** delay bằng busy-wait hrtime chặn event loop; side-effect require lúc import (binary hỏng → crash toàn bộ); registry singleton side-effect; minimize/restore là stub throw.
- 8 gợi ý port sang Rust cho `packages/computer-use` của Ghita — xem Phần B.

---

# nut-js — Subagent 1: Kiến trúc

Repo phân tích: `D:\GHITA AGENT\refer_project\desktop\nut-js` (nut-tree/nut.js v4.2.0, monorepo pnpm). Native là binary prebuilt ngoài repo (`@nut-tree/libnut-win32/linux/darwin` 2.7.1). Chỉ đọc, không chạy code repo.

## 1. Bản đồ module

pnpm-workspace khai 4 group (`pnpm-workspace.yaml:1-6`): `core/*`, `providers/*`, `examples/*`, `e2e/*`.

| Package                    | Vai trò                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/shared`              | Domain model thuần TS, không phụ thuộc native: `Image` (Buffer + pixelDensity, `core/shared/lib/objects/image.class.ts:20-37`), `MatchRequest` (haystack/needle/confidence/providerData, `match-request.class.ts:3-11`), `MatchResult` (confidence + location + error, `match-result.class.ts:1-9`), `Point/Region/RGBA/Size`, query types (`WordQuery/LineQuery/ColorQuery/WindowQuery`, `query.class.ts`), union `FindInput` (`types/screen.types.ts:6-10`), helper `imageToJimp` hoán đổi BGR↔RGB (`functions/imageToJimp.function.ts:11-25`). |
| `core/provider-interfaces` | 16 interface "port" của kiến trúc hexagonal (mục 2). Không import gì ngoài `@nut-tree/shared`.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `core/nut.js`              | API công khai `@nut-tree/nut-js`: `ScreenClass`, `MouseClass`, `KeyboardClass`, `ClipboardClass`, `AssertClass`, `Window`, jest matchers, và **adapter layer** (Jimp image reader/writer/processor, ColorFinder, ProviderRegistry mặc định). Entry `index.ts:1-137` tạo singleton `mouse/screen/keyboard/...` bọc quanh `providerRegistry`.                                                                                                                                                                                                       |
| `core/configs`             | Chỉ chứa tsconfig dùng chung: `tsconfig/base.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `providers/libnut`         | Package `@nut-tree/libnut`: 4 adapter bọc native `MouseAction/KeyboardAction/ScreenAction/WindowAction` (`lib/*.class.ts`), export lại thành `DefaultMouseAction`... (`index.ts:1-8`).                                                                                                                                                                                                                                                                                                                                                            |
| `providers/clipboardy`     | Package tên trên npm là `@nut-tree/default-clipboard-provider` (package.json name != tên thư mục), adapter clipboardy cho `ClipboardProviderInterface`.                                                                                                                                                                                                                                                                                                                                                                                           |
| `examples/*`               | Jest spec demo thật (mouse/screen/keyboard/typescript) chạy trực tiếp trên máy thật.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `e2e/window-test`          | Tích hợp Electron + Playwright: launch app Electron thật rồi test getWindows/focus/resize (`e2e/window-test/test.spec.js:1-20`).                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Ranh giới TS ↔ native

- Không phải napi/ffi trong repo này: `providers/libnut/import_libnut.ts:3-7` chọn binary theo `process.platform` bằng `require("@nut-tree/libnut-win32"|"linux"|"darwin")`. Các package đó là **prebuild N-API module** ngoài repo (deps cứng 2.7.1, `providers/libnut/package.json:44-48`), repo chỉ giữ **binding shape** tự khai trong `providers/libnut/libnut.d.ts` (hàm C-style: `moveMouse`, `keyTap`, `screen.capture`, `getWindowRect`... ; `libnut.d.ts:192-242`).
- Adapter là lớp "Promise-ify": mọi hàm sync của native được bọc `new Promise` + try/catch (vd `libnut-mouse.class.ts:25-34`).
- Dữ liệu ảnh qua ranh giới: native trả `Bitmap` (con trỏ buffer) → adapter đóng gói thành `Image` với `ColorMode.BGR` + `pixelDensity` (`libnut-screen.class.ts:20-46`). Chiều ngược không có: ảnh needle đọc bằng Jimp trong TS, matching cũng chạy trong TS (không qua native).

## 2. Hexagonal architecture — provider interfaces & DI

### 16 port (interface) trong `core/provider-interfaces/lib/`

- **Input devices**: `mouse-provider` (setMousePosition/click/scroll/pressButton, `mouse-provider.interface.ts:6-104`), `keyboard-provider` (type/click/pressKey/releaseKey).
- **Screen & finders**: `screen-provider` (grabScreen/grabScreenRegion/highlightScreenRegion/screenSize), `image-finder` (findMatch/findMatches nhận `MatchRequest<Image>` → `MatchResult<Region>`, `image-finder.interface.ts:8-32`), `text-finder`, `color-finder`, `window-finder` (trả window handle `number`).
- **Window & UI**: `window-provider` (getWindows/focus/move/resize/minimize), `element-inspection-provider` (getElements/findElement → cây `WindowElement`).
- **Clipboard**: `clipboard-provider` (hasText/copy/paste/clear).
- **Image IO/processing**: `image-reader` + `image-writer` (type alias của `DataSink/DataSourceInterface`), `image-processor` (colorAt).
- **Hạ tầng**: `log-provider` (trace/debug/info/warn/error).
- Tổng: 16 interface + 1 `ProviderRegistry` (DI container interface, `provider-registry.interface.ts:18-100`).

### ProviderRegistry DI (`core/nut.js/lib/provider/provider-registry.class.ts`)

- Singleton module-scope (`:300`), mỗi slot có bộ 3: field private + `hasX()` + `getX()` (throw `No X registered` nếu thiếu) + `registerX()`.
- **Default adapter tự đăng ký khi import module** (`:302-306`): ImageWriter/ImageReader/ImageProcessor (Jimp), ColorFinder, NoopLogProvider — các "adapter thuần TS" nằm trong core.
- **Native provider đăng ký có điều kiện** (`:308-329`): 5 nhóm clipboard/keyboard/mouse/screen/window được `require()` + register chỉ khi env var không chặn:
  - `NUT_JS_DISABLE_DEFAULT_PROVIDERS` — tắt cả 5 (`constants.ts:1-2`)
  - `NUT_JS_DISABLE_DEFAULT_{CLIPBOARD,KEYBOARD,MOUSE,SCREEN,WINDOW}_PROVIDER` — tắt từng cái (`constants.ts:3-12`).
  - Đây là cơ chế chính để user thay provider (env-off rồi `registerMouseProvider(custom)`).
- **Noop fallback duy nhất là LogProvider** (`:267-274`): khi chưa register log, `getLogProvider()` trả `NoopLogProvider` để tránh lỗi đệ quy khi chính register cũng cần log. Còn lại 13 slot: `getX()` throw, `hasX()` là "capability probe" — các class API dùng nó phòng thủ, vd `MouseClass` constructor chỉ `setMouseDelay(0)` nếu `hasMouse()` (`mouse.class.ts:34-38`).
- `registerLogProvider` bọc thêm `wrapLogger` (`:277`) để mọi log đi qua 1 điểm.

## 3. Luồng dữ liệu end-to-end

### A. `screen.find(image, params)` (image search)

1. User gọi `screen.find(imageResource("btn.png"))`; `imageResource` load ảnh qua `getImageReader().load` (Jimp, chuyển sang BGR để đồng bộ với grab — `jimp-image-reader.class.ts:9-31`).
2. `ScreenClass.find` resolve needle, `validateSearchInput`, dispatch theo loại query (`screen.class.ts:182-310`): image/text → Region, color → Point, window → Window.
3. `getFindParameters` (`screen.class.ts:790-814`): lấy `screenSize` từ `getScreen().screenSize()` (native `getScreenSize`), lấy `searchRegion` từ params (mặc định cả màn hình), rồi **grab ảnh haystack** qua `getScreen().grabScreenRegion(searchRegion)` → native `libnut.screen.capture()` trả Bitmap → `Image` BGR + pixelDensity (`libnut-screen.class.ts:48-78`).
4. `validateSearchRegion` chặn region âm/NaN/<2px/tràn màn hình (`screen.class.ts:39-84`).
5. `createMatchRequest` (`screen-helpers.function.ts:75-132`) đóng gói `new MatchRequest(screenImage, needle, minMatch, params?.providerData)` — `providerData` là kênh generic để plugin nhận cấu hình riêng.
6. `getMatchResult` dispatch theo loại needle tới `getImageFinder()/getTextFinder()/getColorFinder()` (`screen-helpers.function.ts:168-182`). Với image: **ImageFinder không nằm trong repo** (phải cài plugin như `@nut-tree/template-matcher`, README.md:115-117); core không có default ImageFinder nên slot này có thể trống → `getImageFinder()` throw lỗi rõ ràng.
7. Plugin matcher trả `MatchResult<Region>` (confidence 0..1 + toạ độ trong haystack). Confidence so với `minMatch` (default `screen.config.confidence = 0.99`, `screen.class.ts:119-125`).
8. Core **chuyển toạ độ từ region tìm kiếm sang toạ độ màn hình** bằng cộng `searchRegion.left/top` (`screen.class.ts:247-252`), chia pixelDensity ở phía finder (thấy ở ColorFinder `color-finder.class.ts:19-24`), chạy find-hooks đã đăng ký bằng `screen.on(...)`, tuỳ chọn `autoHighlight` (gọi native `screen.highlight` qua `highlightScreenRegion`, `screen.class.ts:504-510`).

### B. `mouse.move(path)` theo path

1. Path thường đến từ movement API: `straightTo(centerOf(region))` — `movement.function.ts:23-34` đọc vị trí hiện tại bằng `getMouse().currentMousePosition()` (native `getMousePos`) rồi `lineHelper.straightLine`.
2. `LineHelper.straightLine` → `Bresenham.compute` sinh **toàn bộ điểm pixel** dọc đường thẳng (`bresenham.class.ts:4-63`, gồm cả điểm đích `:60`).
3. `MouseClass.move` (`mouse.class.ts:82-112`): `calculateMovementTimesteps(n, mouseSpeed, easing)` tính mảng duration ns cho từng bước — công thức `1/speed * 1e9` ns, easing cộng tốc theo `idx/amountOfSteps` (`mouse-movement.function.ts:12-31`).
4. Vòng lặp từng bước: `busyWaitForNanoSeconds(minTime)` — **busy-wait chặn event loop** bằng `process.hrtime.bigint()` (`sleep.function.ts:8-19`) — rồi `setPosition(node)` → `getMouse().setMousePosition(p)` → native `libnut.moveMouse(x, y)` (`libnut-mouse.class.ts:25-34`). Tức 1 lệnh move đường thẳng 500px ≈ 500 lần call native + 500 busy-wait; mouse delay của native đã bị đặt về 0 (`mouse.class.ts:35-37`), tốc độ điều khiển hoàn toàn bằng busy-wait phía TS.
5. `drag` = `pressButton` → `move` → `releaseButton` (`mouse.class.ts:209-222`); click/scroll có `autoDelayMs` (default 100ms) `sleep` trước mỗi action.

## 4. Build system, packaging, plugin

- **pnpm workspace** (`pnpm-workspace.yaml` + `package.json:packageManager pnpm@8.15.2`); deps nội bộ dùng protocol `workspace:*` (`core/nut.js/package.json` dependencies), nhưng `peerDependencies` của provider vẫn khai `@nut-tree/nut-js: ^3` (khớp 4.x không strict).
- **tsconfig strategy**: 1 base dùng chung `core/configs/tsconfig/base.json` — target ES2018, commonjs, strict, declaration:true, sourceMap:true; mỗi package extends base + `outDir ./dist` + exclude `**/*.spec.ts` (vd `core/nut.js/tsconfig.json`). Biên dịch bằng `tsc -p .` (`compile` script), publish qua `prepublishOnly: compile`; root chỉ orchestrate `pnpm -r`.
- **Đóng gói**: mỗi package publish riêng ra npm. Binary native **nằm ngoài repo và ngoài package TS**: `@nut-tree/libnut` declare `dependencies` cứng 3 package `@nut-tree/libnut-{win32,linux,darwin}@2.7.1` (`providers/libnut/package.json:44-48`) — npm tự chọn đúng binary theo os/cpu (package nut.js khai `os`/`cpu` allowlist). `.npmignore` của libnut loại `lib/**` nhưng giữ `dist/lib` và loại `**/*.ts`.
- **Plugin system (ngoài repo)**: plugin = npm package riêng (`@nut-tree/plugin-ocr`, `@nut-tree/template-matcher`, element-inspector...). Cơ chế ghép nối: (1) nut.js export singleton `providerRegistry` (`core/nut.js/index.ts:22`) nên plugin import nó và gọi `registerTextFinder/registerImageFinder/registerWindowElementInspector`; (2) `require()` ở `provider-registry.class.ts:310` cho thấy pattern plugin default cũng được nạp bằng require + register; (3) kênh cấu hình riêng của plugin đi qua `OptionalSearchParameters.providerData` → `MatchRequest.providerData` (generic `PROVIDER_DATA_TYPE`, `optionalsearchparameters.class.ts:7-22`); (4) README ví dụ `configure()`/`preloadLanguages()` của plugin-ocr (README.md:139-168).

## 5. Đánh giá

**Điểm mạnh**

1. **Ports & adapters triệt để, ranh giới sạch**: 16 interface ở package riêng chỉ phụ thuộc `shared`; native bị nhốt trong 4 class adapter của `providers/libnut`, mọi hàm sync đều được promise-ify hoá thống nhất — thay matcher/OCR/clipboard không đụng core (bằng chứng: screen-helpers chỉ gọi qua registry, `screen-helpers.function.ts:148-154`).
2. **Shared domain model + generic providerData**: `MatchRequest/MatchResult/Image` dùng chung cho mọi finder, `PROVIDER_DATA_TYPE` cho phép plugin mở rộng không phá interface; pixelDensity xử lý Retina/DPI tập trung 1 chỗ.
3. **Kiểm soát chuyển động & hiển thị tốt**: Bresenham + timesteps + EasingFunction cho mouse (`mouse-movement.function.ts`), jest matchers + e2e Electron/Playwright thật (`e2e/window-test`), env var tắt từng default provider giúp test/headless linh hoạt.

**Điểm yếu**

1. **Side-effect tại import time + ch không có graceful degradation**: default native provider được `require()` ngay khi module load (`provider-registry.class.ts:308-329`); binary hỏng/thiếu sẽ làm import `@nut-tree/nut-js` crash thay vì degrade; duy nhất LogProvider có Noop fallback, các slot khác chỉ throw.
2. **Busy-wait chặn event loop** trong `move` (`sleep.function.ts:8-19`): một đường di chuyển dài chiếm chủ thread Node, không thể concurrency với tác vụ khác; hiệu năng phụ thuộc tốc độ loop JS.
3. **API surface hai tầng dễ lệch**: nhiều method deprecated còn nằm trong interface (`leftClick/rightClick/middleClick`, `mouse-provider.interface.ts:45-61`), enum Key trùng lặp giữa `libnut.d.ts` và `@nut-tree/shared`, một số file spec nằm trong `lib` cùng source; `@nut-tree/default-clipboard-provider` đặt tên npm khác tên thư mục `providers/clipboardy` gây khó tra cứu. Kèm đó: tìm ảnh phụ thuộc hoàn toàn plugin ngoài repo → cài `@nut-tree/nut-js` thuần không có `screen.find(image)` hoạt động.

## Phụ lục bằng chứng chính

- `core/nut.js/lib/provider/provider-registry.class.ts:300-331` — DI + env var + default registration
- `core/nut.js/lib/constants.ts:1-12` — 6 env var
- `providers/libnut/import_libnut.ts:3-7` — chọn native binary theo platform
- `core/nut.js/lib/screen.class.ts:182-310, 790-814` — find flow; `screen-helpers.function.ts:75-182` — MatchRequest + dispatch
- `core/nut.js/lib/mouse.class.ts:82-112`; `util/bresenham.class.ts:4-63`; `mouse-movement.function.ts:12-31`; `sleep.function.ts:8-19` — move flow
- `core/configs/tsconfig/base.json`; `core/nut.js/package.json` — build/packaging
- `README.md:115-168` — plugin-ocr / template-matcher

---

# nut-js — Subagent 2: Thuật toán & kỹ thuật cốt lõi

Repo phân tích: `D:\GHITA AGENT\refer_project\desktop\nut-js` (nut-tree/nut.js v4.2.0, pnpm workspace: `core/nut.js`, `core/shared`, `core/provider-interfaces`, `providers/libnut`, `providers/clipboardy`). Kiến trúc chính: lớp TS (`core/nut.js`) chứa toàn bộ thuật toán điều phối; mọi thao tác "native" đi qua `ProviderRegistry` (`core/nut.js/lib/provider/provider-registry.class.ts:35`). Binary native (`@nut-tree/libnut-darwin/-linux/-win32` — `providers/libnut/package.json:41-45`) là đóng gói qua wrapper `providers/libnut/lib/libnut-*.class.ts`, còn ImageFinder/TextFinder/WindowFinder/WindowElementInspector **không có default** (`provider-registry.class.ts:308-329` chỉ đăng ký clipboard/keyboard/mouse/screen/window) — lấy từ package ngoài (`@nut-tree/template-matcher`, `plugin-ocr`... theo `README.md:114-124`).

## 1. Mouse movement

**Path generator = Bresenham rút gọn, không easing theo quỹ đạo.**

- `core/nut.js/lib/util/bresenham.class.ts:4-63`: `Bresenham.compute(from, to)` — variant error-accumulator kinh điển: chọn trục "fast" theo `absoluteDeltaX > absoluteDeltaY` (dòng 29-43), khởi tạo `error = fastDelta / 2` (dòng 45), loop `idx < fastDelta`, mỗi bước trừ `slowDelta`, nếu `error < 0` thì cộng lại `fastDelta` và đi bước chéo (cả X lẫn Y), ngược lại đi bước thẳng (dòng 47-58). Push điểm đầu mỗi vòng + **push đích `to` cuối cùng bất kể** (dòng 60) — đảm bảo tới đúng đích dù delta = 0.
- `core/nut.js/lib/util/linehelper.class.ts:8-10`: `straightLine` chỉ là alias của Bresenham. Movement API (`movement.function.ts:11-38`) sinh path cho `up/down/left/right/straightTo`, luôn đọc vị trí chuột hiện tại làm origin, `straightTo` validate `isPoint` (dòng 25-31).

**Easing nằm ở timestep, không nằm ở tọa độ.**

- `core/nut.js/lib/mouse-movement.function.ts:15-31`: `calculateMovementTimesteps(steps, speedPxPerSec, easingFn)` — mỗi bước có `speed = baseSpeed + easingFn(idx/steps) * baseSpeed`, stepDuration = `1e9 / speed` (ns, dòng 10-13); nếu duration `!isFinite || <= 0` thì = 0 (dòng 29). Easing nhận **progress 0→1 trả hệ số gia tốc** (có thể âm — cho phép giảm tốc). `linear` trả 0 (dòng 33-35) = tốc độ đều.
- `core/nut.js/lib/mouse.class.ts:82-112`: `move(path, movementType)` — loop từng point: `busyWaitForNanoSeconds(timeSteps[idx])` rồi `setPosition(node)`. **Trick quan trọng**: delay dùng _busy-wait_ `process.hrtime.bigint()` spin-loop (`sleep.function.ts:8-19`) chứ không `setTimeout` — chính xác mức nanosecond nhưng block event loop 100% (1 ms @1000px/s mặc định: `mouse.class.ts:27`). Constructor chủ động `setMouseDelay(0)` tắt delay của native (`mouse.class.ts:36`) để tự kiểm soát timing ở tầng TS.
- Mỗi click/scroll/drag đều `sleep(autoDelayMs = 100ms)` trước (`mouse.class.ts:133-135, 211, 230...`).
- **Drag** (`mouse.class.ts:209-222`): sleep → `pressButton(LEFT)` → `move(path)` → `releaseButton(LEFT)`; không dùng `dragMouse` native mà reuse path Bresenham. `pressButton/releaseButton` map sang `libnut.mouseToggle("down"/"up", btn)` (`providers/libnut/lib/libnut-mouse.class.ts:81-101`); scroll map `scrollMouse(±amount, 0|∓amount)` với dấu đảo cho down (`libnut-mouse.class.ts:114-123`).
- `centerOf` dùng `Math.floor(left + width/2)`; `randomPointIn` dùng `Math.random()*width` (`core/nut.js/lib/location.function.ts:16-19, 37-38`) — trick anti-detection: click vào điểm ngẫu nhiên trong region thay vì tâm.

**Đáng port sang Rust**: Bresenham (dễ); thay busy-wait bằng `spin_sleep`/deadline scheduler per-step; giữ kiến trúc easing = mảng duration per-step (cho phép custom curve).

## 2. Screen.find đa needle

**5 loại needle, dispatch bằng type-guard trên trường `type` của discriminated union `Query`** (`core/shared/lib/objects/query.class.ts:4-70`): `text` (word/line), `window` (title), `color` (RGBA), `window-element` (description); `Image` là needle kiểu class riêng (duck-type check `isImage` so key/type với instance mẫu — `image.class.ts:122-148`). Cấu trúc query luôn `{id, type, by: {...}}`; các factory: `singleWord/textLine/windowWithTitle/pixelWithColor` (`core/nut.js/index.ts:71-108`).

**MatchRequest shape** (`core/shared/lib/objects/match-request.class.ts:3-10`): `haystack: Image` + `needle: NEEDLE_TYPE` + `confidence: number | undefined` + `providerData?: PROVIDER_DATA_TYPE` (generics để provider native tự định nghĩa data riêng). `MatchResult` = `{confidence, location: Point|Region, error?}` (`match-result.class.ts:1-8`); `ScaledMatchResult` thêm `scale` cho match đa tỷ lệ (`scaled-match-result.class.ts:3-14`).

**Dispatch flow** (`core/nut.js/lib/screen.class.ts:182-310`, `screen-helpers.function.ts`):

1. `validateSearchInput` chỉ chấp nhận 4 loại trên (`screen.class.ts:847-871`).
2. `isWindowQuery` → `WindowFinder.findMatch(query)` trả handle number → bọc `Window` (`screen.class.ts:191-205`).
3. `isRegionResultFindInput` (image/text) hoặc `isPointResultFindInput` (color) — các helper nối loại needle → finder: `getMatchResults/getMatchResult` chọn `getImageFinder/getTextFinder/getColorFinder` theo `isImage/isTextQuery/isColorQuery` trên needle (`screen-helpers.function.ts:134-182`).
4. `getFindParameters` (`screen.class.ts:790-814`): `minMatch = params?.confidence`, `screenSize = screenSize()`, `searchRegion = params?.searchRegion ?? screenSize`, rồi `grabScreenRegion(searchRegion)` — haystack chỉ là ảnh vùng search, không full screen khi có region.
5. `validateSearchRegion` (`screen.class.ts:39-84`): chặn giá trị âm, NaN, **region < 2px mỗi chiều** (dòng 67-73), và region vượt màn hình (dòng 74-83) — throw, không tự clamp (khác với window region ở mục 4).
6. Kết quả Region/Point được **cộng offset của searchRegion** về tọa độ tuyệt đối (`screen.class.ts:247-252, 288-291`); `find` trả 1 match, `findAll` trả mảng; color matchRequest ép `confidence = 1` (`screen-helpers.function.ts:129`).

**waitFor + AbortSignal**: `timeout(updateIntervalMs, maxDurationMs, action, {signal})` (`core/nut.js/lib/util/timeout.function.ts:7-76`) — chạy action ngay lập tức, nếu kết quả falsy hoặc reject thì `setTimeout` retry sau `updateInterval` (mặc định 500ms), hẹn giờ tổng `timeoutMs` (mặc định 5000 — `screen.class.ts:547-548`); `signal.onabort` → cleanup + reject ngay (dòng 19-24). Trick: lưu `lastRejectionReason` để báo lý do cuối cùng khi timeout (dòng 61-64). `screen.waitFor` và `Window.waitFor` đều dùng chung util này (`screen.class.ts:559-568`, `window.class.ts:204-213`); abort signal nằm trong `OptionalSearchParameters.abort` (`optionalsearchparameters.class.ts:15-21`).

**Find hooks**: `screen.on(searchInput, callback)` lưu Map<FindInput, callback[]> (`screen.class.ts:585-597`); sau MỖI lần find/findAll thành công chạy tuần tự tất cả hook khớp needle (`screen.class.ts:197-204, 238-245, 351-361`); `getHooksForInput` phân type để trả đúng signature callback (`screen.class.ts:816-837`). `Window` có hệ thống hook riêng cho `WindowElementQuery` (`window.class.ts:221-237`).

**Đáng port**: union Query + type-guard dispatch; tìm haystack = ảnh của đúng region; offset kết quả về hệ tọa độ màn hình.

## 3. Image matching confidence

Phần template matching là **binary** (provider ngoài, không có trong repo). Lớp TS định nghĩa contract:

- `ImageFinderInterface.findMatch/findMatches(MatchRequest<Image, PROVIDER_DATA_TYPE>) → MatchResult<Region>/<Region>[]` (`core/provider-interfaces/lib/image-finder.interface.ts:8-32`). Provider native tự quyết thuật toán (template matching/OpenCV); `ScaledMatchResult.scale` cho thấy template-matcher chính thức hỗ trợ **multi-scale search**.
- Confidence: default `screen.config.confidence = 0.99` (`screen.class.ts:120`), ghi đè qua `OptionalSearchParameters.confidence` → `minMatch`. Đây là **ngưỡng tuyến dưới** do provider diễn giải (thường = tỷ lệ pixel khớp của matchTemplate). Với color, confidence luôn 1 và matching là **so sánh RGBA tuyệt đối từng pixel** (không tolerance).
- `minMatchCount` không xuất hiện ở contract này (chỉ thấy confidence) — các tham số đặc thù khác đi qua `providerData`.
- **PixelDensity/DPI**: `libnut-screen.class.ts:7-15` tính `scaleX = bitmap.width / screen.width` khi grab (Retina scale 2x); Image mang `pixelDensity` mặc định `{1.0, 1.0}` (`image.class.ts:29-32`). `colorAt` nhân tọa độ click với scale trước khi đọc pixel (`screen.class.ts:744-747`); ColorFinder **chia ngược** `x / scaleX` để trả về tọa độ logical (`color-finder.class.ts:25-29, 59-62`). Mọi match từ provider trả theo pixel của haystack, `screen.find` cộng offset region logical (region grab cũng logical) → provider phải tự xử lý density bên trong.
- Color matching (TS thuần, đáng tham khảo): scan tuyến tính toàn bitmap qua `jimp.scanIterator`, so 4 byte R,G,B,A, trả match đầu (findMatch) hoặc tất cả (findMatches) — `core/nut.js/lib/provider/color/color-finder.class.ts:11-68`. Confidence cố định 1.
- **Chuyển đổi màu BGR↔RGB**: screenshot native là BGR (`libnut-screen.class.ts:38, 70`); `imageToJimp` hoán đổi channel R↔B bằng scan khi `colorMode === BGR` (`core/shared/lib/functions/imageToJimp.function.ts:11-24`). Đọc ảnh template từ file/url (Jimp) là RGB → sẽ bị đổi thành BGR khi đem so với haystack BGR — trick: toàn bộ hệ quy chiếu Image luôn "BGR mặc định", đổi qua Jimp trung gian.

## 4. Window management

- **A11y-tree schema** (`core/shared/lib/types/window-element.interface.ts:3-23`): `WindowElement` = `{type?, region?, title?, value?, isFocused?, selectedText?, isEnabled?, role?, subRole?, children?: WindowElement[]}` — cây đệ quy, không id runtime; `WindowElementDescription` (dòng 16-23) là mẫu tìm kiếm `{id?, role?, type?, title?|RegExp, value?|RegExp, selectedText?|RegExp}`. Provider (`ElementInspectionProviderInterface`: `getElements/findElement/findElements` — `element-inspection-provider.interface.ts:6-12`) là native ngoài repo (window-registry); `Window.find/findAll/waitFor/on` chỉ dispatch query `window-element` + hook (`window.class.ts:105-177, 186-231`).
- **Clamp region** cho window tràn màn hình/maximized (`window.class.ts:43-71`): nếu `left < 0` → `width += left; left = 0` (tương tự top); nếu `left+width > screen.width` → cắt phần thừa; cuối cùng floor width/height âm về 0. Đây là điểm hay:OS có thể trả rect âm (shadow border, maximized vượt taskbar) — clamp về phần giao với main screen để search/capture hợp lệ (validateSearchRegion ở mục 2 sẽ reject region tràn màn hình).
- Search window: `windowWithTitle(string|RegExp)` (`index.ts:90-98`) → `WindowFinder.findMatch(es)` trả handle (interface: `window-finder.interface.ts:16-25`); `getWindows/getActiveWindow` bọc handle thành `Window` (`window.function.ts:9-25`). RegExp matching nằm ở provider native.
- focus/move/resize qua `libnut.focusWindow/moveWindow/resizeWindow` (`libnut-window.class.ts:54-82`); **minimize/restore là stub throw "Method not implemented"** ở provider libnut (`libnut-window.class.ts:84-90`) — chỉ có qua provider commercial; interface vẫn định nghĩa (`window-provider.interface.ts:54-61`).
- Native API shape (`providers/libnut/libnut.d.ts:210-242`): handle là `number` (HWND dưới dạng number), `getWindowRect` trả `{x,y,width,height}`.

## 5. Keyboard

- **Key enum 105 phím + 12 multimedia** (`core/shared/lib/enums/key.enum.ts:4-156`): F1-F24, numpad, modifiers cả 2 bên (Left/Right Shift/Ctrl/Alt/Super/Win/Cmd), Fn, Menu, mũi tên, và Audio* (Mute/Vol/Play/Stop/.../Random, dòng 144-155). Trick alias: `LeftSuper`→"command", `LeftCmd`→"cmd" map chung (xem dưới).
- **Mapping Key → chuỗi native** (`providers/libnut/lib/libnut-keyboard.class.ts:6-151`): Map<Key, string|null> với tên kiểu "numpad_0", "audio_mute", "right_alt"... đúng chuẩn libnut key names (`libnut.d.ts:32-190`). `Key.Pause → null` = phím bị bỏ qua âm thầm (dòng 121).
- **Hotkey combination**: `mapModifierKeys` lọc ra các key có `length > 1` (chỉ modifier string như "control", "shift"; ký tự đơn "a" bị loại) (`libnut-keyboard.class.ts:157-161`). `click(...keys)`: **`keys.reverse()` rồi tách `[key, ...modifiers]`** (dòng 196-211) — vì user truyền `Key.LeftControl, Key.V` (modifier trước), reverse đưa phím chính lên đầu, rồi `libnut.keyTap(nativeKey, modifierKeys)` một lần. `pressKey/releaseKey` tương tự với `keyToggle(nativeKey, "down"/"up", modifiers)` (dòng 163-180, 213-237) — combo giữ-giữ: `pressKey(CTRL,V)` ... `releaseKey(CTRL,V)`.
- **Typing flow**: `KeyboardClass.type(input)` — nếu toàn string: **join mảng bằng khoảng trắng rồi lặp từng ký tự**, mỗi ký tự `sleep(autoDelayMs=300)` + `provider.type(char)` → `libnut.typeString(char)` (`keyboard.class.ts:54-62`); nếu Key[]: đi `click(...)` đường hotkey ở trên (dòng 63-72). `inputIsString` yêu cầu **tất cả** phần tử là string (`keyboard.class.ts:7-9`). Trick/lưu ý: join(" ") nghĩa là `type("AB","CD")` gõ "AB CD"; tốc độ gõ bị chi phối bởi autoDelayMs (300ms/ký tự mặc định — chậm hơn nhiều so với `typeStringDelayed` native mà API không expose).
- `setKeyboardDelay` native bị set sẵn bằng autoDelayMs trong constructor (`keyboard.class.ts:36-42`) nhưng chuỗi type không dùng native delay.

## 6. Kỹ thuật khác

- **Clipboard**: `ClipboardClass` chỉ copy/paste text qua `ClipboardProviderInterface` (`clipboard.class.ts:18-30`); default provider dùng `clipboardy.readSync/writeSync` (`providers/clipboardy/lib/clipboardy-clipboard.class.ts:8-36`); `clear()` reject "not implemented", `hasText` = `content.length > 0`. Pattern clipboard-paste-typing (setContent → Ctrl+V) do user tự lắp.
- **Highlight overlay**: `screen.highlight(region)` → `libnut.screen.highlight(x,y,w,h,durationMs,opacity)` — cửa sổ overlay vẽ bởi binary native, config `autoHighlight/highlightDurationMs=500/highlightOpacity=0.25` (`screen.class.ts:119-125, 484-512`); `find` tự highlight khi `autoHighlight = true` (`screen.class.ts:258-264`).
- **Jest matcher**: `jestMatchers = {toBeAt, toBeIn, toShow, toHaveColor}` + declare global `jest.Matchers` (`jest.matcher.function.ts:7-27`). `toShow` nhận `ScreenClass|Region` — nếu Region thì tự inject `parameters.searchRegion = received` rồi gọi `screen.find`, pass/fail theo try/catch (`toShow.function.ts:5-43`); `toHaveColor` so hex (`toHaveColor.function.ts:6-13`); `toBeAt` so x,y tuyệt đối (`toBeAt.function.ts:4-6`). Trick: matcher dựa trên throw của find — message phủ định viết sẵn ("Expected screen to not show...").
- **ProviderRegistry**: service locator 14 slot, getter throw lỗi "No X registered" nếu thiếu, log provider fallback NoopLogProvider để tránh lỗi khi chưa set (`provider-registry.class.ts:263-274`); default providers có thể tắt riêng bằng env `NUT_JS_DISABLE_*` (`constants.ts:1-12`, registry dòng 308-329). Đây là mẫu kiến trúc plugin đáng port: core thuần TS + contract interface + provider native swap được.
- **Assert**: `assert.isVisible/notVisible` = bọc screen.find thành exception có ngữ nghĩa (`assert.class.ts:8-49`).
- **fetchFromUrl**: load template ảnh từ URL qua Jimp.read, validate URL trước (`imageResources.function.ts:21-48`), bitsPerPixel tính bằng `data.length / (w*h)` (dòng 40).
- **Type-guard duck-typing**: `isImage/isPoint/isRegion` so từng key + typeof với instance mẫu tạo sẵn (`image.class.ts:122-148`, `point.class.ts:14-28`) — bảo vệ runtime khi nhận input từ JS thuần.

## Ghi chú port sang Rust (packages/computer-use của Ghita)

1. **Bresenham + timestep easing** (mục 1): port trực tiếp ~80 dòng; thay busy-wait bằng `spin_sleep::sleep` hoặc deadline per-step để giữ chính xác mà không cháy CPU; thiết kế `EasingFunction = Fn(f64) -> f64` trên speed multiplier rất gọn.
2. **Discriminated-union Query + MatchRequest generic providerData** (mục 2): map sang `enum Query { Text(Word/Line), Window{title}, Color(Rgba), WindowElement(desc) }` + generic `MatchRequest<N, P>`; dispatch bằng match thay vì type-guard.
3. **validateSearchRegion** (mục 2): bộ validate 4 điều kiện (âm/NaN/<2px/vượt màn hình) nên giữ nguyên; cân nhắc thêm chế độ clamp thay vì throw.
4. **Window region clamp** (mục 4): công thức cắt biên âm/tràn màn hình bắt buộc port vì Windows trả rect gồm shadow/borders.
5. **Keyboard reverse-modifiers** (mục 5): hợp ước API `press_key(&[Modifier...], key)`; lưu ý cách lọc modifier (length > 1) là hack gắn với chuỗi libnut — nên thay bằng enum tường minh.
6. **PixelDensity scale/unscale** (mục 3): giữ pattern `logical ↔ physical` (nhân khi đọc pixel, chia khi trả kết quả finder) cho HiDPI.
7. **timeout-poll util** (mục 2): vòng poll `interval + maxTimeout + AbortSignal + lastRejectionReason` là mẫu waitFor hoàn chỉnh, port được bằng `tokio::time` + `CancellationToken`.
8. **Điều tránh**: busy-wait block event loop; `type` join(" ") bất ngờ; confidence mặc định 0.99 quá khắt khe (nên cho config, mặc định mềm hơn); minimize/restore stub cần implement thật ở tầng native của Ghita.
