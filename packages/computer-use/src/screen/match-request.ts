//
// Port pattern MatchRequest generic từ nut-js
// (core/shared/lib/objects/match-request.class.ts:3-10 + screen-helpers
// createMatchRequest, deep-dive nut-js 02 mục 2):
//
//   MatchRequest { haystack, needle, confidence?, providerData? } là "hợp đồng"
//   chung cho MỌI finder (image/text/color/window). `PROVIDER_DATA_TYPE` là kênh
//   cấu hình generic để provider/plugin nhận tham số riêng mà không phá interface
//   (nut-js gọi là OptionalSearchParameters.providerData).
//
//   confidence mặc định 0.99 như nut-js (screen-helpers.function.ts:75-132).

import type { Region } from './region.js';

export const DEFAULT_MATCH_CONFIDENCE = 0.99;

export interface MatchRequest<HAYSTACK, NEEDLE, PROVIDER_DATA_TYPE = unknown> {
  /** Ảnh/vùng dữ liệu lớn để tìm trong đó (thường là screenshot hiện tại). */
  haystack: HAYSTACK;
  /** Mẫu cần tìm (image template, text, màu, mô tả window element...). */
  needle: NEEDLE;
  /** Ngưỡng khớp [0, 1]. Mặc định 0.99 như nut-js. */
  confidence?: number;
  /** Kênh cấu hình riêng của provider/plugin (generic, không phá interface). */
  providerData?: PROVIDER_DATA_TYPE;
}

export interface MatchResult<LOCATION = Region> {
  confidence: number;
  location: LOCATION;
  error?: string;
}

export interface MatchRequestInput<HAYSTACK, NEEDLE, PROVIDER_DATA_TYPE = unknown> {
  haystack: HAYSTACK;
  needle: NEEDLE;
  confidence?: number;
  providerData?: PROVIDER_DATA_TYPE;
}

/**
 * Đóng gói MatchRequest chuẩn hoá: áp confidence mặc định 0.99 và chặn giá
 * trị vô lý (không finite, <= 0, > 1) ngay từ ranh giới — finder downstream
 * được đảm bảo nhận ngưỡng hợp lệ.
 */
export function createMatchRequest<HAYSTACK, NEEDLE, PROVIDER_DATA_TYPE = unknown>(
  input: MatchRequestInput<HAYSTACK, NEEDLE, PROVIDER_DATA_TYPE>,
): MatchRequest<HAYSTACK, NEEDLE, PROVIDER_DATA_TYPE> {
  const confidence = input.confidence ?? DEFAULT_MATCH_CONFIDENCE;
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence > 1) {
    throw new RangeError(
      `Match confidence must be in (0, 1], got ${input.confidence} ` +
        `(default is ${DEFAULT_MATCH_CONFIDENCE})`,
    );
  }
  return {
    haystack: input.haystack,
    needle: input.needle,
    confidence,
    ...(input.providerData !== undefined ? { providerData: input.providerData } : {}),
  };
}
