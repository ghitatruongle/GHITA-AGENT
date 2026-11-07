import * as path from 'node:path';
import * as fs from 'node:fs';
import { FileEditCheckpointer, assertEditablePath, atomicWriteFileSync, withTagHeader } from './edit-guard.js';
import { diagnosticsAfterWrite } from './diagnostics.js';
import { spawn } from 'node:child_process';

// Declaring global workspace root for typescript awareness
declare global {
  var ghitaWorkspaceRoot: string | undefined;
  var approveCommandHandler: ((command: string) => Promise<boolean>) | null;
  var approveFileWriteHandler: ((operation: string, filePath: string) => Promise<boolean>) | null;
  var agentPermissionMode: 'custom' | 'auto';
}

// Global approval hook for terminal commands
globalThis.approveCommandHandler = globalThis.approveCommandHandler || null;
// Global approval hook for file write operations
globalThis.approveFileWriteHandler = globalThis.approveFileWriteHandler || null;
// Global permission mode: 'custom' = confirm everything, 'auto' = only dangerous ops
globalThis.agentPermissionMode = globalThis.agentPermissionMode || 'custom';

/**
 * Check if a command is considered dangerous (needs approval even in auto mode)
 */
function isDangerousCommand(command: string): boolean {
  const dangerousPatterns = [
    /npm\s+(install|uninstall|update|publish)/i,
    /pnpm\s+(add|install|remove|update|publish)/i,
    /yarn\s+(add|install|remove|publish)/i,
    /pip\s+(install|uninstall)/i,
    /cargo\s+(install|publish)/i,
    /curl\s+/i,
    /wget\s+/i,
    /git\s+(push|force|reset\s+--hard|clean|checkout\s+\.)/i,
    /rm\s+-rf/i,
    /chmod\s+777/i,
    /sudo\s+/i,
    /docker\s+(run|pull|push)/i,
    /ssh\s+/i,
    /scp\s+/i,
    /format\s+/i,
    /del\s+\/[sfq]/i,
  ];
  return dangerousPatterns.some((p) => p.test(command));
}

/**
 * Tokenize a shell-style command line, respecting single quotes, double quotes,
 * and backslash escapes. Returns an array of arguments (whitespace-separated
 * tokens with quoting stripped). Throws on unterminated quotes.
 *
 * Examples:
 *   `echo hello`                    -> ['echo', 'hello']
 *   `echo "hello world"`            -> ['echo', 'hello world']
 *   `git log --pretty=format:'%H'`  -> ['git', 'log', '--pretty=format:&#37;H']
 *   `cmd "a\"b"`                    -> ['cmd', 'a"b']
 */
