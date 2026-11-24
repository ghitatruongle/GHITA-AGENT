# RL3 — Thiết kế Pipeline Build Installer (Track 13)

> **Ngày:** 2026-08-10 · **Trạng thái:** ✅ HOÀN THÀNH (thiết kế — không tạo workflow mới)
> **Kết luận chính:** `.github/workflows/release.yml` **đã triển khai toàn bộ pipeline** yêu cầu ở RL3 (build packages → build desktop matrix → installer artifacts → upload + checksum → updater manifest). Do đó **không tạo thêm `release-installer.yml`** để tránh trùng lặp; tài liệu này là thiết kế chuẩn + danh sách artifact để đối chiếu khi chạy.

---

## 1. Sơ đồ pipeline (release.yml, trigger: tag `v*`)

```
tag v1.1.0
   │
   ▼
release-gate (ubuntu) ── integrity → typecheck → lint → test → coverage T0/T1 →
   │                    clippy(-D warnings) → build:packages → desktop build →
   │                    docs → playwright smoke ── bất kỳ đỏ = DỪNG, không tạo release
   ▼
create-release (draft, generate_release_notes)
   │
   ├──► build-windows ── pnpm build:packages → tauri build (sign) ──► .msi + .exe + .exe.sig
   │                      │                                                + updater record windows-x86_64.json
   ├──► build-linux   ── pnpm build:packages → tauri build (sign) ──► .deb + .AppImage + .AppImage.sig
   │                      │                                                + updater record linux-x86_64.json
   ├──► build-macos   ── matrix x86_64 / aarch64 ──► .dmg + .app.tar.gz + .sig
   │                      │                                                + updater record darwin-*.json
   ├──► build-android ── keystore decode → build:release ──► .apk
   └──► build-ios     ── xcodebuild (sign off) ──► .app + .dSYM (artifact, không upload release)
   │
   ▼
generate-updater-json ── gộp records ──► latest.json (version=1.1.0, pub_date, URL release)
   │
   ▼
publish-release ── draft → public (kèm mọi artifact + latest.json)
```

## 2. Danh sách artifact dự kiến theo nền tảng

| Nền tảng    | Installer/artifact                                               | Checksum/signature    | Updater record        |
| ----------- | ---------------------------------------------------------------- | --------------------- | --------------------- |
| Windows x64 | `bundle/nsis/*-setup.exe` + `bundle/msi/*.msi`                   | `.exe.sig` (minisign) | `windows-x86_64.json` |
| Linux x64   | `bundle/deb/*.deb` + `bundle/appimage/*.AppImage`                | `.AppImage.sig`       | `linux-x86_64.json`   |
| macOS x64   | `bundle/dmg/*.dmg` + `bundle/macos/*.app.tar.gz`                 | `.app.tar.gz.sig`     | `darwin-x86_64.json`  |
| macOS arm64 | `bundle/dmg/*.dmg` + `bundle/macos/*.app.tar.gz`                 | `.app.tar.gz.sig`     | `darwin-aarch64.json` |
| Android     | `*.apk` (release, keystore-signed)                               | —                     | —                     |
| iOS         | `.app` + `.dSYM` (artifact CI, retention 30d)                    | —                     | —                     |
| Tất cả      | `latest.json` (updater manifest, sinh ở `generate-updater-json`) | —                     | —                     |

**Local (RL4, máy Windows):** `release/GHITA-CODING-AGENT-Setup-v1.1.0.exe` + `.sha256` — đúng artifact single-file của `build-installer.mjs`.

## 3. Kiểm soát lỗi (theo nguyên tắc 0 bug / 0 warning)

- `release-gate` chặn trước: bất kỳ job đỏ → `publish-release` không chạy (`needs` chain).
- `fail_on_unmatched_files: true` ở mọi job upload → thiếu artifact = fail rõ ràng, không release thiếu file.
- `updater-manifest.mjs manifest` **cảnh báo (không fail)** khi thiếu platform record → không chặn các platform đã build xong.
- Yêu cầu bổ sung khi chạy Track 14 (V1/V2): chạy `pnpm build:installer` trên **Node 22** (khớp CI) để V1 "0 warning" đo đúng toolchain.

## 4. Khuyến nghị khi duyệt Track 14

1. Giữ nguyên `release.yml` (không viết `release-installer.yml` trùng lặp).
2. Thêm bước convert `icon.icns` chuẩn vào `build-macos` (iconutil) — tùy chọn, không chặn.
3. Trước khi publish v1.1.0: chạy RL4 local (đang chạy) → V1 zero-warning → V2 toàn bộ tests → V3 version/artifact → V4 `gh release create v1.1.0`.
