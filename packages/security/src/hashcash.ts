//
// Hashcash PoW (SHA3-256) cho local API bridge — Track S4 optional.
//
// Clean-room implementation theo THIẾT KẾ mô tả trong deep-dive open-agent
// (docs/plans/0.0.2-alpha/deep-dive/open-agent/02-luot-2-kien-truc-thuat-toan.md,
// mục 4) — KHÔNG copy code gốc; chỉ tái hiện đúng các quyết định thuật toán
// đã được kiểm chứng:
//
//   - Stamp hashcash v1 7 trường: `1:{bits}:{ts}:{resource}:{ext}:{rand}:{counter}`
//     với ts = UTC giây `YYYYMMDDHHMMSS`, rand = salt alphanumeric 16 ký tự.
//   - Mint: thử counter tăng dần, SHA3-256(prefix + counter), tới khi hash có
//     **ceil(bits/4)** ký tự hex '0' đầu (mint "khó" hơn check tối đa 1 nibble
//     khi bits không chia hết cho 4; bits=20 → 5 hex zero ≈ 2^20 lần băm TB).
//   - Check: version '1', stamp.bits >= requiredBits (server đòi ít hơn hoặc
//     bằng mức stamp khai báo), resource khớp chính xác, và hash có
//     **floor(bits/4)** hex zero đầu — nghiêm ngặt hơn 1 nibble chỉ khi verifier
//     tự quyết bits chia hết cho 4 (bits=20 hai phía bằng nhau).
//   - TTL: timestamp quá hạn (mặc định 5 phút) → invalid; timestamp tương lai
//     quá skew nhỏ → invalid (chống replay + chống stamp "từ tương lai").
//
// Mức bits hợp lệ bị chặn trên (MAX_HASHCASH_BITS = 64) để một stamp giả mạo
// không ép verifier băm vô hạn hay so 1000+ nibble. Mint là đồng bộ — dùng cho
// bits thấp (<= 24, ~16M băm tối đa) ở phía client; phía server chỉ check (rẻ).

import { createHash, randomBytes } from 'node:crypto';

export const DEFAULT_HASHCASH_BITS = 20;
export const MAX_HASHCASH_BITS = 64;
export const DEFAULT_HASHCASH_TTL_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;
const HASHCASH_VERSION = '1';

export interface HashcashStampInfo {
  version: string;
  bits: number;
  /** UTC `YYYYMMDDHHMMSS` — giữ nguyên dạng stamp để verify lại được. */
  timestamp: string;
  resource: string;
  ext: string;
  rand: string;
  counter: string;
  /** Stamp đầy đủ 7 trường, chuỗi client gửi kèm request. */
  stamp: string;
}

export type HashcashCheckResult =
  { valid: true; info: HashcashStampInfo } | { valid: false; reason: string };

export interface MintHashcashOptions {
  /** Số bits PoW. Mặc định 20. Chặn trên 64. */
  bits?: number;
  /** Thời điểm tạo stamp (mặc định Date.now()). */
  now?: Date;
  /** Ghi đè salt 16 ký tự (mặc định random alphanumeric). */
  rand?: string;
  /** Giới hạn số lần thử (mặc định 2^24) — vượt-limit trả null thay vì treo. */
  maxAttempts?: number;
}

export interface CheckHashcashOptions {
  /** Resource đích phải khớp CHÍNH XÁC với resource trong stamp. */
  resource: string;
  /** Bits tối thiểu verifier chấp nhận (mặc định bằng stamp.bits). */
  requiredBits?: number;
  /** Tuổi tối đa của stamp (mặc định 5 phút). */
  ttlMs?: number;
  /** Thời điểm kiểm tra (mặc định Date.now()). */
  now?: Date;
}

function formatUtcTimestamp(date: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  );
}

function parseUtcTimestamp(raw: string): Date | null {
  if (!/^\d{14}$/.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const hour = Number(raw.slice(8, 10));
  const minute = Number(raw.slice(10, 12));
  const second = Number(raw.slice(12, 14));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return Number.isFinite(date.getTime()) ? date : null;
}

function randomSalt(length = 16): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(length);
  let salt = '';
  for (let i = 0; i < length; i++) {
    const byte = bytes[i] ?? 0;
    salt += alphabet.charAt(byte % alphabet.length);
  }
  return salt;
}

function sha3Hex(input: string): string {
  return createHash('sha3-256').update(input, 'utf8').digest('hex');
}

/** Số nibble hex '0' đứng đầu của hash. */
export function hashcashLeadingZeroNibbles(hexHash: string): number {
  let count = 0;
  for (const ch of hexHash) {
    if (ch === '0') count += 1;
    else break;
  }
  return count;
}

