import { execFileSync } from 'child_process';
import fs from 'fs';
import * as path from 'path';
import type { AgentMiddleware, MiddlewareContext } from '../middleware/types.js';

/**
 * Parse a shell-style command string into argv array for execFile.

 */
function tokenizeCommand(cmd: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if ((ch === ' ' || ch === '\t') && cur) {
      tokens.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Chờ `ms` mili-giây theo kiểu ĐỒNG BỘ.
 *
 * Chỉ dùng trong `execGit` — hàm đó không thể `await` vì phải giữ nguyên chữ ký
 * đồng bộ cho các caller (`createSafePoint`, ...). `Atomics.wait` chặn thread
 * hiện tại; dùng ở đây chấp nhận được vì đây là đường retry ngắn, không nằm
 * trong vòng lặp UI.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

export class GitSafePointManager {
  private static readonly LOCK_TIMEOUT_MS = 10000;

  public static checkAndReleaseLock(cwd: string): void {
    const lockPath = path.join(cwd, '.git', 'index.lock');
    try {
      if (fs.existsSync(lockPath)) {
        const stats = fs.statSync(lockPath);
        const age = Date.now() - stats.mtimeMs;
        if (age > this.LOCK_TIMEOUT_MS) {
          fs.unlinkSync(lockPath);
          console.warn(`[GitSafePoint] Auto-deleted orphaned Git lock file: ${lockPath}`);
        }
      }
    } catch {
      // Bỏ qua lỗi truy cập file
    }
  }

  public static execGit(cmd: string, cwd: string, retries = 5, delay = 100): string {
    const argv = tokenizeCommand(cmd);
    const program = argv[0];
    if (program === undefined) {
      throw new Error('Empty git command');
    }
    const args = argv.slice(1);
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < retries; attempt++) {
      this.checkAndReleaseLock(cwd);
      try {
        return execFileSync(program, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (lastError.message.includes('lock')) {
          const backoff = delay * Math.pow(2, attempt);
          // `execGit` là HÀM ĐỒNG BỘ (dùng execFileSync) nên không `await` được.
          // Trước đây `sleep(backoff)` không await — Promise bị bỏ đi, retry chạy
          // liền nhau trong vài chục ms thay vì hàng giây, tức là toàn bộ backoff
          // vô nghĩa, đúng cái race giữa các agent mà module này sinh ra để chống.
          // `Atomics.wait` là cách chờ đồng bộ duy nhất ở đây.
          sleepSync(backoff);
          continue;
        }
        throw lastError;
      }
    }
    throw new Error(
      `Git command failed after ${retries} attempts: ${cmd}. Error: ${lastError?.message}`,
    );
  }

  public static createSafePoint(cwd: string): boolean {
    try {
      try {
        this.execGit('git rev-parse --is-inside-work-tree', cwd);
      } catch {
        return false;
      }

      const status = this.execGit('git status --porcelain', cwd).trim();
      if (!status) {
        return false;
      }

      this.execGit('git add -A', cwd);
      this.execGit(`git commit -m ${shellEscape('ghita-temp-safepoint')} --no-verify`, cwd);

      this.logGitAction(cwd, 'CREATE_SAFEPOINT', 'Created temporary safepoint successfully');
      return true;
    } catch (err: unknown) {
      console.warn(
        `[GitSafePoint] Failed to create safe-point: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  public static rollback(cwd: string): boolean {
    try {
      try {
        this.execGit('git rev-parse --is-inside-work-tree', cwd);
      } catch {
        return false;
      }

      const lastCommitMsg = this.execGit('git log -1 --pretty=%s', cwd).trim();

      if (lastCommitMsg === 'ghita-temp-safepoint') {
        this.execGit('git reset --hard HEAD~1', cwd);
        this.execGit('git clean -fd', cwd);
        this.logGitAction(cwd, 'ROLLBACK', 'Hard rollbacked ghita-temp-safepoint successfully');
        return true;
      } else {
        this.execGit('git reset --hard HEAD', cwd);
        this.execGit('git clean -fd', cwd);
        this.logGitAction(cwd, 'ROLLBACK', 'Cleaned working directory (no safepoint found)');
        return true;
      }
    } catch (err: unknown) {
      console.error(
        `[GitSafePoint] Rollback failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private static logGitAction(cwd: string, action: string, detail: string): void {
    try {
      const logDir = path.join(cwd, '.ghita');
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      const logPath = path.join(logDir, 'git-rollback.log');
      const timestamp = new Date().toISOString();
      const logMsg = `[${timestamp}] [${action}] ${detail}\n`;
      fs.appendFileSync(logPath, logMsg, 'utf8');
    } catch {
      // Tránh crash nếu ghi log lỗi
    }
  }
}

export class GitSafePointMiddleware implements AgentMiddleware {
  readonly name = 'GitSafePointMiddleware';
  readonly priority = 5;

  private activeSafepoints = new Set<string>();

  async preTool(
    toolName: string,
    _args: Record<string, unknown>,
    _context: MiddlewareContext,
  ): Promise<{ proceed: boolean; reason?: string } | void> {
    const writeTools = [
      'writeFile',
      'write_to_file',
      'replace_file_content',
      'multi_replace_file_content',
    ];
    if (!writeTools.includes(toolName)) return;

    const cwd = process.cwd();
    if (!this.activeSafepoints.has(cwd)) {
      const created = GitSafePointManager.createSafePoint(cwd);
      if (created) {
        this.activeSafepoints.add(cwd);
      }
    }
    return { proceed: true };
  }

  async postTool(
    toolName: string,
    result: string,
    _context: MiddlewareContext,
  ): Promise<{ modifiedResult?: string } | void> {
    if (toolName !== 'run_command' && toolName !== 'runCommand') return;

    const errorKeywords = [
      'test failed',
      'tests failed',
      'compile error',
      'compilation failed',
      'vitest failed',
      'build failed',
      'typecheck failed',
      'exit code 1',
      'exit code 2',
      'exit status 1',
      'exit status 2',
      'failed with exit code',
      'npm err!',
      'command failed',
    ];

    const lowerResult = result.toLowerCase();
    const hasError = errorKeywords.some((keyword) => lowerResult.includes(keyword));

    if (hasError) {
      const cwd = process.cwd();
      const rolledBack = GitSafePointManager.rollback(cwd);
      this.activeSafepoints.delete(cwd);

      if (rolledBack) {
        return {
          modifiedResult: `[GIT SAFE-ROLLBACK GATES ACTIVATED]\nBiên dịch hoặc kiểm thử bị lỗi đỏ. Hệ thống tự động kích hoạt chế độ khôi phục (Hard Rollback) đưa mã nguồn về trạng thái an toàn gần nhất để phòng tránh hỏng hóc.\nKết quả lỗi terminal gốc:\n${result}`,
        };
      }
    }
  }

  async onError(error: Error, _context: MiddlewareContext): Promise<{ retry?: boolean } | void> {
    const cwd = process.cwd();
    GitSafePointManager.rollback(cwd);
    this.activeSafepoints.delete(cwd);
    console.warn(`[GitSafePointMiddleware] Auto-rollback triggered by exception: ${error.message}`);
  }
}
