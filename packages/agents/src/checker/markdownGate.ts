import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Dirent } from 'node:fs';

// Issue types

export type GateSeverity = 'error' | 'warning' | 'info';

export interface MarkdownIssue {
  severity: GateSeverity;
  filePath: string;
  line: number;
  column: number;
  rule: string;
  message: string;
}

export interface LinkCheckResult {
  filePath: string;
  link: string;
  resolvedTo: string | null;
  ok: boolean;
  reason?: string;
}

export interface GateOptions {
  rootDir: string;
  warningsAsErrors?: boolean;
  skipRemote?: boolean;
  include?: string[];
  exclude?: string[];
  maxFileBytes?: number;
  headingCaseInsensitive?: boolean;
  validateLink?: (link: string, fromFile: string) => Promise<LinkCheckResult> | LinkCheckResult;
}

// Glob helpers (minimal subset: ** and *)

function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((p) => matchGlob(p, path));
}

function matchGlob(pattern: string, path: string): boolean {
  const norm = path.replace(/\\/g, '/');
  const pat = pattern.replace(/\\/g, '/');
  // Thứ tự thay thế là mấu chốt: `**` → `.*` phải chạy SAU `*` → `[^/]*`.
  // Nếu đảo, chuỗi thay thế `(?:.*/)?` mang theo chính ký tự `*` nên lượt sau
  // biến `.*` thành `.[^/]*` — phá luôn kết quả của lượt trước, khiến
  // `**/*.md` chỉ khớp tối đa MỘT cấp thư mục và không loại trừ được
  // `dist/**` ở độ sâu con. Placeholder là ký tự Private Use Area (U+E000):
  // không bao giờ xuất hiện trong đường dẫn thật, và ESLint không coi nó là
  // ký tự điều khiển.
  const PLACEHOLDER = '';
  const re = new RegExp(
    `^${pat
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, PLACEHOLDER)
      .replace(/\*/g, '[^/]*')
      // Hai nhánh tuỳ chọn PHẢI xử lý TRƯỚC khi placeholder còn lại biến thành
      // `.*`. Đảo thứ tự thì `**/*.md` không khớp được file nằm ngay gốc thư
      // mục nữa (`.*\/` bắt buộc có dấu gạch chéo).
      .replace(new RegExp(`${PLACEHOLDER}/`, 'g'), '(?:.*/)?')
      .replace(new RegExp(`/${PLACEHOLDER}(?![^/])`, 'g'), '(?:/.*)?')
      .split(PLACEHOLDER)
      .join('.*')}$`,
  );
  return re.test(norm);
}

function joinFn(a: string, b: string): string {
  if (a.endsWith('/') || a.endsWith('\\')) return a + b;
  return `${a}/${b}`;
}

// File discovery

async function listMarkdownFiles(
  root: string,
  include: string[],
  exclude: string[],
): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) break;
    let entries: Dirent[];
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = joinFn(cur, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      const rel = full.slice(root.length + 1).replace(/\\/g, '/');
      if (!matchesAny(rel, include)) continue;
      if (matchesAny(rel, exclude)) continue;
      out.push(full);
    }
  }
  return out;
}

// Link extraction

export interface ExtractedLink {
  raw: string;
  href: string;
  title?: string;
  line: number;
  column: number;
}

const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g;
const IMG_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g;

export function extractLinks(markdown: string): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  const seen = new Set<number>();
  for (const re of [LINK_RE, IMG_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(markdown)) !== null) {
      if (seen.has(m.index)) continue;
      seen.add(m.index);
      const before = markdown.slice(0, m.index);
      const line = before.split('\n').length;
      const lastNl = before.lastIndexOf('\n');
      const column = m.index - (lastNl + 1) + 1;
      out.push({ raw: m[0], href: m[2] ?? '', title: m[3], line, column });
    }
  }
  return out;
}

// Heading extraction

export function extractHeadings(markdown: string): Map<string, number> {
  const map = new Map<string, number>();
  const lines = markdown.split('\n');
  let inFence = false;
  let fenceMarker: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('```')) {
      if (!inFence) {
        inFence = true;
        fenceMarker = '```';
      } else if (fenceMarker === '```') {
        inFence = false;
        fenceMarker = null;
      }
      continue;
    }
    if (line.startsWith('~~~')) {
      if (!inFence) {
        inFence = true;
        fenceMarker = '~~~';
      } else if (fenceMarker === '~~~') {
        inFence = false;
        fenceMarker = null;
      }
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      const slug = slugify(m[2] ?? '');
      if (slug) map.set(slug, i + 1);
    }
  }
  return map;
}

export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Default link validator

