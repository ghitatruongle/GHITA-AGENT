// Track S4 optional — hashcash PoW (SHA3-256) unit tests.
// Thiết kế clean-room theo deep-dive open-agent mục 4: stamp v1 7 trường,
// mint ceil(bits/4) nibble zero, check floor(bits/4), TTL 5 phút, resource
// khớp chính xác, rand alphanumeric 16.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HASHCASH_BITS,
  MAX_HASHCASH_BITS,
  checkHashcash,
  hashcashLeadingZeroNibbles,
  mintHashcash,
} from '../src/hashcash.js';

const RESOURCE = 'local-api-bridge';
const NOW = new Date('2026-11-22T00:00:00.000Z');

describe('mintHashcash', () => {
  it('tạo stamp đúng format v1 7 trường và tự verify được', () => {
    const minted = mintHashcash(RESOURCE, { bits: 8, now: NOW });
    expect(minted).not.toBeNull();
    const stamp = minted!.stamp;
    const fields = stamp.split(':');
    expect(fields).toHaveLength(7);
    expect(fields[0]).toBe('1');
    expect(fields[1]).toBe('8');
    expect(fields[2]).toBe('20261122000000');
    expect(fields[3]).toBe(RESOURCE);
    expect(fields[4]).toBe('');
    expect(fields[5]).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(Number(fields[6])).toBeGreaterThanOrEqual(0);

    const result = checkHashcash(stamp, { resource: RESOURCE, now: NOW });
    expect(result.valid).toBe(true);
  });

  it('hash đạt đúng ceil(bits/4) nibble zero (mint difficulty)', () => {
    const minted = mintHashcash(RESOURCE, { bits: 12, now: NOW })!;
    const hash = hashLeadingNibblesStamp(minted.stamp);
    expect(hash).toBeGreaterThanOrEqual(Math.ceil(12 / 4));
  });

  it('bits=13: mint ceil=4 nibble nhưng check floor=3 → vẫn verify pass (asymmetry như thiết kế)', () => {
    const minted = mintHashcash(RESOURCE, { bits: 13, now: NOW });
    expect(minted).not.toBeNull();
    const result = checkHashcash(minted!.stamp, { resource: RESOURCE, now: NOW });
    expect(result.valid).toBe(true);
    expect(result.valid && result.info.bits).toBe(13);
  });

  it('mặc định bits = 20 (DEFAULT_HASHCASH_BITS)', () => {
    expect(DEFAULT_HASHCASH_BITS).toBe(20);
  });

  it('resource rỗng / chứa ":" → throw', () => {
    expect(() => mintHashcash('', { bits: 8 })).toThrow(/resource/);
    expect(() => mintHashcash('bad:resource', { bits: 8 })).toThrow(/resource/);
  });

  it('bits vô lý (0, 100, không nguyên) → RangeError', () => {
    expect(() => mintHashcash(RESOURCE, { bits: 0 })).toThrow(RangeError);
    expect(() => mintHashcash(RESOURCE, { bits: 100 })).toThrow(RangeError);
    expect(() => mintHashcash(RESOURCE, { bits: 8.5 })).toThrow(RangeError);
    expect(MAX_HASHCASH_BITS).toBe(64);
  });

  it('maxAttempts quá nhỏ so với difficulty → trả null (không treo)', () => {
    // bits=40 → 10 nibble zero — bất khả thi trong 10 lần thử.
    expect(mintHashcash(RESOURCE, { bits: 40, maxAttempts: 10 })).toBeNull();
  });

  it('rand tùy chọn phải là 16 alphanumeric', () => {
    expect(() => mintHashcash(RESOURCE, { bits: 8, rand: 'short' })).toThrow(/rand/);
    expect(() => mintHashcash(RESOURCE, { bits: 8, rand: 'has-space-here-16!' })).toThrow(/rand/);
  });
});

