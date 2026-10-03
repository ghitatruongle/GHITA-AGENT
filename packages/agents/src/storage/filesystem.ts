import { createHash } from 'node:crypto';
import type { StorageBackend, SerializedEntry } from './types.js';

export interface FileSystemStorageOptions {
  /** Directory path for storing files */
  basePath: string;
  /** File extension */
  extension?: string;
  /** TTL in milliseconds */
  ttl?: number;
}

export class FileSystemStorage<T = unknown> implements StorageBackend<T> {
  private readonly basePath: string;
  private readonly extension: string;
  private readonly ttl: number;

  constructor(options: FileSystemStorageOptions) {
    this.basePath = options.basePath;
    this.extension = options.extension ?? '.json';
    this.ttl = options.ttl ?? 0;
  }

  private filePath(key: string): string {
    // Thay ký tự lạ bằng `_` làm `user/name` và `user.name` cùng ra
    // `user_name` — hai key KHÁC NHAU ghi đè lên nhau, mất dữ liệu âm thầm.
    // Nên phần sanitize chỉ để đọc dễ, còn định danh thật là hash của key gốc.
    const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
    return `${this.basePath}/${safe}-${hash}${this.extension}`;
  }

  private isExpired(entry: SerializedEntry<T>): boolean {
    if (!entry.ttl || entry.ttl === 0) return false;
    return Date.now() - entry.timestamp > entry.ttl;
  }

  private async readEntry(key: string): Promise<SerializedEntry<T> | undefined> {
    try {
      // Uses dynamic import to avoid top-level fs dependency (works in both Node and edge)
      const fs = await import('node:fs/promises');
      const raw = await fs.readFile(this.filePath(key), 'utf-8');
      return JSON.parse(raw) as SerializedEntry<T>;
    } catch (error) {
      console.warn('[FileSystemStorage] Failed to read entry:', (error as Error).message);
      return undefined;
    }
  }

  private async writeEntry(key: string, entry: SerializedEntry<T>): Promise<void> {
    const fs = await import('node:fs/promises');
    await fs.mkdir(this.basePath, { recursive: true });
    await fs.writeFile(this.filePath(key), JSON.stringify(entry), 'utf-8');
  }

  async get(key: string): Promise<T | undefined> {
    const entry = await this.readEntry(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      await this.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: T): Promise<void> {
    await this.writeEntry(key, {
      key,
      value,
      timestamp: Date.now(),
      ttl: this.ttl,
    });
  }

  async delete(key: string): Promise<boolean> {
    try {
      const fs = await import('node:fs/promises');
      await fs.unlink(this.filePath(key));
      return true;
    } catch {
      return false;
    }
  }

  async has(key: string): Promise<boolean> {
    const entry = await this.readEntry(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      await this.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Danh sách key GỐC, đọc từ nội dung file chứ không phải từ tên file.
   *
   * Tên file đã được băm hoá nên không còn khôi phục được key; nếu cắ tên file
   * rồi trả về thì `delete(keys()[0])` sẽ băm lại một chuỗi KHÁC và xoá hụt —
   * đúng lỗi khiến `clear()` im lặng bỏ sót dữ liệu.
   */
  async keys(): Promise<string[]> {
    try {
      const fs = await import('node:fs/promises');
      const files = await fs.readdir(this.basePath);
      const out: string[] = [];
      for (const f of files) {
        if (!f.endsWith(this.extension)) continue;
        try {
          const raw = await fs.readFile(`${this.basePath}/${f}`, 'utf8');
          const parsed = JSON.parse(raw) as { key?: string };
          if (typeof parsed.key === 'string') out.push(parsed.key);
        } catch {
          // File hỏng: bỏ qua thay vì làm hỏng cả lệnh liệt kê.
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async clear(): Promise<void> {
    const keys = await this.keys();
    for (const key of keys) {
      await this.delete(key);
    }
  }

  async size(): Promise<number> {
    const keys = await this.keys();
    return keys.length;
  }
}
