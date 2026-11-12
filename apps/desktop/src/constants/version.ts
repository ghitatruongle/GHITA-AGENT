// Nguồn duy nhất của phiên bản hiển thị trong UI (H1.1).
// Quy tắc: scripts/check-version-sync.mjs đối chiếu giá trị này với
// tauri.conf.json + mọi chỗ hiển thị; lệch là FAIL build installer.

export const APP_VERSION = '0.0.1';

/** Chuỗi hiển thị chuẩn (kèm prefix v). */
export const APP_VERSION_LABEL = `v${APP_VERSION}`;
