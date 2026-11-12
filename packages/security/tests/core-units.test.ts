import { describe, it, expect, beforeEach } from 'vitest';
import {
  InputSanitizer,
  SecretRotator,
  maskKey,
  CorsAuditor,
  AuditRunner,
  SECURITY_VERSION,
} from '../src/index.js';

describe('SECURITY_VERSION', () => {
  it('is pinned to release line', () => {
    expect(SECURITY_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('InputSanitizer', () => {
  let sanitizer: InputSanitizer;

  beforeEach(() => {
    sanitizer = new InputSanitizer();
  });

  it('detects script tag XSS and strips via fix', () => {
    const dirty = 'hello <script>alert(1)</script> world';
    const { issues, cleaned } = sanitizer.scan(dirty, 'chat.user');
    expect(issues.some((i) => i.category === 'xss')).toBe(true);
    expect(cleaned).not.toMatch(/<script/i);
  });

  it('detects event handler XSS', () => {
    const { issues } = sanitizer.scan('<img src=x onerror=alert(1)>', 'html');
    expect(issues.some((i) => /event handler/i.test(i.title))).toBe(true);
  });

  it('detects javascript: protocol', () => {
    const { issues } = sanitizer.scan('javascript:alert(1)', 'href');
    expect(issues.some((i) => /javascript/i.test(i.title))).toBe(true);
  });

  it('detects SQL UNION and tautology', () => {
    const union = sanitizer.scan('1 UNION SELECT password FROM users', 'q');
    expect(union.issues.some((i) => i.category === 'sql-injection')).toBe(true);
    const taut = sanitizer.scan("admin' OR 1=1 --", 'login');
    expect(taut.issues.some((i) => i.category === 'sql-injection')).toBe(true);
  });

  it('detects shell command injection and path traversal', () => {
    const shell = sanitizer.scan('foo; rm -rf /', 'cmd');
    expect(shell.issues.some((i) => i.category === 'command-injection')).toBe(true);
    const path = sanitizer.scan('../../etc/passwd', 'file');
    expect(path.issues.some((i) => i.category === 'path-traversal')).toBe(true);
  });

  it('detects eval / Function constructor', () => {
    const { issues } = sanitizer.scan('eval("1+1")', 'code');
    expect(issues.some((i) => /eval/i.test(i.title))).toBe(true);
  });

  it('escapeHtml encodes dangerous characters', () => {
    expect(sanitizer.escapeHtml(`<img src="x" onerror='y'>`)).toContain('&lt;');
    expect(sanitizer.escapeHtml(`a&b`)).toContain('&amp;');
  });

  it('stripHtml removes tags', () => {
    expect(sanitizer.stripHtml('<b>hi</b>')).toBe('hi');
  });

  it('escapeSql doubles single quotes', () => {
    expect(sanitizer.escapeSql("O'Reilly")).toBe("O''Reilly");
  });

  it('escapeShell wraps and escapes single quotes', () => {
    expect(sanitizer.escapeShell("it's")).toBe(`'it'\\''s'`);
  });

  it('sanitizeFilename blocks traversal and reserved chars', () => {
    expect(sanitizer.sanitizeFilename('../a/b\\c:d')).not.toMatch(/\.\./);
    expect(sanitizer.sanitizeFilename('../a/b\\c:d')).not.toMatch(/[/\\:]/);
  });

  it('sanitizeFilename neutralizes dot-runs anywhere (CI fuzz counterexample " ..")', () => {
    // Counterexample từ fast-check trên CI (2026-11-13): " .." lọt qua vì
    // chỉ strip dots ĐẦU dòng. Dot-run ≥2 phải gộp "_" ở mọi vị trí.
    expect(sanitizer.sanitizeFilename(' ..')).toBe(' _');
    expect(sanitizer.sanitizeFilename(' ..')).not.toContain('..');
    expect(sanitizer.sanitizeFilename('a..b')).toBe('a_b');
    // "..." bị strip dots đầu dòng trước → chuỗi rỗng (an toàn hơn cả "_").
    expect(sanitizer.sanitizeFilename('...')).toBe('');
    expect(sanitizer.sanitizeFilename('file.v2.tar.gz')).toBe('file.v2.tar.gz');
  });

  it('isSafeUrl rejects non-https by default and private IPs', () => {
    expect(sanitizer.isSafeUrl('http://1.1.1.1/')).toBe(false);
    expect(sanitizer.isSafeUrl('https://127.0.0.1/')).toBe(false);
    expect(sanitizer.isSafeUrl('https://10.0.0.5/')).toBe(false);
    expect(sanitizer.isSafeUrl('https://192.168.1.1/')).toBe(false);
    expect(sanitizer.isSafeUrl('https://169.254.169.254/latest')).toBe(false);
    expect(sanitizer.isSafeUrl('https://172.16.0.1/')).toBe(false);
  });

  it('isSafeUrl rejects hostnames (must use async DNS path)', () => {
    expect(sanitizer.isSafeUrl('https://example.com/')).toBe(false);
  });

  it('isSafeUrl accepts public IPv4 over https', () => {
    expect(sanitizer.isSafeUrl('https://1.1.1.1/')).toBe(true);
  });

  it('validateUrlAsync pins public literal IP', async () => {
    const pin = await sanitizer.validateUrlAsync('https://8.8.8.8/path?q=1');
    expect(pin).not.toBeNull();
    expect(pin?.ip).toBe('8.8.8.8');
    expect(pin?.host).toBe('8.8.8.8');
    expect(pin?.pathname).toContain('/path');
  });

  it('validateUrlAsync rejects private literal', async () => {
    const pin = await sanitizer.validateUrlAsync('https://10.1.2.3/');
    expect(pin).toBeNull();
  });

  it('validateUrlAsync rejects invalid URL', async () => {
    expect(await sanitizer.validateUrlAsync('not-a-url')).toBeNull();
  });

  it('resolveAndValidate is alias of validateUrlAsync', async () => {
    const a = await sanitizer.resolveAndValidate('https://1.0.0.1/');
    expect(a?.ip).toBe('1.0.0.1');
  });

  it('supports custom rules and reports stats', () => {
    sanitizer.addRule({
      id: '999',
      name: 'Custom token',
      pattern: /SECRET_TOKEN/,
      severity: 'high',
      category: 'input-validation',
    });
    const { issues } = sanitizer.scan('x SECRET_TOKEN y', 'body');
    expect(issues.some((i) => i.title === 'Custom token')).toBe(true);
    const s = sanitizer.stats();
    expect(s.totalScans).toBeGreaterThan(0);
    expect(s.rulesCount).toBeGreaterThan(10);
  });
});

describe('SecretRotator + maskKey', () => {
  it('maskKey hides middle characters', () => {
    expect(maskKey('short')).toBe('***');
    expect(maskKey('sk-abcdefghijklmnop')).toMatch(/^sk-a\.\.\.mnop$/);
  });

  it('register / get / listByProvider / touch work', () => {
    const rotator = new SecretRotator();
    const info = rotator.register({
      id: 'k1',
      provider: 'openai',
      maskedKey: 'sk-...test',
      createdAt: Date.now(),
      unmaskedKey: 'sk-live-secret-value-1234',
    });
    expect(info.status).toBe('active');
    expect(rotator.get('k1')?.provider).toBe('openai');
    expect(rotator.getActiveKey('k1')).toBe('sk-live-secret-value-1234');
    expect(rotator.listByProvider('openai')).toHaveLength(1);
    expect(rotator.touch('k1')).toBe(true);
    expect(rotator.touch('missing')).toBe(false);
  });

  it('getActiveKey returns undefined for revoked keys', async () => {
    const rotator = new SecretRotator();
    rotator.register({
      id: 'k2',
      provider: 'anthropic',
      maskedKey: 'sk-...x',
      createdAt: Date.now(),
      unmaskedKey: 'raw-key-value-xxxx',
    });
    await rotator.revoke('k2', 'test');
    expect(rotator.getActiveKey('k2')).toBeUndefined();
    expect(rotator.get('k2')?.status).toBe('revoked');
  });

  it('rotate stores new unmasked key and keeps key active on generate failure', async () => {
    const logs: string[] = [];
    const rotator = new SecretRotator({
      generateKey: async () => 'new-secret-key-abcdef',
      revokeKey: async () => undefined,
      logger: (m) => logs.push(m),
    });
    rotator.register({
      id: 'k3',
      provider: 'google',
      maskedKey: 'old-...key',
      createdAt: Date.now() - 1000,
      unmaskedKey: 'old-secret-key-zzzz',
    });
    const event = await rotator.rotate('k3', 'manual');
    expect(event.action).toBe('rotated');
    expect(rotator.getActiveKey('k3')).toBe('new-secret-key-abcdef');
    expect(rotator.stats().totalRotations).toBe(1);

    const failing = new SecretRotator({
      generateKey: async () => {
        throw new Error('provider down');
      },
    });
    failing.register({
      id: 'k4',
      provider: 'openai',
      maskedKey: 'm',
      createdAt: Date.now(),
      unmaskedKey: 'still-valid',
    });
    const failed = await failing.rotate('k4');
    expect(failed.reason).toMatch(/generate_failed/);
    expect(failing.getActiveKey('k4')).toBe('still-valid');
  });

  it('listDueForRotation and listExpired drive tick()', async () => {
    const rotator = new SecretRotator({
      defaultRotationIntervalMs: 1000,
      generateKey: async () => 'rotated-key-value-9999',
    });
    const now = Date.now();
    rotator.register({
      id: 'due',
      provider: 'openai',
      maskedKey: 'm1',
      createdAt: now - 5000,
      rotationIntervalMs: 1000,
      unmaskedKey: 'old1',
    });
    rotator.register({
      id: 'exp',
      provider: 'openai',
      maskedKey: 'm2',
      createdAt: now - 100,
      expiresAt: now - 1,
      unmaskedKey: 'old2',
    });
    expect(rotator.listDueForRotation(now).map((k) => k.id)).toContain('due');
    expect(rotator.listExpired(now).map((k) => k.id)).toContain('exp');
    const events = await rotator.tick();
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(rotator.get('exp')?.status).toBe('revoked');
    expect(rotator.getActiveKey('due')).toBe('rotated-key-value-9999');
  });

  it('rotate/revoke throw for missing ids', async () => {
    const rotator = new SecretRotator();
    await expect(rotator.rotate('nope')).rejects.toThrow(/not found/);
    await expect(rotator.revoke('nope')).rejects.toThrow(/not found/);
  });
});

describe('CorsAuditor', () => {
  const auditor = new CorsAuditor();

  it('flags wildcard origin with credentials as critical', () => {
    const issues = auditor.audit(
      { origins: ['*'], methods: ['GET'], headers: ['Content-Type'], credentials: true },
      'api.ts',
    );
    expect(issues.some((i) => i.id === 'SEC-CORS-001' && i.severity === 'critical')).toBe(true);
  });

  it('flags wildcard origin, headers, dangerous methods, null origin, long maxAge', () => {
    const issues = auditor.audit(
      {
        origins: ['*', 'null', '*.example.com'],
        methods: ['GET', 'TRACE'],
        headers: ['*'],
        credentials: false,
        maxAge: 200_000,
      },
      'cfg',
    );
    const ids = issues.map((i) => i.id);
    expect(ids).toContain('SEC-CORS-002');
    expect(ids).toContain('SEC-CORS-003');
    expect(ids).toContain('SEC-CORS-004');
    expect(ids).toContain('SEC-CORS-005');
    expect(ids).toContain('SEC-CORS-006');
    expect(ids).toContain('SEC-CORS-007');
  });

  it('auditMany flattens multiple configs', () => {
    const issues = auditor.auditMany([
      {
        config: {
          origins: ['https://a.com'],
          methods: ['GET'],
          headers: ['X'],
          credentials: false,
        },
        location: 'a',
      },
      {
        config: { origins: ['*'], methods: ['GET'], headers: ['X'], credentials: false },
        location: 'b',
      },
    ]);
    expect(issues.some((i) => i.location === 'b')).toBe(true);
  });
});

describe('AuditRunner', () => {
  it('aggregates sanitizer + cors issues into score/pass', async () => {
    const runner = new AuditRunner();
    expect(runner.getSanitizer()).toBeInstanceOf(InputSanitizer);
    expect(runner.getCorsAuditor()).toBeInstanceOf(CorsAuditor);
    expect(runner.getRotator()).toBeInstanceOf(SecretRotator);

    const report = await runner.run({
      threshold: 90,
      inputsToScan: [{ value: '<script>x</script>', location: 'chat' }],
      corsConfigs: [
        {
          config: { origins: ['*'], methods: ['GET'], headers: ['*'], credentials: true },
          location: 'api',
        },
      ],
    });

    expect(report.issues.length).toBeGreaterThan(0);
    expect(report.counts.critical + report.counts.high).toBeGreaterThan(0);
    expect(report.score).toBeLessThan(90);
    expect(report.passed).toBe(false);
    expect(report.id).toMatch(/^audit_/);
  });

  it('flags expired and due keys from rotator', async () => {
    const rotator = new SecretRotator();
    const now = Date.now();
    rotator.register({
      id: 'old',
      provider: 'openai',
      maskedKey: 'm',
      createdAt: now - 10_000,
      rotationIntervalMs: 1000,
    });
    rotator.register({
      id: 'dead',
      provider: 'openai',
      maskedKey: 'm',
      createdAt: now,
      expiresAt: now - 5,
    });
    const runner = new AuditRunner(rotator);
    const report = await runner.run({ threshold: 100, rotateKeys: false });
    expect(report.issues.some((i) => i.id.includes('EXPIRED'))).toBe(true);
    expect(report.issues.some((i) => i.id.includes('ROTATE'))).toBe(true);
  });

  it('passes clean audits above threshold', async () => {
    const runner = new AuditRunner();
    const report = await runner.run({
      threshold: 80,
      inputsToScan: [{ value: 'hello world', location: 'chat' }],
      corsConfigs: [
        {
          config: {
            origins: ['https://app.ghita.dev'],
            methods: ['GET', 'POST'],
            headers: ['Authorization'],
            credentials: true,
            maxAge: 600,
          },
          location: 'api',
        },
      ],
    });
    expect(report.passed).toBe(true);
    expect(report.score).toBe(100);
  });
});
