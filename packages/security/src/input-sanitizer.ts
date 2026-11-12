import dnsPromises from 'node:dns/promises';
import net from 'node:net';
import type { SecurityIssue, SanitizationRule } from './types.js';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '/': '&#x2F;',
  '`': '&#x60;',
  '=': '&#x3D;',
};

/**

 *

 *   const sanitizer = new InputSanitizer();
 *   const result = sanitizer.scan(userInput, 'comment');
 *   if (result.issues.length > 0) console.warn('Suspicious input:', result.issues);
 *   const clean = sanitizer.escapeHtml(userInput);
 */
export class InputSanitizer {
  private readonly customRules: SanitizationRule[] = [];
  private totalScans = 0;
  private totalIssuesFound = 0;

  constructor() {
    // Default rules
    this.customRules.push(...DEFAULT_RULES);
  }

  addRule(rule: SanitizationRule): void {
    this.customRules.push(rule);
  }

  scan(input: string, location: string): { issues: SecurityIssue[]; cleaned: string } {
    this.totalScans++;
    const issues: SecurityIssue[] = [];
    let cleaned = input;

    for (const rule of this.customRules) {
      if (rule.pattern.test(input)) {
        issues.push({
          id: `SEC-${rule.category.toUpperCase()}-${rule.id}`,
          category: rule.category,
          severity: rule.severity,
          title: rule.name,
          description: `Detected potential ${rule.category} pattern in input`,
          location,
          evidence: this.snippet(input, rule.pattern),
          remediation: `Apply rule.fix() or use escapeHtml/escapeSql to sanitize.`,
          cwe: CWE_MAP[rule.category],
          detectedAt: Date.now(),
        });
        if (rule.fix) cleaned = rule.fix(cleaned);
      }
    }

    this.totalIssuesFound += issues.length;
    return { issues, cleaned };
  }

