// Sửa mojibake: text UTF-8 bị đọc sai theo cp1252 rồi lưu lại thành UTF-8.
//
// Bốn lớp an toàn — vì script này GHI ĐÈ file thật, sai một lần là mất code:
//   1. CHỈ sửa đoạn trông như mojibake (ký tự dẫn đầu + ký tự kế tiếp nằm trong
//      0x80–0xBF). Nhờ vậy `Ärger` (tiếng Đức) và `É©` (tiếng Pháp) được giữ
//      nguyên, còn `Ã¡` (tiếng Việt mã hoá sai) thì được sửa.
//   2. Kết quả repair phải hợp lệ: không ký tự thay thế, không ký tự điều
//      khiển C0 lẫn C1.
//   3. Mặc định CHỈ XEM; `--write` mới ghi, và luôn tạo bản `.bak`.
//   4. Lặp tới khi ổn định (mojibake 2 tầng cần 2 lượt), có giới hạn.
//
// Chạy: node scripts/fix-mojibake.mjs <file> [--write]

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

// cp1252: byte 0x80-0x9F → ký tự Unicode riêng. Bản đồ ngược (char → byte).
const CP1252_REVERSE = new Map([
  [0x20ac, 0x80],
  [0x0081, 0x81],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8d],
  [0x008e, 0x8e],
  [0x017f, 0x8f],
  [0x0090, 0x90],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x009d, 0x9d],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

/** Ký tự mở đầu một chuỗi mojibake kiểu cp1252. */
const MOJIBAKE_LEADS = new Set([0x00c2, 0x00c3, 0x00c4, 0x00e2, 0x00f0, 0x00d0, 0x00d1, 0x00ef]);

/** Một ký tự Unicode → byte cp1252 tương ứng, hoặc null nếu không mã hoá được. */
function toCp1252Byte(cp) {
  const special = CP1252_REVERSE.get(cp);
  if (special !== undefined) return special;
  if (cp <= 0xff) return cp; // vùng latin1 giữ nguyên
  return null;
}

/** Ký tự điều khiển: C0 (0x00–0x1F), DEL, và C1 (0x80–0x9F). */
function hasControl(str) {
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) return true;
    if (c >= 0x80 && c <= 0x9f) return true;
  }
  return false;
}

/**
 * Đoạn này CÓ trông như mojibake không?
 *
 * Quy tắc: ký tự đầu phải là ký tự dẫn đầu cp1252, VÀ ký tự ngay sau nó
 * phải rơi vào 0x80–0xBF. Điều kiện thứ hai mới là chốt chặn quan trọng:
 *   • `Ã¡`    = Ã (lead) + ¡ (0xA1) → mojibake của `á`   ✔ sửa
 *   • `Ärger` = Ä (lead) + r (0x72) → tiếng Đức bình thường ✖ giữ
 *   • `É©`    = É (KHÔNG phải lead)   → tiếng Pháp bình thường ✖ giữ
 */
function looksLikeMojibake(run) {
  const chars = [...run];
  if (chars.length < 2) return false;
  const first = chars[0].codePointAt(0);
  if (!MOJIBAKE_LEADS.has(first)) return false;
  const second = chars[1].codePointAt(0);
  return second >= 0x80 && second <= 0xbf;
}

/** Thử repair một đoạn. Trả null nếu không sửa được hoặc KHÔNG phải mojibake. */
function repairRun(run) {
  if (!looksLikeMojibake(run)) return null;

  const bytes = [];
  for (const ch of run) {
    const b = toCp1252Byte(ch.codePointAt(0));
    if (b === null) return null; // có ký tự không thuộc cp1252 → không đụng
    bytes.push(b);
  }
  const fixed = Buffer.from(bytes).toString('utf8');
  if (fixed.includes('�')) return null; // UTF-8 hỏng
  if (hasControl(fixed)) return null; // repair sinh ký tự điều khiển → sai
  if (fixed === run) return null; // không thay đổi gì
  return fixed;
}

/** Một lượt repair toàn file. */
function repairPass(content) {
  const lines = content.split('\n');
  const samples = [];
  let repaired = 0;

  const outLines = lines.map((line, lineNo) => {
    const parts = line.match(/[^\x00-\x7F]+|[\x00-\x7F]+/g) ?? [];
    return parts
      .map((part) => {
        if (part.charCodeAt(0) < 128) return part; // thuần ASCII
        const fixed = repairRun(part);
        if (fixed === null) return part;
        repaired++;
        if (samples.length < 8) {
          samples.push({
            line: lineNo + 1,
            from: JSON.stringify(part),
            to: JSON.stringify(fixed),
          });
        }
        return fixed;
      })
      .join('');
  });

  return { content: outLines.join('\n'), repaired, samples };
}

const file = process.argv[2];
if (!file) {
  console.error('Dung: node scripts/fix-mojibake.mjs <file> [--write]');
  process.exit(1);
}

const shouldWrite = process.argv.includes('--write');

// Đọc dạng Buffer để CHẶN file nhị phân / UTF-8 hỏng thật trước khi đọc lossy:
// readFileSync(..., 'utf8') thay byte lỗi bằng U+FFFD im lặng, mà nếu có repair
// thì CẢ FILE bị ghi lại — những chỗ U+FFFD đó sẽ thành hỏng vĩnh viễn.
const raw = readFileSync(file);
const decoded = raw.toString('utf8');
if (decoded !== Buffer.from(decoded, 'utf8').toString()) {
  console.error(
    'DỪNG: file KHÔNG phải UTF-8 hợp lệ (hoặc là file nhị phân). ' +
      'Đọc lossy sẽ ghi đè phần hỏng thành U+FFFD vĩnh viễn — không sửa file này.',
  );
  process.exit(1);
}

const original = decoded;

let current = original;
let totalRepaired = 0;
const allSamples = [];

// Mojibake có thể nhiều tầng (copy từ nguồn đã hỏng 2 lần) — lặp tới khi ổn định.
for (let pass = 1; pass <= 3; pass++) {
  const result = repairPass(current);
  if (result.repaired === 0) break;
  totalRepaired += result.repaired;
  for (const s of result.samples) allSamples.push({ ...s, pass });
  current = result.content;
}

console.log(`File: ${file}`);
console.log(`  Đoạn đã sửa: ${totalRepaired}`);
console.log('  Đoạn còn lại là chữ thật (không đụng).');
if (allSamples.length) {
  console.log('\nMẫu đã sửa:');
  for (const s of allSamples) console.log(`  d${s.line} (lượt ${s.pass}) ${s.from} → ${s.to}`);
}

if (current === original) {
  console.log('\n✅ Không thay đổi gì — file đã sạch hoặc không có mojibake.');
  process.exit(0);
}

if (!shouldWrite) {
  console.log('\n(Chưa ghi. Xem lại kết quả ở trên, rồi chạy lại kèm --write nếu đúng.)');
  process.exit(0);
}

// Bản sao lưu trước khi ghi đè — script này có thể chạy trên file thật.
const backup = `${file}.bak`;
if (!existsSync(backup)) copyFileSync(file, backup);
writeFileSync(file, current, 'utf8');
console.log(`\nĐã ghi: ${file}`);
console.log(`Bản lưu:  ${backup}`);
