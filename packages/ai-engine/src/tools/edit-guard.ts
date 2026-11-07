// Track 3 — Edit không hỏng file (pattern nguồn: oh-my-pi pi-edit MIT +
// grok-build workspace checkpoint Apache-2.0 — học pattern, tự viết lại).
//
// Ba lớp bảo vệ:
//   1. Tag hash `[path#TAG]` (oh-my-pi): read in ra tag 4-hex của nội dung;
//      edit kèm tag lệch là bị chặn trước khi hỏng file.
//   2. Stale-tag recovery: tag lệch nhưng khối tìm kiếm vẫn khớp file hiện
//      tại → vẫn áp dụng kèm cảnh báo; không khớp → lỗi nêu rõ expected/
//      actual tag kèm vị trí gần nhất.
//   3. Checkpoint trước/sau mỗi lần ghi (grok-build): mọi ghi file qua
//      searchReplaceBatch đi qua checkpoint; rollback khôi phục nguyên trạng.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** FNV-1a 32-bit, tính trên từng dòng đã trim đuôi (oh-my-pi store.rs pattern). */
export function fileHashTag(content: string): string {
  // P1 fix: normalize CRLF -> LF TRUOC khi hash — read va edit phai cung
  // mot nen (Windows/git autocrlf) neu khong tag tu read luon lech guard.
  const normalized = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').toUpperCase().slice(0, 4);
}

/** Header tag cho output của tool read: `[path#TAG]`. */

/** Header tag cho output của tool read: [path#TAG]. */
export function withTagHeader(relPath: string, content: string): string {
  const tag = fileHashTag(content);
  return `[${relPath}#${tag}]\n${content}`;
}

/**
 * Ghi file nguyên tử: ghi file tạm cạnh đích rồi rename. Gián đoạn nguồn
 * (crash, mất điện) không bao giờ để lại file nửa chừng — rename là nguyên
 * tử trên cùng một đĩa.
 */
export function atomicWriteFileSync(fullPath: string, content: string): void {
  const tmp = `${fullPath  }.ghita-tmp-${  String(process.pid)}`;
  writeFileSync(tmp, content, 'utf8');
  try {
    renameSync(tmp, fullPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // không xóa được tmp thì bỏ qua — lỗi rename mới là thứ đáng báo
    }
    throw err;
  }
}

/**
 * Bảng chuyển tag: nếu edit kèm tag đã cũ, thử tìm lại khối tìm kiếm trong
 * file hiện tại; thấy thì vẫn áp dụng (kèm cảnh báo), không thấy thì chặn.
 */
export interface TagGuardResult {
  ok: boolean;
  recovered?: boolean;
  expectedTag?: string;
  actualTag?: string;
  error?: string;
}

export function checkTagGuard(
  currentContent: string,
  expectedTag: string | undefined,
): TagGuardResult {
  const actualTag = fileHashTag(currentContent);
  if (expectedTag === undefined) {
    return { ok: true, actualTag };
  }
  if (expectedTag === actualTag) {
    return { ok: true, actualTag };
  }
  return {
    ok: false,
    recovered: false,
    expectedTag,
    actualTag,
    error:
      `Tag stale: file đã đổi ngoài tầm nhìn (người dùng sửa tay, tool khác ghi). ` +
      `Expected tag ${  expectedTag  } nhưng file hiện tại là ${  actualTag  }. ` +
      `Hãy đọc lại file rồi gửi lại edit với tag mới.`,
  };
}

/**
 * Checkpoint trước/sau mỗi lần ghi file (grok-build file_state pattern).
 * Mỗi run chụp nội dung TRƯỚC lần ghi đầu tiên của từng file vào
 * `.ghita/checkpoints/<runId>/` kèm manifest.json chứa đường dẫn tuyệt đối;
 * rollback đọc manifest + nội dung đã chụp để khôi phục nguyên trạng — kể cả
 * từ một tiến trình/session khác.
 */
export interface CheckpointManifestEntry {
  absPath: string;
  /** File không tồn tại trước run → rollback phải xoá nó. */
  absent: boolean;
  file: string;
}

export interface RollbackSummary {
  restored: number;
  deleted: number;
  missing: number;
}

export class FileEditCheckpointer {
  private readonly runId: string;
  private readonly root: string;

  constructor(runId: string, root?: string) {
    this.runId = runId;
    // P2 fix: root mặc định neo WORKSPACE ROOT (không theo CWD process) —
    // desktop set workspace khác cwd sidecar thì checkpoint vẫn đúng chỗ.
    const workspace = (globalThis as { ghitaWorkspaceRoot?: string }).ghitaWorkspaceRoot;
    this.root = root ?? join(workspace ?? process.cwd(), '.ghita', 'checkpoints');
  }

  private runDir(): string {
    return join(this.root, this.runId);
  }