  /**
   * Escape HTML entities without double-escaping valid existing entities.
   */
  escapeHtml(input: string): string {
    return input
      .replace(/&(?!amp;|lt;|gt;|quot;|#39;|#x2F;|#x60;|#x3D;)/g, '&amp;')
      .replace(/[<>"'`=/]/g, (c) => HTML_ESCAPES[c] ?? c);
  }

  stripHtml(input: string): string {
    return input.replace(/<[^>]*>/g, '');
  }

  /**
   * Escape SQL string (wrap quote + escape internal quote).
   */
  escapeSql(input: string): string {
    return input.replace(/'/g, "''");
  }

  /**
   * Escape shell argument.
   */
  escapeShell(input: string): string {
    return `'${input.replace(/'/g, `'\\''`)}'`;
  }

  sanitizeFilename(input: string): string {
    return (
      input
        .replace(/\.\.[/\\]/g, '')
        .replace(/[/\\]/g, '_')
        // eslint-disable-next-line no-control-regex -- control characters are matched intentionally so they get stripped
        .replace(/[<>:"|?*\x00-\x1f]/g, '')
        .replace(/^\.+/, '')
        // Fuzz hardening (CI 2026-11-13, counterexample " .."): dot-run ≥2
        // gộp thành "_" — property "never contain .." phải đúng với MỌI chuỗi
        // (trước đó chỉ strip dots đầu dòng nên " .." lọt qua).
        .replace(/\.+/g, (m) => (m.length >= 2 ? '_' : m))
    );
  }

  /**

   *
   * Performs two-layer validation:
   *   1. Checks the literal hostname against a private/reserved IP blocklist.
   *   2. For hostnames (not literals), rejects the request and tells the
   *      caller to use `validateUrlAsync()` (which performs the async DNS
   *      lookup and defeats DNS rebinding via pinning).
   *
   * Callers that need real DNS-rebinding protection should pass the URL
   * through `validateUrlAsync()` and use the returned pin for `fetch`.
   */
  isSafeUrl(url: string, allowedProtocols: string[] = ['https:']): boolean {
    try {
      const u = new URL(url);
      if (!allowedProtocols.includes(u.protocol)) return false;
      if (!this.isLiteralAddressSafe(u.hostname)) return false;
      // For non-literal hostnames the sync validation cannot verify the
      // actual A/AAAA records. We refuse such requests by default — this
      // is the safer choice and matches the original audit fix intent.
      // Callers needing to allow public hostnames should call
      // `validateUrlAsync()` instead, which performs the DNS lookup
      // with the privacy/reserved range blocklist and returns a
      // pinning struct safe to use for fetch.
      if (net.isIP(u.hostname) === 0) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Async URL validator that performs DNS resolution and rejects any host
   * whose A/AAAA records fall in a private/reserved range. Returns a
   * "pin" struct holding the literal IP plus the original hostname so
   * callers can build an HTTP request that defeats DNS rebinding:
   *
   *   const pin = await sanitizer.validateUrlAsync(url);
   *   if (!pin) throw new Error('SSRF blocked');
   *   await fetch(`${pin.scheme}://${pin.ip}${pin.pathname}`, {
   *     headers: { Host: pin.host },
   *   });
   */
  async validateUrlAsync(
    url: string,
    allowedProtocols: string[] = ['https:', 'http:'],
  ): Promise<{
    scheme: string;
    ip: string;
    host: string;
    port: string;
    pathname: string;
  } | null> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (!allowedProtocols.includes(u.protocol)) return null;
    if (!this.isLiteralAddressSafe(u.hostname)) return null;

    let candidates: { address: string; family: number }[];
    if (net.isIP(u.hostname) !== 0) {
      candidates = [{ address: u.hostname, family: net.isIP(u.hostname) }];
    } else {
      try {
        candidates = await dnsPromises.lookup(u.hostname, {
          all: true,
          verbatim: true,
        });
      } catch {
        return null;
      }
    }

    for (const rec of candidates) {
      if (!this.isLiteralAddressSafe(rec.address)) return null;
    }
    const primary = candidates[0];
    if (!primary) return null;
    return {
      scheme: u.protocol.replace(':', ''),
      ip: primary.address,
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? '443' : '80'),
      pathname: u.pathname + u.search,
    };
  }

  /** Backwards-compatible alias for `validateUrlAsync`. */
  resolveAndValidate(url: string) {
    return this.validateUrlAsync(url);
  }

  /**
   * Returns true if the literal IP address or named host is not in any
   * private, reserved, loopback, link-local, multicast, or CGNAT range.
   */
  private isLiteralAddressSafe(host: string): boolean {
    // Strip IPv6 brackets if present
    const h = host.replace(/^\[(.*)\]$/, '$1');

    if (h === 'localhost' || h === '0.0.0.0' || h === '::' || h === '::1' || h === '[::1]') {
      return false;
    }

    // IPv6 — block loopback, link-local (fe80::/10), unique-local (fc00::/7),
    // and unspecified ::/128
    if (net.isIP(h) === 6) {
      const lower = h.toLowerCase();
      if (lower === '::1' || lower === '::') return false;
      // fe80::/10 link-local
      if (/^fe[89ab][0-9a-f]?:/i.test(lower)) return false;
      // fc00::/7 unique local
      if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return false;
      // IPv4-mapped IPv6 (::ffff:a.b.c.d) — unwrap and recurse
      if (lower.startsWith('::ffff:')) {
        const v4 = lower.slice(7);
        if (net.isIP(v4) === 4) return this.isLiteralAddressSafe(v4);
        return false;
      }
      return true;
    }

    if (net.isIP(h) === 4) {
      const parts = h.split('.').map(Number);
      const p0 = parts[0] ?? -1;
      const p1 = parts[1] ?? -1;
      // 0.0.0.0/8 (Current network)
      if (p0 === 0) return false;
      // 10.0.0.0/8 (Private)
      if (p0 === 10) return false;
      // 100.64.0.0/10 (CGNAT / Shared address space)
      if (p0 === 100 && p1 >= 64 && p1 <= 127) return false;
      // 127.0.0.0/8 (Loopback)
      if (p0 === 127) return false;
      // 169.254.0.0/16 (Link-local / APIPA / cloud metadata 169.254.169.254)
      if (p0 === 169 && p1 === 254) return false;
      // 172.16.0.0/12 (Private)
      if (p0 === 172 && p1 >= 16 && p1 <= 31) return false;
      // 192.0.0.0/24 (IETF Protocol Assignments)
      if (p0 === 192 && p1 === 0 && (parts[2] ?? -1) === 0) return false;
      // 192.168.0.0/16 (Private)
      if (p0 === 192 && p1 === 168) return false;
      // 198.18.0.0/15 (Benchmark testing)
      if (p0 === 198 && (p1 === 18 || p1 === 19)) return false;
      // 224.0.0.0/4 (Multicast)
      if (p0 >= 224 && p0 <= 239) return false;
      // 240.0.0.0/4 (Reserved)
      if (p0 >= 240) return false;
      return true;
    }

    // Hostname (not an IP literal). Caller is responsible for DNS
    // resolution — this method alone cannot determine safety.
    return true;
  }

  /**
   * Stats.
   */
  stats(): { totalScans: number; totalIssuesFound: number; rulesCount: number } {
    return {
      totalScans: this.totalScans,
      totalIssuesFound: this.totalIssuesFound,
      rulesCount: this.customRules.length,
    };
  }

  private snippet(input: string, pattern: RegExp, ctx = 30): string {
    const m = input.match(pattern);
    if (!m || m.index === undefined) return input.slice(0, 100);
    const start = Math.max(0, m.index - ctx);
    const end = Math.min(input.length, m.index + m[0].length + ctx);
    return `...${input.slice(start, end)}...`;
  }
}

const CWE_MAP: Record<string, string> = {
  xss: 'CWE-79',
  'sql-injection': 'CWE-89',
  'command-injection': 'CWE-78',
  'path-traversal': 'CWE-22',
  csrf: 'CWE-352',
  'open-redirect': 'CWE-601',
  ssrf: 'CWE-918',
  'input-validation': 'CWE-20',
  cors: 'CWE-942',
  'api-key': 'CWE-798',
};

const DEFAULT_RULES: SanitizationRule[] = [
  {
    id: '001',
    name: 'Script tag injection',
    pattern: /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/i,
    severity: 'critical',
    category: 'xss',
    fix: (s) => s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ''),
  },
  {
    id: '002',
    name: 'Event handler attribute',
    pattern: /\bon\w+\s*=\s*["']?[^"'>\s]+/i,
    severity: 'high',
    category: 'xss',
    fix: (s) => s.replace(/\bon\w+\s*=\s*["']?[^"'>\s]+/gi, ''),
  },
  {
    id: '003',
    name: 'javascript: protocol',
    pattern: /javascript\s*:/i,
    severity: 'high',
    category: 'xss',
  },
  {
    id: '004',
    name: 'iframe injection',
    pattern: /<iframe\b/i,
    severity: 'high',
    category: 'xss',
    fix: (s) => s.replace(/<iframe\b[^>]*>.*?<\/iframe>/gi, ''),
  },
  {
    id: '005',
    name: 'SQL UNION injection',
    pattern: /\bunion\b[\s\S]+\bselect\b/i,
    severity: 'critical',
    category: 'sql-injection',
  },
  {
    id: '006',
    name: 'SQL comment injection',
    pattern: /(--\s|;--|\/\*)/,
    severity: 'high',
    category: 'sql-injection',
  },
  {
    id: '007',
    name: 'SQL tautology (1=1)',
    pattern: /\b(or|and)\s+['"]?\d+['"]?\s*=\s*['"]?\d+['"]?/i,
    severity: 'critical',
    category: 'sql-injection',
  },
  {
    id: '008',
    name: 'Shell command injection',
    pattern: /[;&|`$]\s*(rm|cat|ls|wget|curl|nc|bash|sh)\b/i,
    severity: 'critical',
    category: 'command-injection',
  },
  {
    id: '009',
    name: 'Path traversal',
    pattern: /\.\.[/\\]/,
    severity: 'high',
    category: 'path-traversal',
  },
  {
    id: '010',
    name: 'Eval / Function constructor',
    pattern: /\beval\s*\(|\bnew\s+Function\s*\(/i,
    severity: 'critical',
    category: 'command-injection',
  },
];
