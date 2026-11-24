//
// Port của các pattern an toàn vùng tìm kiếm từ nut-js
// (deep-dive: docs/plans/0.0.2-alpha/deep-dive/nut-js/02-luot-2-kien-truc-thuat-toan.md).
//
//   - validateSearchRegion  ← core/nut.js/lib/screen.class.ts:39-84
//     Chặn region KHÔNG HỢP LỆ bằng throw (không tự clamp): tọa độ âm, NaN,
//     region < 2px mỗi chiều, hoặc region tràn màn hình. Lý do: search region
//     là đầu vào của logic caller — giá trị sai là bug logic và phải fail sớm.
//
//   - clampRegionToScreen   ← core/nut.js/lib/window.class.ts:43-71
//     Ngược lại với validate: OS có thể trả window rect gồm shadow border /
//     maximized tràn taskbar (trên Windows rect còn âm) — clamp về phần giao
//     với màn hình chính để search/capture hợp lệ, KHÔNG throw.
//
// Cặp pattern này bổ sung nhau: validate cho input chủ động của agent,
// clamp cho dữ liệu thô từ hệ điều hành.

import type { ScreenSize } from '../index.js';

export interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Lỗi khi search region không hợp lệ (âm / NaN / <2px / tràn màn hình). */
export class InvalidSearchRegionError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSearchRegionError';
  }
}

const REGION_KEYS = ['left', 'top', 'width', 'height'] as const;
const MIN_DIMENSION_PX = 2;

function describeRegion(region: Region): string {
  return `(left=${region.left}, top=${region.top}, width=${region.width}, height=${region.height})`;
}

/**
 * Validate search region theo nut-js screen.class.ts:39-84 — throw
 * InvalidSearchRegionError khi:
 *   1. bất kỳ thành phần nào là NaN,
 *   2. left/top/width/height âm,
 *   3. width hoặc height < 2px (không thể match trong vùng 1px),
 *   4. region vượt ra ngoài màn hình (khi `screenSize` được cung cấp).
 */
export function validateSearchRegion(region: Region, screenSize?: ScreenSize): void {
  for (const key of REGION_KEYS) {
    const value = region[key];
    if (Number.isNaN(value)) {
      throw new InvalidSearchRegionError(
        `Search region has a NaN ${key}: ${describeRegion(region)}`,
      );
    }
    if (value < 0) {
      throw new InvalidSearchRegionError(
        `Search region has a negative ${key}: ${describeRegion(region)}`,
      );
    }
  }
  if (region.width < MIN_DIMENSION_PX || region.height < MIN_DIMENSION_PX) {
    throw new InvalidSearchRegionError(
      `Search region is too small (minimum ${MIN_DIMENSION_PX}px per dimension): ${describeRegion(region)}`,
    );
  }
  if (screenSize) {
    if (
      region.left + region.width > screenSize.width ||
      region.top + region.height > screenSize.height
    ) {
      throw new InvalidSearchRegionError(
        `Search region ${describeRegion(region)} extends beyond the screen ` +
          `${screenSize.width}x${screenSize.height}`,
      );
    }
  }
}

/**
 * Clamp window/hardware region về phần giao với màn hình (nut-js
 * window.class.ts:43-71). Không throw — dữ liệu từ OS có thể tràn màn hình
 * hoặc có gốc âm (shadow border, maximized vượt taskbar):
 *   - left/top âm → dịch gốc về 0 và trừ phần thừa ra kích thước,
 *   - tràn phải/dưới → cắt phần thừa,
 *   - kích thước âm còn lại → về 0.
 */
export function clampRegionToScreen(region: Region, screenSize: ScreenSize): Region {
  let { left, top, width, height } = region;
  if (left < 0) {
    width += left;
    left = 0;
  }
  if (top < 0) {
    height += top;
    top = 0;
  }
  if (left + width > screenSize.width) {
    width = screenSize.width - left;
  }
  if (top + height > screenSize.height) {
    height = screenSize.height - top;
  }
  return {
    left,
    top,
    width: Math.max(0, Math.floor(width)),
    height: Math.max(0, Math.floor(height)),
  };
}
