// Zod schema for validating provider YAML configurations.
// Includes a lightweight YAML parser for simple provider config files
// (no external yaml dependency required).

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ProviderConfig } from '../types.js';
import type { ProviderYAMLConfig, ProvidersYAMLRoot } from './types.js';
import { yamlToProviderConfig } from './types.js';

// Zod Schemas — validate provider configuration at runtime

const VALID_PROVIDER_TYPES: [string, ...string[]] = [
  'openai',
  'anthropic',
  'google',
  'ollama',
  'custom',
  'opengateway',
  'mimo',
  'openrouter',
  'deepseek',
  'groq',
  'mistral',
  'hicap',
  'github-models',
  'cerebras',
  'together',
  'fireworks',
  'cohere',
  'xai',
  'replicate',
  'perplexity',
  'voyage',
  'ai21',
  'sambanova',
  'novita',
  'opencode-zen',
  'nvidia-nim',
];

/**
 * Zod schema for a single provider entry.
 */
export const ProviderYAMLConfigSchema = z.object({
  type: z.enum(VALID_PROVIDER_TYPES),
  name: z.string().min(1).optional(),
  apiKey: z.string().optional(),
  apiKeys: z.array(z.string()).optional(),
  rotationStrategy: z.enum(['round-robin', 'failover', 'random']).optional(),
  baseUrl: z.string().url().optional(),
  defaultModel: z.string().optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  stop: z.array(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().int().min(100).optional(),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).max(10),
      delayMs: z.number().int().min(0),
      backoffMultiplier: z.number().min(1).max(10),
    })
    .optional(),
});

/**
 * Zod schema for the root providers YAML file.
 */
export const ProvidersYAMLRootSchema = z.object({
  version: z.literal(1),
  defaultProvider: z.enum(VALID_PROVIDER_TYPES).optional(),
  providers: z.array(ProviderYAMLConfigSchema).min(1),
  streaming: z
    .object({
      enabled: z.boolean(),
      smoothDelayMs: z.number().int().min(0).optional(),
      chunkSize: z.number().int().min(1).optional(),
    })
    .optional(),
});

// Lightweight YAML parser — handles the subset needed for provider configs

/**
 * A minimal YAML parser that handles the simple key-value and list structures
 * used in provider configuration files. Supports:
 * - Top-level scalars: `key: value`
 * - Nested objects (one level of indentation)
 * - Arrays with `- item` syntax
 * - Quoted strings
 * - Comments (# ...)
 * - Type coercion (numbers, booleans)
 *
 * For complex YAML, users should provide JSON instead.
 */
export function parseSimpleYAML(text: string): Record<string, unknown> {
  const lines = text.split('\n');
  const result: Record<string, unknown> = {};
  let currentKey = '';
  let currentObj: Record<string, unknown> | null = null;
  let currentArray: unknown[] | null = null;
  let currentArrayKey = '';

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, ''); // strip comments
    if (!line.trim()) continue;

    // Detect indentation level
    const indent = line.search(/\S/);

    if (indent === 0) {
      // Flush previous nested object/array
      if (currentKey && currentObj !== null) {
        result[currentKey] = currentObj;
        currentObj = null;
        currentKey = '';
      }
      if (currentArrayKey && currentArray !== null) {
        result[currentArrayKey] = currentArray;
        currentArray = null;
        currentArrayKey = '';
      }

      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();

      if (value === '' || value === '|' || value === '>') {
        // Nested object or multi-line string — next indented lines belong here
        currentKey = key;
        currentObj = {};
      } else {
        result[key] = coerceYAMLValue(value);
      }
    } else if (indent > 0 && currentObj !== null) {
      // Nested key-value
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        // This is an array inside the current object
        if (!currentObj[currentArrayKey]) {
          // Start a new array under the last key
        }
      }
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        const k = trimmed.slice(0, colonIdx).trim();
        const v = trimmed.slice(colonIdx + 1).trim();
        currentObj[k] = coerceYAMLValue(v);
      }
    } else if (indent > 0 && currentArray !== null) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        currentArray.push(coerceYAMLValue(trimmed.slice(2).trim()));
      }
    }

    // Detect array start: `key:` followed by `- item` lines
    if (indent === 0 && currentKey === '' && currentObj === null) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        if (value === '') {
          // Could be array — peek ahead
          currentArrayKey = key;
          currentArray = [];
        }
      }
    }
  }

  // Flush remaining
  if (currentKey && currentObj !== null) {
    result[currentKey] = currentObj;
  }
  if (currentArrayKey && currentArray !== null) {
    result[currentArrayKey] = currentArray;
  }

  return result;
}