export function tokenizeShellCommand(input: string): string[] {
  // Reject unsupported shell constructs that could execute arbitrary code
  if (input.includes('`') || input.includes("$'") || input.includes('$(')) {
    throw new Error(
      'Unsupported shell syntax detected: backticks, command substitution ($()), or ANSI-C quotes are not allowed.',
    );
  }
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === '\\' && i + 1 < input.length) {
        // Backslash escapes the next char inside double quotes (preserves it literally)
        const next = input[i + 1];
        if (next === '"' || next === '\\' || next === '$' || next === '`' || next === '\n') {
          current += next;
          i += 1;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasToken = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasToken = true;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      // Backslash escapes the next char outside any quotes
      current += input[i + 1];
      i += 1;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }

  if (inSingle || inDouble) {
    throw new Error('Unterminated quote in command');
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/**
 * Validates that the targeted path lies inside the workspace sandbox
 */
export function ensureInSandbox(filePath: string, sandboxRoot?: string): string {
  const root = sandboxRoot || globalThis.ghitaWorkspaceRoot || process.env.GHITA_WORKSPACE;
  if (!root) {
    throw new Error('No active workspace directory set. Please select a workspace folder first.');
  }
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Workspace sandbox does not exist or is not a directory: "${resolvedRoot}".`);
  }
  const canonicalRoot = fs.realpathSync.native(resolvedRoot);
  // If absolute path, resolve directly; if relative, resolve relative to resolvedRoot
  const resolvedPath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(resolvedRoot, filePath);

  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(
      `Security Exception: Access denied. Path "${resolvedPath}" lies outside the active workspace sandbox "${resolvedRoot}".`,
    );
  }

  // Lexical containment is insufficient when a workspace entry is a symlink or
  // junction pointing outside the workspace. Resolve the target itself when it
  // exists, otherwise resolve its nearest existing ancestor before any write.
  let existingAncestor = resolvedPath;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const canonicalAncestor = fs.realpathSync.native(existingAncestor);
  const canonicalRelative = path.relative(canonicalRoot, canonicalAncestor);
  if (
    canonicalRelative === '..' ||
    canonicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(canonicalRelative)
  ) {
    throw new Error(
      `Security Exception: Access denied. Path "${resolvedPath}" escapes the workspace through a symbolic link or junction.`,
    );
  }
  return resolvedPath;
}

/**
 * 1. list_dir tool implementation
 */
const LIST_DIR_MAX_ENTRIES = 500;

export async function listDirectory(args: { recursive?: boolean; path?: string }): Promise<string> {
  const targetDir = args.path ? ensureInSandbox(args.path) : ensureInSandbox('.');

  interface FileEntry {
    path: string;
    isDirectory: boolean;
    size?: number;
  }

  const results: FileEntry[] = [];
  let truncated = false;
  // Resolve the sandbox root once — the old loop re-ran existsSync/statSync/
  // realpathSync for EVERY entry just to compute a relative path.
  const sandboxRoot = ensureInSandbox('.');

  function walk(currentDir: string, depth = 0) {
    if (results.length >= LIST_DIR_MAX_ENTRIES || (args.recursive && depth > 12)) {
      truncated = true;
      return;
    }
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= LIST_DIR_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const fullPath = path.join(currentDir, entry.name);
      // Skip typical noise folders
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === 'dist' ||
        entry.name === '.turbo' ||
        entry.name === 'build' ||
        entry.name === '.cxx'
      ) {
        continue;
      }

      const relPath = path.relative(sandboxRoot, fullPath);

      if (entry.isDirectory()) {
        results.push({ path: relPath, isDirectory: true });
        if (args.recursive) {
          walk(fullPath, depth + 1);
        }
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        results.push({ path: relPath, isDirectory: false, size: stat.size });
      }
    }
  }

  walk(targetDir);
  // Compact JSON — pretty-printing a multi-entry listing multiplied the
  // payload shipped into the LLM context.
  const suffix = truncated
    ? `\n[Truncated at ${LIST_DIR_MAX_ENTRIES} entries — narrow the path or drop "recursive".]`
    : '';
  return JSON.stringify(results) + suffix;
}

/**
 * 2. read_file tool implementation
 */

// frontend uses. Without this an agent reading a huge file would OOM the
// sidecar; the cap mirrors the editor's truncated-preview behaviour.
const READ_FILE_MAX_BYTES = 5 * 1024 * 1024;

export async function readFile(args: {
  filePath: string;
  startLine?: number;
  endLine?: number;
}): Promise<string> {
  const fullPath = ensureInSandbox(args.filePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${args.filePath}`);
  }

  const stat = fs.statSync(fullPath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${args.filePath}`);
  }
  if (stat.size > READ_FILE_MAX_BYTES) {
    throw new Error(
      `File too large to read (${stat.size} bytes, max ${READ_FILE_MAX_BYTES}). ` +
        `Use grep_search or ask the user to split the file.`,
    );
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  // Track 3.1 — header [path#TAG] (oh-my-pi): model edit bằng tag này; tag
  // hash TOÀN BỘ file kể cả khi read theo dải dòng, vì edit đụng cả file.
  const relForTag = path.relative(ensureInSandbox('.'), fullPath);
  const tagged = withTagHeader(relForTag, content);
  if (args.startLine === undefined && args.endLine === undefined) {
    return tagged;
  }

  const lines = content.split('\n');
  const start = Math.max(1, args.startLine ?? 1);
  const end = Math.min(lines.length, args.endLine ?? lines.length);

  const extractedLines = lines.slice(start - 1, end);
  return `${tagged.split('\n')[0]  }\n${  extractedLines.join('\n')}`;
}

/**
 * 3. write_file tool implementation
 */
export async function writeFile(args: { filePath: string; content: string }): Promise<string> {
  assertEditablePath(args.filePath);
  const fullPath = ensureInSandbox(args.filePath);
  const relPath = path.relative(ensureInSandbox('.'), fullPath);

  // In custom mode, ask for approval before writing
  if (globalThis.agentPermissionMode === 'custom' && globalThis.approveFileWriteHandler) {
    const approved = await globalThis.approveFileWriteHandler('write', relPath);
    if (!approved) {
      throw new Error(`Permission Denied: User rejected writing to "${relPath}".`);
    }
  }

  const parentDir = path.dirname(fullPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // Track 3.3/3.4 — checkpoint + ghi nguyên tử.
  const checkpointer = new FileEditCheckpointer(`auto-${  Date.now().toString(36)}`);
  checkpointer.captureBefore(fullPath);
  atomicWriteFileSync(fullPath, args.content);
  const diagnosticsNote = await diagnosticsAfterWrite(relPath);
  return `File written successfully to ${relPath}${  diagnosticsNote ? ` — ${  diagnosticsNote}` : ''}`;
}

/**
 * 4. replace_file_content tool implementation
 */
export async function replaceFileContent(args: {
  filePath: string;
  targetContent: string;
  replacementContent: string;
}): Promise<string> {
  assertEditablePath(args.filePath);
  const fullPath = ensureInSandbox(args.filePath);
  const relPath = path.relative(ensureInSandbox('.'), fullPath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${args.filePath}`);
  }

  // In custom mode, ask for approval before modifying
  if (globalThis.agentPermissionMode === 'custom' && globalThis.approveFileWriteHandler) {
    const approved = await globalThis.approveFileWriteHandler('modify', relPath);
    if (!approved) {
      throw new Error(`Permission Denied: User rejected modifying "${relPath}".`);
    }
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  if (!content.includes(args.targetContent)) {
    throw new Error(
      'Target content not found in file. Please specify target content matching lines in the file exactly.',
    );
  }

  // Verify target is unique to avoid wrong replacement
  const firstIndex = content.indexOf(args.targetContent);
  const lastIndex = content.lastIndexOf(args.targetContent);
  if (firstIndex !== lastIndex) {
    throw new Error(
      'Multiple occurrences of target content found. Please provide a more unique target block (include surrounding lines).',
    );
  }

  const newContent =
    content.substring(0, firstIndex) +
    args.replacementContent +
    content.substring(firstIndex + args.targetContent.length);
  // Track 3.3/3.4 — checkpoint + ghi nguyên tử.
  const checkpointer2 = new FileEditCheckpointer(`auto-${  Date.now().toString(36)}`);
  checkpointer2.captureBefore(fullPath);
  atomicWriteFileSync(fullPath, newContent);

  const diagnosticsNote2 = await diagnosticsAfterWrite(relPath);
  return `Successfully replaced content in ${relPath}${  diagnosticsNote2 ? ` — ${  diagnosticsNote2}` : ''}`;
}