function validateBits(bits: number): void {
  if (!Number.isInteger(bits) || bits < 1 || bits > MAX_HASHCASH_BITS) {
    throw new RangeError(
      `hashcash bits must be an integer in [1, ${MAX_HASHCASH_BITS}], got ${bits}`,
    );
  }
}

/** Tạo stamp hashcash (PoW). Trả null nếu không đạt difficulty trong maxAttempts. */
export function mintHashcash(
  resource: string,
  options: MintHashcashOptions = {},
): HashcashStampInfo | null {
  if (typeof resource !== 'string' || resource.length === 0 || resource.includes(':')) {
    throw new Error('hashcash resource must be non-empty and must not contain ":"');
  }
  const bits = options.bits ?? DEFAULT_HASHCASH_BITS;
  validateBits(bits);
  const ts = formatUtcTimestamp(options.now ?? new Date());
  const rand = options.rand ?? randomSalt();
  if (!/^[A-Za-z0-9]{16}$/.test(rand)) {
    throw new Error('hashcash rand must be 16 alphanumeric characters');
  }
  const maxAttempts = options.maxAttempts ?? 2 ** 24;
  const prefix = `${HASHCASH_VERSION}:${bits}:${ts}:${resource}::${rand}:`;
  const neededNibbles = Math.ceil(bits / 4);

  for (let counter = 0; counter < maxAttempts; counter++) {
    if (hashcashLeadingZeroNibbles(sha3Hex(`${prefix}${counter}`)) >= neededNibbles) {
      return {
        version: HASHCASH_VERSION,
        bits,
        timestamp: ts,
        resource,
        ext: '',
        rand,
        counter: String(counter),
        stamp: `${prefix}${counter}`,
      };
    }
  }
  return null;
}

/**
 * Verify stamp hashcash: format 7 trường, version, resource chính xác,
 * requiredBits, TTL, và đủ nibble zero theo floor(stamp.bits / 4).
 */
export function checkHashcash(stamp: string, options: CheckHashcashOptions): HashcashCheckResult {
  const invalid = (reason: string): HashcashCheckResult => ({ valid: false, reason });
  const parts = typeof stamp === 'string' ? stamp.split(':') : [];
  if (parts.length !== 7) {
    return invalid('stamp must have exactly 7 colon-separated fields');
  }
  // Length đã guard phía trên (parts.length === 7) — các phần tử bắt buộc tồn
  // tại, nên default `''` dưới đây không bao giờ có hiệu lực runtime.
  const [version = '', bitsRaw = '', tsRaw = '', resource = '', ext = '', rand = '', counter = ''] =
    parts;
  if (version !== HASHCASH_VERSION) {
    return invalid(`unsupported hashcash version: ${version}`);
  }
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 1 || bits > MAX_HASHCASH_BITS) {
    return invalid(`stamp bits out of range: ${bitsRaw}`);
  }
  if (typeof options.resource !== 'string' || resource !== options.resource) {
    return invalid('resource does not match');
  }
  const requiredBits = options.requiredBits ?? bits;
  if (bits < requiredBits) {
    return invalid(`stamp claims ${bits} bits but ${requiredBits} are required`);
  }
  if (!/^[A-Za-z0-9]{16}$/.test(rand)) {
    return invalid('stamp rand must be 16 alphanumeric characters');
  }
  if (!/^\d+$/.test(counter)) {
    return invalid('stamp counter must be numeric');
  }
  const stampTime = parseUtcTimestamp(tsRaw);
  if (!stampTime) {
    return invalid('stamp timestamp is not a valid UTC YYYYMMDDHHMMSS value');
  }
  const now = options.now ?? new Date();
  const ageMs = now.getTime() - stampTime.getTime();
  if (ageMs < -MAX_FUTURE_SKEW_MS) {
    return invalid('stamp timestamp is too far in the future');
  }
  if (ageMs > (options.ttlMs ?? DEFAULT_HASHCASH_TTL_MS)) {
    return invalid('stamp expired');
  }
  const neededNibbles = Math.floor(bits / 4);
  const hashHex = sha3Hex(`${stamp}`);
  if (hashcashLeadingZeroNibbles(hashHex) < neededNibbles) {
    return invalid('proof of work does not meet the claimed difficulty');
  }
  // ext được giữ nguyên (hiện tại '') — chỉ chặn ký tự phá format.
  if (ext.includes(' ')) {
    return invalid('stamp ext must not contain spaces');
  }
  return {
    valid: true,
    info: { version, bits, timestamp: tsRaw, resource, ext, rand, counter, stamp },
  };
}