describe('checkHashcash', () => {
  const minted = mintHashcash(RESOURCE, { bits: 8, now: NOW, rand: 'AbCdEf0123456789' })!;

  it('requiredBits cao hơn mức stamp khai báo → invalid', () => {
    const result = checkHashcash(minted.stamp, {
      resource: RESOURCE,
      requiredBits: 16,
      now: NOW,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/are required/);
  });

  it('resource khác → invalid', () => {
    const result = checkHashcash(minted.stamp, { resource: 'other-resource', now: NOW });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/resource does not match/);
  });

  it('sai số trường / sai version → invalid', () => {
    expect(checkHashcash('1:8:20261122000000', { resource: RESOURCE, now: NOW }).valid).toBe(false);
    expect(
      checkHashcash(minted.stamp.replace(/^1:/, '2:'), { resource: RESOURCE, now: NOW }).valid,
    ).toBe(false);
    expect(checkHashcash('', { resource: RESOURCE, now: NOW }).valid).toBe(false);
  });

  it('bits ngoài [1, 64] → invalid (chặn DoS difficulty)', () => {
    const fields = minted.stamp.split(':');
    const forged = ['1', '65', ...fields.slice(2)].join(':');
    const result = checkHashcash(forged, { resource: RESOURCE, now: NOW });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/bits out of range/);
  });

  it('tamper counter (đổi số, cùng format) → PoW không đạt → invalid', () => {
    const fields = minted.stamp.split(':');
    const forgedCounter = `${fields[6]!}9`;
    const forged = [...fields.slice(0, 6), forgedCounter].join(':');
    const result = checkHashcash(forged, { resource: RESOURCE, now: NOW });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/proof of work/);
  });

  it('quá TTL mặc định 5 phút → invalid; trong hạn → valid', () => {
    const expired = checkHashcash(minted.stamp, {
      resource: RESOURCE,
      now: new Date(NOW.getTime() + 6 * 60 * 1000),
    });
    expect(expired.valid).toBe(false);
    if (!expired.valid) expect(expired.reason).toMatch(/expired/);

    const fresh = checkHashcash(minted.stamp, {
      resource: RESOURCE,
      now: new Date(NOW.getTime() + 60 * 1000),
    });
    expect(fresh.valid).toBe(true);
  });

  it('ttlMs tùy chỉnh được tôn trọng', () => {
    const result = checkHashcash(minted.stamp, {
      resource: RESOURCE,
      now: new Date(NOW.getTime() + 2 * 60 * 1000),
      ttlMs: 60 * 1000,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/expired/);
  });

  it('timestamp tương lai quá skew 60s → invalid', () => {
    const future = mintHashcash(RESOURCE, {
      bits: 8,
      now: new Date(NOW.getTime() + 10 * 60 * 1000),
    })!;
    const result = checkHashcash(future.stamp, { resource: RESOURCE, now: NOW });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/future/);
  });

  it('timestamp sai format / sai phạm vi giá trị → invalid', () => {
    const fields = minted.stamp.split(':');
    const badFormat = ['1', '8', '20261122', ...fields.slice(3)].join(':');
    expect(checkHashcash(badFormat, { resource: RESOURCE, now: NOW }).valid).toBe(false);
    const badMonth = ['1', '8', '20269922000000'.slice(0, 14), ...fields.slice(3)].join(':');
    expect(checkHashcash(badMonth, { resource: RESOURCE, now: NOW }).valid).toBe(false);
  });

  it('rand không đúng 16 alphanumeric → invalid', () => {
    const fields = minted.stamp.split(':');
    const forged = [...fields.slice(0, 5), 'short', fields[6]!].join(':');
    const result = checkHashcash(forged, { resource: RESOURCE, now: NOW });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/rand/);
  });

  it('valid:true trả info đầy đủ để log/audit', () => {
    const result = checkHashcash(minted.stamp, { resource: RESOURCE, now: NOW });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.info).toMatchObject({
        version: '1',
        bits: 8,
        timestamp: '20261122000000',
        resource: RESOURCE,
        ext: '',
        rand: 'AbCdEf0123456789',
      });
      expect(result.info.stamp).toBe(minted.stamp);
    }
  });
});

function hashLeadingNibblesStamp(stamp: string): number {
  const hex = createHash('sha3-256').update(stamp, 'utf8').digest('hex');
  return hashcashLeadingZeroNibbles(hex);
}
