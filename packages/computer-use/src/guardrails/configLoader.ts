import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SecurityBlacklistConfig, CustomPatternEntry } from './types.js';
import { DEFAULT_SECURITY_CONFIG } from './types.js';

/**

 *   1. cwd/.ghita/security-blacklist.yaml (project-level)
 *   2. ~/.ghita/security-blacklist.yaml (user-level)
 */
export async function findConfigFile(cwd?: string): Promise<string | null> {
  const candidates = [
    cwd ? join(cwd, '.ghita', 'security-blacklist.yaml') : null,
    join(homedir(), '.ghita', 'security-blacklist.yaml'),
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    try {
      await access(path);
      return path;
    } catch {
      // File doesn't exist, try next
    }
  }
  return null;
}

/**

 *   detectBase64: true
 *   detectBinaryExecution: true
 *   requireApprovalForHigh: true
 *   whitelist:
 *     - "npm run build"
 *     - "pnpm test"
 *   customPatterns:
 *     - name: "Block rm in project"
 *       pattern: "\\brm\\b.*node_modules"
 *       severity: high
 *       description: "Do not delete node_modules manually"
 */
export function parseSecurityYaml(content: string): Partial<SecurityBlacklistConfig> {
  const config: Partial<SecurityBlacklistConfig> = {};

  // Parse boolean flags
  const detectBase64 = content.match(/detectBase64:\s*(true|false)/i);
  if (detectBase64) config.detectBase64 = detectBase64[1] === 'true';

  const detectBinary = content.match(/detectBinaryExecution:\s*(true|false)/i);
  if (detectBinary) config.detectBinaryExecution = detectBinary[1] === 'true';

  const requireApproval = content.match(/requireApprovalForHigh:\s*(true|false)/i);
  if (requireApproval) config.requireApprovalForHigh = requireApproval[1] === 'true';

  // Parse whitelist (simple list)
  const whitelistMatch = content.match(/whitelist:\s*\n((?:\s+-\s+.+\n?)*)/);
  if (whitelistMatch && whitelistMatch[1]) {
    config.whitelist = whitelistMatch[1]
      .split('\n')
      .map((line) => line.replace(/^\s*-\s*["']?|["']?\s*$/g, '').trim())
      .filter((item) => item.length > 0);
  }

  // Parse customPatterns (YAML-like array of objects)
  const patterns: CustomPatternEntry[] = [];
  const patternBlocks = content.match(
    /customPatterns:\s*\n((?:\s+-\s+name:.*\n(?:\s+\w+:.*\n?)*)*)/,
  );

  if (patternBlocks && patternBlocks[1]) {
    const blocks = patternBlocks[1].split(/\n\s*-\s+name:/);
    for (const block of blocks) {
      const nameMatch = block.match(/name:\s*["']?(.+?)["']?\s*$/m);
      const patternMatch = block.match(/pattern:\s*["']?(.+?)["']?\s*$/m);
      const severityMatch = block.match(/severity:\s*(\w+)/);
      const descMatch = block.match(/description:\s*["']?(.+?)["']?\s*$/m);

      if (nameMatch && patternMatch) {
        patterns.push({
          name: nameMatch[1]?.trim() || '',
          pattern: patternMatch[1]?.trim() || '',
          severity: (severityMatch?.[1] as 'low' | 'medium' | 'high' | 'critical') || 'medium',
          description: descMatch?.[1]?.trim() || '',
        });
      }
    }
  }

  if (patterns.length > 0) {
    config.customPatterns = patterns;
  }

  return config;
}

export async function loadSecurityConfig(cwd?: string): Promise<SecurityBlacklistConfig> {
  const filePath = await findConfigFile(cwd);
  if (!filePath) return DEFAULT_SECURITY_CONFIG;

  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = parseSecurityYaml(content);
    return { ...DEFAULT_SECURITY_CONFIG, ...parsed };
  } catch {
    return DEFAULT_SECURITY_CONFIG;
  }
}

export function generateSampleConfig(): string {
  return `# =============================================================================
# Ghita Agent - Security Blacklist Configuration
# Cấu hình danh sách cấm lệnh terminal tùy chỉnh
# =============================================================================

# Bật/tắt kiểm tra base64 obfuscation (mặc định: true)
detectBase64: true

# Bật/tắt kiểm tra binary execution (mặc định: true)
detectBinaryExecution: true

# Yêu cầu phê duyệt cho lệnh high/medium (mặc định: true)
requireApprovalForHigh: true

# Danh sách lệnh được phép bỏ qua kiểm tra (whitelist)
whitelist:
  - "npm run build"
  - "npm run test"
  - "pnpm install"
  - "pnpm build"
  - "pnpm test"
  - "git add"
  - "git commit"
  - "git push"
  - "git status"
  - "git log"
  - "git diff"

# Danh sách pattern cấm tùy chỉnh
customPatterns:
  - name: "Block node_modules deletion"
    pattern: "\\\\brm\\\\b.*node_modules"
    severity: high
    description: "Do not delete node_modules manually — use package manager"

  - name: "Block env file access"
    pattern: "\\\\bcat\\\\b.*\\\\.env\\\\b"
    severity: medium
    description: "Do not cat .env files — may expose secrets"
`;
}
