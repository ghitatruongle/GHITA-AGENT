// T3.1 (v0.0.1): native Windows screen capture without the screenshot-desktop
// npm package (removed: GHSA-mh99 build-time glob traversal advisory).
// Uses the bundled C# helper bat — same technique screenshot-desktop ran on
// Windows internally; compiles once to .exe via csc.exe, then cached.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pExecFile = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const BAT = join(here, 'screenCapture_1.3.2.bat');
const DEFAULT_TIMEOUT_MS = 15000; // first run compiles via csc.exe (slow, then cached)

/**
 * Capture the full screen to JPEG bytes (Windows only).
 * opts: { dir?, timeoutMs?, platform? } — platform injectable for tests.
 */
export async function captureScreenJpeg(opts = {}) {
  const { dir = tmpdir(), timeoutMs = DEFAULT_TIMEOUT_MS, platform = process.platform } = opts;
  if (platform !== 'win32') {
    throw new Error('native-screenshot: Windows only — bundled C# helper bat unavailable');
  }
  const out = join(dir, `ghita-shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);
  // cmd.exe wrapper: Node ≥18.20/20.12 requires shell for .bat spawning (CVE-2024-27980)
  await pExecFile('cmd.exe', ['/c', BAT, out], { timeout: timeoutMs, windowsHide: true });
  const buf = await fs.readFile(out);
  await fs.unlink(out).catch(() => {});
  return buf;
}
