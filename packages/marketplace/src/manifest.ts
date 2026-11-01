import { z } from 'zod';
import type { PluginManifest, PluginCategory, PluginPermission } from './types.js';

/** Zod schema for PluginCategory */
const PluginCategorySchema = z.enum([
  'tool',
  'provider',
  'theme',
  'extension',
  'integration',
  'language',
  'framework',
  'utility',
]);

/** Zod schema for PluginPermission */
const PluginPermissionSchema = z.enum([
  'filesystem:read',
  'filesystem:write',
  'network:http',
  'network:websocket',
  'process:spawn',
  'process:env',
  'clipboard:read',
  'clipboard:write',
  'notification:send',
]);

/** Zod schema for PluginTool */
const PluginToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});

/** Full Zod schema for PluginManifest */
export const PluginManifestSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^@?[a-z0-9][\w.-]*(?:\/[a-z0-9][\w.-]*)?$/),
  name: z.string().min(1).max(256),
  description: z.string().min(1).max(1024),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/),
  author: z.string().min(1).max(256),
  authorUrl: z.url().optional(),
  license: z.string().max(64).optional(),
  homepage: z.url().optional(),
  repository: z.url().optional(),
  category: PluginCategorySchema,
  tags: z.array(z.string().max(64)).max(20),
  icon: z.string().max(512).optional(),
  entrypoint: z.string().min(1).max(512),
  tools: z.array(PluginToolSchema).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  permissions: z.array(PluginPermissionSchema),
  minAgentVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .optional(),
  size: z.number().int().positive().optional(),
  downloads: z.number().int().nonnegative().default(0),
  rating: z.number().min(0).max(5).default(0),
  ratingCount: z.number().int().nonnegative().default(0),
  publishedAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
});

/**
 * Validate a plugin manifest object.
 * Returns the validated manifest or throws ZodError.
 */
export function validateManifest(data: unknown): PluginManifest {
  return PluginManifestSchema.parse(data);
}

/**
 * Safely validate without throwing.
 * Returns { success, data?, errors? }.
 */
export function safeValidateManifest(data: unknown): {
  success: boolean;
  data?: PluginManifest;
  errors?: string[];
} {
  const result = PluginManifestSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.issues.map(
      (e: { path: PropertyKey[]; message: string }) =>
        `${e.path.map(String).join('.')}: ${e.message}`,
    ),
  };
}

/**
 * Create a minimal manifest from a package.json-like object.
 * Fills in defaults for optional fields.
 */
export function manifestFromPackageJson(pkg: Record<string, unknown>): PluginManifest {
  const now = Date.now();
  return {
    id: (pkg.name as string) || 'unknown-plugin',
    name: (pkg.name as string) || 'Unknown Plugin',
    description: (pkg.description as string) || '',
    version: (pkg.version as string) || '0.0.0',
    author:
      typeof pkg.author === 'string'
        ? pkg.author
        : (pkg.author as { name?: string })?.name || 'Unknown',
    license: pkg.license as string | undefined,
    homepage: pkg.homepage as string | undefined,
    repository:
      typeof pkg.repository === 'string'
        ? pkg.repository
        : (pkg.repository as { url?: string })?.url,
    category: (pkg.category as PluginCategory) || 'utility',
    tags: Array.isArray(pkg.keywords) ? (pkg.keywords as string[]) : [],
    entrypoint: (pkg.main as string) || 'index.js',
    tools: pkg.tools as PluginManifest['tools'],
    dependencies: pkg.dependencies as Record<string, string> | undefined,
    devDependencies: pkg.devDependencies as Record<string, string> | undefined,
    peerDependencies: pkg.peerDependencies as Record<string, string> | undefined,
    permissions: Array.isArray(pkg.permissions) ? (pkg.permissions as PluginPermission[]) : [],
    minAgentVersion: pkg.ghitaMinVersion as string | undefined,
    downloads: 0,
    rating: 0,
    ratingCount: 0,
    publishedAt: now,
    updatedAt: now,
  };
}

/**
 * Compare two semver version strings.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('-')[0]?.split('.').map(Number) ?? [0, 0, 0];
  const pb = b.split('-')[0]?.split('.').map(Number) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * Check if a version satisfies a semver range (simplified).
 * Supports: exact, ^, ~, >=, <=, >, <
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = version.split('-')[0] ?? version;
  const vParts = v.split('.').map(Number);

  if (range === '*' || range === '') return true;

  // Exact match
  if (
    !range.startsWith('^') &&
    !range.startsWith('~') &&
    !range.startsWith('>') &&
    !range.startsWith('<')
  ) {
    return compareSemver(v, range) === 0;
  }

  const prefix = range[0];
  const rangeVersion = range.slice(1).trim();
  const rParts = rangeVersion.split('.').map(Number);

  switch (prefix) {
    case '^': {
      // Compatible with: same major, >= minor.patch
      if ((vParts[0] ?? 0) !== (rParts[0] ?? 0)) return false;
      return compareSemver(v, rangeVersion) >= 0;
    }
    case '~': {
      // Approximately: same major.minor, >= patch
      if ((vParts[0] ?? 0) !== (rParts[0] ?? 0)) return false;
      if ((vParts[1] ?? 0) !== (rParts[1] ?? 0)) return false;
      return compareSemver(v, rangeVersion) >= 0;
    }
    case '>': {
      if (range.startsWith('>=')) {
        return compareSemver(v, range.slice(2).trim()) >= 0;
      }
      return compareSemver(v, rangeVersion) > 0;
    }
    case '<': {
      if (range.startsWith('<=')) {
        return compareSemver(v, range.slice(2).trim()) <= 0;
      }
      return compareSemver(v, rangeVersion) < 0;
    }
    default:
      return false;
  }
}
