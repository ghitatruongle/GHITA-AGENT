// Shared type definitions for the skills package.
// Extracted from index.ts to avoid circular dependencies.

import type { Skill, SkillCategory, SkillResult } from '@ghita/shared';

/** Version constant for the skills package assets. */
export const SKILLS_VERSION = '0.0.0-preview';

/** Ready, disabled, or missing status states for loaded skills. */
export type SkillStatus = 'ready' | 'disabled' | 'missing-adapter' | 'error';
/** Operational authorization boundaries requested by skill definitions. */
export type SkillScope = 'workspace' | 'system' | 'browser' | 'desktop';

/** Parameters provided to a skill invocation task run. */
export interface SkillInvocation {
  /** Unstructured input values defined by the skill JSON schema. */
  input?: Record<string, unknown>;
  /** Custom working directory path to run the skill task in. */
  cwd?: string;
  /** Abort signal to cancel running shell commands or network requests. */
  signal?: AbortSignal;
  /** Whether the user has approved this dangerous skill execution. */
  approved?: boolean;
}

/** Execution context environment provided to running skill implementations. */
export interface SkillExecutionContext {
  /** Reference to the registry containing active skills. */
  registry: unknown;
  /** High-resolution timer returning epoch milliseconds. */
  now: () => number;
  /** Adapters backing system actions like terminal runs or file I/O. */
  adapters: SkillRuntimeAdapters;
}

/** Concrete executable skill capability carrying schemas and operation functions. */
export interface SkillDefinition extends Skill {
  /** Semver string declaring skill version metadata. */
  version: string;
  /** Declared scopes required to be approved prior to running. */
  scopes: SkillScope[];
  /** Current ready status of the skill runtime. */
  status: SkillStatus;
  /** Whether this skill requires explicit user approval before execution (e.g., terminal.run, db.query). */
  dangerous?: boolean;
  /** Main executor executing the skill's business logic. */
  run: (invocation: SkillInvocation, context: SkillExecutionContext) => Promise<SkillResult>;

  /** Tool allowlist: adapter keys permitted at execution boundary (deny others). */
  allowedTools?: string[];
  /** Sandbox permission level requested by the skill. */
  sandboxPermissions?: 'default' | 'require_escalated';
  /** SPDX license identifier (e.g. MIT, Apache-2.0, Proprietary). */
  license?: string;
  /** Provenance/attribution sources this skill derives from. */
  sources?: Array<{ name: string; url?: string }>;
  /** v2 metadata. */
  metadata?: {
    /** Optional quoted version override (defaults to `version`). */
    version?: string;
    /** Hide from discovery (internal/WIP tier). */
    internal?: boolean;
  };
}

/** Adapter mapping file read/write methods to Tauri backend or Node fs. */
export interface FileSkillAdapter {
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, content: string) => Promise<void>;
  listDirectory?: (path: string) => Promise<unknown[]>;
}

/** Adapter enabling command runs on the host shell or container. */
export interface TerminalSkillAdapter {
  runCommand?: (
    command: string,
    options?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string; duration: number }>;
}

/** Adapter capturing desktop/display screenshots to PNG buffers. */
export interface ScreenshotSkillAdapter {
  captureScreen?: () => Promise<{
    mimeType: string;
    data: string;
    width?: number;
    height?: number;
  }>;
}

/** Adapter launching or closing native binaries on the user host. */
export interface AppControlSkillAdapter {
  openApp?: (target: string, args?: string[]) => Promise<void>;
  closeApp?: (target: string) => Promise<void>;
}

/** Runtime context mapping system platform actions to active skill executions. */
export interface SkillRuntimeAdapters {
  file?: FileSkillAdapter;
  terminal?: TerminalSkillAdapter;
  screenshot?: ScreenshotSkillAdapter;
  app?: AppControlSkillAdapter;
  onSkillComplete?: (id: string, result: SkillResult) => void | Promise<void>;
}

/** Unified snapshot tracking registered, enabled, and category count states. */
export interface SkillRegistrySnapshot {
  total: number;
  enabled: number;
  disabled: number;
  byCategory: Record<SkillCategory, number>;
  skills: SkillDefinition[];
}