  /** Chụp ảnh TRƯỚC lần ghi đầu tiên của file trong run (idempotent). */
  captureBefore(fullPath: string): void {
    const dir = this.runDir();
    mkdirSync(dir, { recursive: true });
    const manifestPath = join(dir, 'manifest.json');
    const manifest: CheckpointManifestEntry[] = existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as CheckpointManifestEntry[])
      : [];
    if (manifest.some((entry) => entry.absPath === fullPath)) return;

    const absent = !existsSync(fullPath);
    const slot = String(manifest.length).padStart(4, '0');
    const file = absent ? '' : `${slot  }.before`;
    if (!absent) {
      writeFileSync(join(dir, file), readFileSync(fullPath, 'utf8'), 'utf8');
    }
    manifest.push({ absPath: fullPath, absent, file });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  /** Rollback run này: khôi phục/xoá file về trạng thái trước run. */
  rollback(): RollbackSummary {
    const dir = this.runDir();
    if (!existsSync(dir)) return { restored: 0, deleted: 0, missing: 0 };
    const manifestPath = join(dir, 'manifest.json');
    const manifest: CheckpointManifestEntry[] = existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as CheckpointManifestEntry[])
      : [];
    let restored = 0;
    let deleted = 0;
    let missing = 0;
    for (const entry of manifest) {
      if (entry.absent) {
        if (existsSync(entry.absPath)) {
          unlinkSync(entry.absPath);
          deleted += 1;
        } else {
          missing += 1;
        }
        continue;
      }
      const contentPath = join(dir, entry.file);
      if (!existsSync(contentPath)) {
        missing += 1;
        continue;
      }
      atomicWriteFileSync(entry.absPath, readFileSync(contentPath, 'utf8'));
      restored += 1;
    }
    return { restored, deleted, missing };
  }
}

/** Dọn checkpoint cũ, giữ lại `keep` run mới nhất (theo tên runId tăng dần). */
export function pruneCheckpoints(root = '.ghita/checkpoints', keep = 20): number {
  if (!existsSync(root)) return 0;
  const runs = readdirSync(root)
    .filter((name) => existsSync(join(root, name, 'manifest.json')))
    .sort();
  const removable = runs.slice(0, Math.max(0, runs.length - keep));
  for (const name of removable) {
    rmSync(join(root, name), { recursive: true, force: true });
  }
  return removable.length;
}

/**
 * (7.1) PathPolicy — xác thực path TRƯỚC KHI sửa (oh-my-pi path_policy +
 * quy tắc Windows của grok-build: cấm path verbatim \?\ và URI scheme lạ).
 * ensureInSandbox chặn thoát sandbox; PathPolicy chặn dạng path rác mà
 * sandbox không bắt.
 */
export function assertEditablePath(rawPath: string): void {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new Error('PathPolicy: đường dẫn rỗng.');
  }
  // Windows drive (C:/, C:\) KHÔNG phải URI scheme — cho qua.
  const drive = /^[a-zA-Z]:[\\\\/]/;
  if (!drive.test(rawPath)) {
    const uri = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
    if (uri.test(rawPath)) {
      throw new Error(`PathPolicy: từ chối URI scheme (${  JSON.stringify(rawPath)  }) — dùng đường dẫn tương đối trong workspace.`);
    }
  }
  const VERBATIM = String.fromCharCode(92, 92, 63, 92);
  if (rawPath.includes(VERBATIM) || rawPath.startsWith(VERBATIM)) {
    throw new Error('PathPolicy: từ chối path verbatim Windows — dùng path thường.');
  }
  if (rawPath.includes(String.fromCharCode(0))) {
    throw new Error('PathPolicy: path chứa byte null.');
  }
  if (/[‪-‮⁦-⁩]/.test(rawPath)) {
    throw new Error('PathPolicy: path chứa ký tự bidi/đảo chiều hiển thị.');
  }
}

/**
 * (7.3) API snapshot/undo: liệt kê các run checkpoint còn giữ (cũ → mới) và
 * đọc nội dung TRƯỚC của một file trong run — phục vụ nút Undo của UI.
 */
export function listCheckpointRuns(root = '.ghita/checkpoints'): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => existsSync(join(root, name, 'manifest.json')))
    .sort();
}

export function snapshotOf(
  runId: string,
  absPath: string,
  root = '.ghita/checkpoints',
): string | undefined {
  const manifestPath = join(root, runId, 'manifest.json');
  if (!existsSync(manifestPath)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Array<{
      absPath: string;
      absent: boolean;
      file: string;
    }>;
    const entry = manifest.find((e) => e.absPath === absPath);
    if (!entry || entry.absent || entry.file.length === 0) return undefined;
    const contentPath = join(root, runId, entry.file);
    return existsSync(contentPath) ? readFileSync(contentPath, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}
