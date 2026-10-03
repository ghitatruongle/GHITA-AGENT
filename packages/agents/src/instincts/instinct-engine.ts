// Context-aware rules and instincts automatically evaluated and injected into
// agent system prompts when matching file extensions, frameworks, or project patterns.

export interface InstinctRule {
  id: string;
  name: string;
  description: string;
  /** Trigger conditions: matching file extensions, project root files, or topic keywords */
  triggers: {
    fileExtensions?: string[];
    manifestFiles?: string[];
    keywords?: string[];
  };
  /** System prompt instruction injected into agent context when triggered */
  instruction: string;
  enabled: boolean;
  priority: number;
}

export interface InstinctContext {
  activeFile?: string;
  workspaceFiles?: string[];
  userPrompt?: string;
}

export const BUILTIN_INSTINCTS: InstinctRule[] = [
  {
    id: 'rust-safety-instinct',
    name: 'Rust Code Quality & Safety',
    description: 'Enforces memory safety, avoiding unwrap(), and idiom adherence in Rust files',
    triggers: {
      fileExtensions: ['.rs'],
      manifestFiles: ['Cargo.toml'],
      keywords: ['rust', 'cargo', 'tauri'],
    },
    instruction:
      'RUST INSTINCT: Avoid unwrap() or expect() in production Rust paths; handle Result/Option explicitly with pattern matching or ? operator.',
    enabled: true,
    priority: 10,
  },
  {
    id: 'typescript-strict-instinct',
    name: 'TypeScript Strictness & Type Safety',
    description: 'Enforces strict typing without using any or unhandled promises',
    triggers: {
      fileExtensions: ['.ts', '.tsx'],
      manifestFiles: ['tsconfig.json'],
      keywords: ['typescript', 'react'],
    },
    instruction:
      'TYPESCRIPT INSTINCT: Prefer strict interfaces over `any`. Always handle promise rejections and use async/await cleanly.',
    enabled: true,
    priority: 10,
  },
  {
    id: 'git-checkpoint-instinct',
    name: 'Git Safe Checkpoints',
    description: 'Reminds agent to inspect git status and avoid overwriting uncommitted work',
    triggers: {
      manifestFiles: ['.git'],
      keywords: ['git', 'commit', 'branch', 'pr'],
    },
    instruction:
      'GIT INSTINCT: Respect existing uncommitted changes in the repository. Verify git status before executing destructive changes.',
    enabled: true,
    priority: 5,
  },
  {
    id: 'security-audit-instinct',
    name: 'OWASP Security Guardrails',
    description: 'Enforces input validation and credential protection',
    triggers: {
      keywords: ['auth', 'login', 'password', 'token', 'secret', 'key'],
    },
    instruction:
      'SECURITY INSTINCT: Never hardcode secret keys, API tokens, or passwords in source files. Use environment variables.',
    enabled: true,
    priority: 20,
  },
];

export class InstinctEngine {
  private readonly instincts: Map<string, InstinctRule> = new Map();

  constructor(initialInstincts: InstinctRule[] = BUILTIN_INSTINCTS) {
    for (const instinct of initialInstincts) {
      this.instincts.set(instinct.id, instinct);
    }
  }

  register(rule: InstinctRule): void {
    this.instincts.set(rule.id, rule);
  }

  unregister(id: string): boolean {
    return this.instincts.delete(id);
  }

  list(): InstinctRule[] {
    return [...this.instincts.values()];
  }

  /**
   * Evaluate active context and return relevant system instructions sorted by priority.
   */
  evaluate(context: InstinctContext): { activeInstincts: InstinctRule[]; combinedPrompt: string } {
    const matched: InstinctRule[] = [];

    // `split('.').pop()` trên tên KHÔNG có dấu chấm trả về chính tên đó, nên
    // `Makefile` sinh ra extension giả `.makefile` và khớp oan mọi rule khai
    // báo trùng tên file (Dockerfile → .dockerfile, LICENSE → .license).
    const activeExt = (() => {
      const name = context.activeFile;
      if (!name) return undefined;
      const dot = name.lastIndexOf('.');
      if (dot <= 0 || dot === name.length - 1) return undefined;
      return `.${name.slice(dot + 1).toLowerCase()}`;
    })();
    const promptLower = (context.userPrompt || '').toLowerCase();
    const workspaceFiles = context.workspaceFiles || [];

    for (const instinct of this.instincts.values()) {
      if (!instinct.enabled) continue;

      let isMatch = false;

      // Check file extensions
      if (activeExt && instinct.triggers.fileExtensions?.includes(activeExt)) {
        isMatch = true;
      }

      // Check manifest files
      if (
        !isMatch &&
        instinct.triggers.manifestFiles?.some((manifest) => workspaceFiles.includes(manifest))
      ) {
        isMatch = true;
      }

      // Check keywords in prompt
      if (!isMatch && instinct.triggers.keywords?.some((kw) => promptLower.includes(kw))) {
        isMatch = true;
      }

      if (isMatch) {
        matched.push(instinct);
      }
    }

    matched.sort((a, b) => b.priority - a.priority);

    const combinedPrompt = matched.map((rule) => `- ${rule.instruction}`).join('\n');

    return {
      activeInstincts: matched,
      combinedPrompt: combinedPrompt ? `[Active Agent Instincts]:\n${combinedPrompt}` : '',
    };
  }
}