async function defaultLinkValidator(
  href: string,
  fromFile: string,
  options: GateOptions,
): Promise<LinkCheckResult> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    if (options.skipRemote) {
      return {
        filePath: fromFile,
        link: href,
        resolvedTo: null,
        ok: true,
        reason: 'remote-skipped',
      };
    }
    return { filePath: fromFile, link: href, resolvedTo: href, ok: true, reason: 'remote' };
  }
  if (href.startsWith('#')) {
    return { filePath: fromFile, link: href, resolvedTo: href, ok: true, reason: 'self-anchor' };
  }
  const [pathPart, anchor] = href.split('#');
  const baseDir = dirname(fromFile);
  const target = pathPart ? resolve(baseDir, pathPart) : baseDir;
  try {
    const s = await stat(target);
    if (!s.isFile()) {
      return {
        filePath: fromFile,
        link: href,
        resolvedTo: target,
        ok: false,
        reason: 'not-a-file',
      };
    }
    if (anchor) {
      const targetMd = await readFile(target, 'utf8');
      const headings = extractHeadings(targetMd);
      const caseInsensitive = options.headingCaseInsensitive !== false;
      const found = caseInsensitive
        ? Array.from(headings.keys()).some((k) => k.toLowerCase() === anchor.toLowerCase())
        : headings.has(anchor);
      if (!found) {
        return {
          filePath: fromFile,
          link: href,
          resolvedTo: target,
          ok: false,
          reason: `missing anchor #${anchor}`,
        };
      }
    }
    return { filePath: fromFile, link: href, resolvedTo: target, ok: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      filePath: fromFile,
      link: href,
      resolvedTo: target,
      ok: false,
      reason: e.code === 'ENOENT' ? 'not-found' : e.message || 'error',
    };
  }
}

// Markdown CI Gate

export interface GateRunResult {
  filesScanned: number;
  linksChecked: number;
  issues: MarkdownIssue[];
  linkResults: LinkCheckResult[];
  durationMs: number;
  failed: boolean;
}

export class MarkdownCIGate {
  private readonly options: Required<Omit<GateOptions, 'validateLink'>> & {
    validateLink?: GateOptions['validateLink'];
  };

  constructor(options: GateOptions) {
    this.options = {
      rootDir: options.rootDir,
      warningsAsErrors: options.warningsAsErrors ?? false,
      skipRemote: options.skipRemote ?? false,
      include: options.include ?? ['**/*.md'],
      exclude: options.exclude ?? ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
      maxFileBytes: options.maxFileBytes ?? 1_048_576,
      headingCaseInsensitive: options.headingCaseInsensitive ?? true,
      validateLink: options.validateLink,
    };
  }

  async run(): Promise<GateRunResult> {
    const start = Date.now();
    const files = await listMarkdownFiles(
      this.options.rootDir,
      this.options.include,
      this.options.exclude,
    );
    const issues: MarkdownIssue[] = [];
    const linkResults: LinkCheckResult[] = [];
    let linksChecked = 0;

    for (const file of files) {
      const md = await readFile(file, 'utf8');
      const maxBytes = this.options.maxFileBytes ?? 1_048_576;
      if (md.length > maxBytes) {
        issues.push({
          severity: 'warning',
          filePath: file,
          line: 0,
          column: 0,
          rule: 'size',
          message: `Markdown file exceeds ${maxBytes} bytes; skipping link checks.`,
        });
        continue;
      }

      const links = extractLinks(md);
      for (const link of links) {
        linksChecked += 1;
        const validator =
          this.options.validateLink ??
          ((href: string, from: string) => defaultLinkValidator(href, from, this.options));
        const result = await validator(link.href, file);
        linkResults.push(result);
        if (!result.ok) {
          issues.push({
            severity: 'error',
            filePath: file,
            line: link.line,
            column: link.column,
            rule: 'broken-link',
            message: `Broken link "${link.href}" (${result.reason ?? 'unknown'})`,
          });
        }
      }

      const headings = extractHeadings(md);
      if (headings.size === 0 && md.length > 500) {
        issues.push({
          severity: 'info',
          filePath: file,
          line: 0,
          column: 0,
          rule: 'no-headings',
          message: 'Markdown file has no headings; consider adding structure.',
        });
      }

      const lines = md.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        if (/!\[\s*\]\(/.test(line)) {
          issues.push({
            severity: 'warning',
            filePath: file,
            line: i + 1,
            column: 0,
            rule: 'accessibility',
            message: 'Image missing alt text',
          });
        }
        if (/<\s*img\b/i.test(line) && !/alt\s*=/i.test(line)) {
          issues.push({
            severity: 'warning',
            filePath: file,
            line: i + 1,
            column: 0,
            rule: 'accessibility',
            message: '<img> tag missing alt attribute',
          });
        }
        if (/\[[^\]]+\]\(\s*\)/.test(line)) {
          issues.push({
            severity: 'error',
            filePath: file,
            line: i + 1,
            column: 0,
            rule: 'broken-link',
            message: 'Empty link target',
          });
        }
      }
    }

    const errors = issues.filter((i) => i.severity === 'error').length;
    const warnings = issues.filter((i) => i.severity === 'warning').length;
    const failed = errors > 0 || ((this.options.warningsAsErrors ?? false) && warnings > 0);

    return {
      filesScanned: files.length,
      linksChecked,
      issues,
      linkResults,
      durationMs: Date.now() - start,
      failed,
    };
  }
}

export function mergeIssues(...lists: MarkdownIssue[][]): MarkdownIssue[] {
  return ([] as MarkdownIssue[]).concat(...lists);
}
