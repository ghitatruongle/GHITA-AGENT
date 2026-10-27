# 📦 Ghita Agent — Phát hành Installer

Từ v1.0.0, mỗi lần build tạo ra **ĐÚNG 1 file installer duy nhất** (kiểu
Cursor / Antigravity) — người dùng tải 1 file, chạy là cài xong, không cần
quyền admin.

## Build

```bash
pnpm build:installer
```

Kết quả (thư mục `release/`):

```
release/
├── Ghita Agent-Setup-v0.0.0-preview.exe   ← file duy nhất cần phát hành
└── Ghita Agent-Setup-v0.0.0-preview.exe.sha256
```

- Tên file **cố định theo version** — mỗi lần build ghi đè đúng 1 file.
- Kèm checksum SHA-256 để người dùng xác minh tính toàn vẹn.
- Chỉ tạo NSIS (`.exe`) — không còn `.msi` / raw binary lẫn lộn.

## Phát hành (2 cách)

### Cách 1 — GitHub Releases (khuyến nghị)

1. Tạo release tag `v1.0.0` trên GitHub.
2. Upload `Ghita Agent-Setup-v0.0.0-preview.exe` + `.sha256`.
3. Người dùng tải 1 file, chạy, cài xong.

### Cách 2 — Gửi trực tiếp

Chỉ cần gửi file `.exe` cho người dùng (Windows 10/11).
Installer tự tải WebView2 nếu máy chưa có (`downloadBootstrapper`),
cài theo user — không cần admin.

## Ghi chú

- Auto-update: bản build có updater artifacts (`.sig`) — khi cập nhật
  `latest.json` + file mới lên release, app tự nhắc cập nhật.
- Debug nhanh (không rebuild Rust): `pnpm build:installer:debug`
  (đóng gói lại từ bản `tauri build` gần nhất).