function coerceYAMLValue(raw: string): string | number | boolean | null {
  // Strip surrounding quotes
  const unquoted = raw.replace(/^['"]|['"]$/g, '');

  if (unquoted === 'true') return true;
  if (unquoted === 'false') return false;
  if (unquoted === 'null' || unquoted === '~') return null;

  // Number coercion
  const num = Number(unquoted);
  if (!isNaN(num) && unquoted !== '') return num;

  return unquoted;
}

// Provider Config Loader — reads, parses, validates YAML provider config files

export class ProviderConfigLoader {
  /**
   * Load and validate provider configs from a YAML file.
   *
   * @param filePath Path to the YAML/JSON provider config file
   * @returns Validated ProvidersYAMLRoot
   */
  static loadFromFile(filePath: string): ProvidersYAMLRoot {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Provider config file not found: ${resolved}`);
    }

    const content = fs.readFileSync(resolved, 'utf-8');
    return ProviderConfigLoader.loadFromString(content, resolved);
  }

  /**
   * Load and validate provider configs from a YAML/JSON string.
   */
  static loadFromString(content: string, source?: string): ProvidersYAMLRoot {
    let parsed: unknown;

    // Try JSON first (fast path)
    try {
      parsed = JSON.parse(content);
    } catch {
      // Fall back to lightweight YAML parser
      parsed = parseSimpleYAML(content);
    }

    // Validate with Zod schema
    const result = ProvidersYAMLRootSchema.safeParse(parsed);
    if (!result.success) {
      const errors = result.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(`Invalid provider config${source ? ` (${source})` : ''}:\n${errors}`);
    }

    return result.data as ProvidersYAMLRoot;
  }

  /**
   * Convert a validated YAML root config into an array of ProviderConfig
   * suitable for ProviderRegistry.registerFromConfig().
   */
  static toProviderConfigs(root: ProvidersYAMLRoot): ProviderConfig[] {
    return root.providers.map((p: ProviderYAMLConfig) => yamlToProviderConfig(p));
  }

  /**
   * Validate a single provider config object (useful for programmatic registration).
   */
  static validateProviderConfig(config: unknown): ProviderYAMLConfig {
    const result = ProviderYAMLConfigSchema.safeParse(config);
    if (!result.success) {
      const errors = result.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(`Invalid provider config entry:\n${errors}`);
    }
    return result.data as ProviderYAMLConfig;
  }

  /**
   * Generate a template YAML config file with example providers.
   */
  static generateTemplate(): string {
    return `# Ghita Agent — Provider Configuration
# Schema version (do not change)
version: 1

# Default provider for general queries
defaultProvider: openai

# Provider configurations
providers:
  - type: openai
    defaultModel: gpt-4o
    maxTokens: 4096
    temperature: 0.7

  - type: anthropic
    defaultModel: claude-sonnet-4-20250514
    maxTokens: 8192
    temperature: 0.7

  - type: google
    defaultModel: gemini-1.5-pro
    maxTokens: 8192
    temperature: 0.7

  - type: groq
    defaultModel: llama-3.1-70b-versatile
    maxTokens: 4096
    temperature: 0.7

  - type: mistral
    defaultModel: mistral-large-latest
    maxTokens: 4096
    temperature: 0.7

  - type: ollama
    baseUrl: http://localhost:11434
    defaultModel: llama3

# Global streaming options
streaming:
  enabled: true
  smoothDelayMs: 15
  chunkSize: 2
`;
  }
}