/**
 * 5. grep_search tool implementation
 */
export async function grepSearch(args: { query: string }): Promise<string> {
  const sandbox = ensureInSandbox('.');

  interface Match {
    file: string;
    line: number;
    content: string;
  }

  const matches: Match[] = [];

  function search(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === 'dist' ||
        entry.name === '.turbo' ||
        entry.name === 'build' ||
        entry.name === '.cxx'
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        search(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        // Search text-like files only
        if (
          [
            '.ts',
            '.tsx',
            '.js',
            '.jsx',
            '.json',
            '.html',
            '.css',
            '.md',
            '.txt',
            '.yaml',
            '.yml',
            '.toml',
            '.mjs',
            '.cjs',
          ].includes(ext)
        ) {
          const content = fs.readFileSync(fullPath, 'utf8');
          if (content.includes(args.query)) {
            const lines = content.split(/\r?\n/);
            lines.forEach((lineContent, index) => {
              if (lineContent.includes(args.query)) {
                matches.push({
                  file: path.relative(sandbox, fullPath),
                  line: index + 1,
                  content: lineContent.trim(),
                });
              }
            });
          }
        }
      }
    }
  }

  search(sandbox);
  return JSON.stringify(matches.slice(0, 50), null, 2); // Cap matches at 50 to prevent context bloating
}

