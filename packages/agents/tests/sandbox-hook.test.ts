// Track R2 (P4): e2e nhỏ — agent chạy code qua hook `runInSandbox` (strict
// profile) → code ghi file cấm → overlay rollback sạch, workspace không đổi.
// Native addon thật (ghita-sandbox); thiếu addon → skip (fallback-js không có
// overlay, ghi thật vào cwd).

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxRunner, resolveSandboxPolicy } from '@ghita/security';
import {
  createRunInSandbox,
  createDefaultBlockRegistry,
  GraphExecutor,
  type GraphDefinition,
} from '../src/index.js';

/**
 * Native addon probe qua chính SandboxRunner (không import @ghita/native-bridge
 * trực tiếp — nó không phải dependency của @ghita/agents): enforcement khác
 * 'fallback-js' nghĩa là addon ghita-sandbox đã được load thật.
 */
async function nativeAvailable(): Promise<boolean> {
  try {
    const result = await new SandboxRunner().run(process.execPath, ['-v']);
    return result.enforcement !== 'fallback-js';
  } catch {
    return false;
  }
}

describe('runInSandbox hook → ghita-sandbox (Track R2 e2e)', () => {
  it('rolls back forbidden writes under strict profile — workspace stays clean', async () => {
    if (!(await nativeAvailable())) {
      console.warn('skip: ghita-sandbox native addon not available');
      return;
    }
    const workspace = mkdtempSync(join(tmpdir(), 'ghita-r2-e2e-'));
    try {
      writeFileSync(join(workspace, 'input.txt'), 'golden content', 'utf-8');
      const results: unknown[] = [];
      const runInSandbox = createRunInSandbox({
        workspace,
        policy: { profile: 'strict', timeoutMs: 30_000 },
        onResult: (r) => results.push(r),
      });

      // Code "cấm": ghi file mới + ghi đè file có sẵn bằng write API trực tiếp
      // (không dính precheck redirect) — phải bị rollback toàn bộ.
      const stdout = await runInSandbox(
        "const fs=require('fs');" +
          "fs.writeFileSync('forbidden.txt','dirty');" +
          "fs.writeFileSync('input.txt','OVERWRITTEN');" +
          "console.log('writes done:', fs.existsSync('forbidden.txt'));",
      );

      expect(stdout).toContain('writes done: true');
      expect(existsSync(join(workspace, 'forbidden.txt'))).toBe(false);
      expect(readFileSync(join(workspace, 'input.txt'), 'utf-8')).toBe('golden content');

      const result = results[0] as {
        blocked: boolean;
        enforcement: string;
        overlayDir?: string | null;
        overlayCommitted?: boolean;
        state?: string;
      };
      expect(result.blocked).toBe(false);
      expect(result.enforcement).not.toBe('fallback-js');
      expect(result.overlayDir).toBeTruthy();
      expect(result.overlayCommitted).toBe(false);
      expect(result.state).toBe('completed');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  it('denyGlobs từ policy config chặn path arg trước khi spawn', async () => {
    if (!(await nativeAvailable())) {
      console.warn('skip: ghita-sandbox native addon not available');
      return;
    }
    const workspace = mkdtempSync(join(tmpdir(), 'ghita-r2-deny-'));
    try {
      // denyGlobs đến từ policy config qua resolveSandboxPolicy (cùng đường
      // mà createRunInSandbox dùng) — precheck chặn argv path-like trước spawn.
      const runner = new SandboxRunner(
        resolveSandboxPolicy({ profile: 'strict', denyGlobs: ['**/*.secret'] }, false),
      );
      const secretPath = process.platform === 'win32' ? 'keys\\api.secret' : 'keys/api.secret';
      const res =
        process.platform === 'win32'
          ? await runner.run('cmd.exe', ['/C', 'type', secretPath])
          : await runner.run('cat', [secretPath]);

      expect(res.blocked).toBe(true);
      expect(res.violations.some((v) => v.reason === 'deny-glob')).toBe(true);
      expect(res.exitCode ?? null).toBeNull();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  it('resolveSandboxPolicy merge default deny globs với config (không cần addon)', () => {
    const merged = resolveSandboxPolicy({ profile: 'strict', denyGlobs: ['**/*.secret'] });
    expect(merged.denyGlobs).toContain('**/*.secret');
    expect(merged.denyGlobs).toContain('**/.ssh/**');
    expect(merged.profile).toBe('strict');
    const only = resolveSandboxPolicy({ profile: 'workspace', denyGlobs: ['**/*.secret'] }, false);
    expect(only.denyGlobs).toEqual(['**/*.secret']);
  });

  it('wires through code_sandbox block end-to-end (GraphExecutor)', async () => {
    if (!(await nativeAvailable())) {
      console.warn('skip: ghita-sandbox native addon not available');
      return;
    }
    const workspace = mkdtempSync(join(tmpdir(), 'ghita-r2-block-'));
    try {
      const runInSandbox = createRunInSandbox({
        workspace,
        policy: { profile: 'strict', timeoutMs: 30_000 },
      });
      const executor = new GraphExecutor(createDefaultBlockRegistry(), { runInSandbox });

      // Graph tối giản: input (entry, không nối tiếp — validation yêu cầu
      // ≥1 input node) → code_sandbox (code qua inputDefault) → output.
      const graph: GraphDefinition = {
        id: 'graph-r2-e2e',
        name: 'r2-e2e',
        version: 1,
        nodes: [
          { id: 'in', blockName: 'input', inputDefault: {} },
          {
            id: 'sbx',
            blockName: 'code_sandbox',
            inputDefault: {
              code:
                "const fs=require('fs');" +
                "fs.mkdirSync('nested',{recursive:true});" +
                "fs.writeFileSync('nested/leak.txt','x');",
            },
          },
          { id: 'out', blockName: 'output', inputDefault: {} },
        ],
        links: [{ source: 'sbx', sourceOutput: 'output', sink: 'out', sinkInput: 'value' }],
      };

      const res = await executor.execute(graph);

      expect(res.status).toBe('completed');
      expect(existsSync(join(workspace, 'nested'))).toBe(false);
      expect(existsSync(join(workspace, 'nested', 'leak.txt'))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);
});