/**
 * 6. run_command tool implementation
 */
export async function runCommand(args: { command: string; timeoutMs?: number }): Promise<string> {
  const sandbox = ensureInSandbox('.');
  const command = args.command?.trim();
  if (!command || command.length > 16_384 || command.includes('\0')) {
    throw new Error('Command must contain between 1 and 16,384 non-NUL characters.');
  }
  const requestedTimeout = Number(args.timeoutMs ?? 30_000);
  const timeout = Number.isFinite(requestedTimeout)
    ? Math.max(1_000, Math.min(300_000, Math.trunc(requestedTimeout)))
    : 30_000;

  // Security checks on commands
  const blockedTokens = ['rm -rf /', 'mkfs', 'dd if', 'shutdown', 'reboot', 'killall', 'format '];
  if (blockedTokens.some((token) => command.includes(token))) {
    throw new Error(
      `Security Exception: Command "${command}" contains unsafe operations and was blocked.`,
    );
  }

  // Check for command approval hook
  // In custom mode: always ask. In auto mode: only ask for dangerous commands.
  if (globalThis.approveCommandHandler) {
    const needsApproval =
      globalThis.agentPermissionMode === 'custom' || isDangerousCommand(command);
    if (needsApproval) {
      const approved = await globalThis.approveCommandHandler(command);
      if (!approved) {
        throw new Error(`Permission Denied: User rejected the execution of command "${command}".`);
      }
    }
  }

  // This tool intentionally supports terminal syntax such as pipes, redirects,
  // && and ||. Execute the complete string in one audited shell invocation;
  // tokenizing and spawning only the first executable silently skipped the
  // remainder of compound commands.
  const spawnCmd = process.platform === 'win32' ? process.env['ComSpec'] || 'cmd.exe' : '/bin/sh';
  const spawnArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];

  return new Promise((resolve) => {
    const child = spawn(spawnCmd, spawnArgs, {
      cwd: sandbox,
      timeout,
      // On Windows, SIGTERM is not meaningful - use default kill signal
      killSignal: process.platform === 'win32' ? undefined : 'SIGTERM',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true, // Prevent console window flash on Windows
    });
    // Hard-kill fallback if the process ignores termination signal
    const hardKillTimer = setTimeout(() => {
      try {
        // On Windows, use taskkill /F /T to kill process tree
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        /* ignore if already exited */
      }
    }, timeout + 5000);
    // Register the child in a global registry so the sidecar can kill
    // orphaned child processes if the agent run is aborted (timeout,
    // user cancel, etc.).
    const registry = (globalThis as { __activeChildProcs?: Set<NodeJS.EventEmitter> })
      .__activeChildProcs;
    const emitter = child as unknown as NodeJS.EventEmitter;
    if (registry) registry.add(emitter);
    let stdout = '';
    let stderr = '';
    (child.stdout as unknown as NodeJS.ReadableStream)?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    (child.stderr as unknown as NodeJS.ReadableStream)?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    emitter.on('error', (error: Error) => {
      clearTimeout(hardKillTimer);
      if (registry) registry.delete(emitter);
      let output = '';
      if (stdout) output += `STDOUT:\n${stdout}\n`;
      if (stderr) output += `STDERR:\n${stderr}\n`;
      return resolve(`${output}ERROR: Command failed: ${error.message}`);
    });
    emitter.on('close', (code: number | null) => {
      clearTimeout(hardKillTimer);
      if (registry) registry.delete(emitter);
      let output = '';
      if (stdout) output += `STDOUT:\n${stdout}\n`;
      if (stderr) output += `STDERR:\n${stderr}\n`;
      if (code !== 0) {
        return resolve(`${output}ERROR: Command failed with code ${code}`);
      }
      resolve(output || 'Command executed successfully with empty output.');
    });
  });
}
