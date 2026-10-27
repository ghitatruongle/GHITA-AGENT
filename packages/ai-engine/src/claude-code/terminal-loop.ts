// Terminal-first execution framing, compact system prompt generation, and CLI safeguards.

export interface TerminalFramingConfig {
  workspaceCwd: string;
  osPlatform: string;
  dangerLevel: 'strict' | 'normal' | 'permissive';
}

export class ClaudeCodeTerminalLoop {
  /**
   * Generate Claude Code-style compact terminal agent system prompt.
   */
  static generateSystemPrompt(config: TerminalFramingConfig): string {
    return `You are Ghita Agent (Terminal Agent Mode).
Working Directory: ${config.workspaceCwd}
Host OS: ${config.osPlatform}
Safety Mode: ${config.dangerLevel.toUpperCase()}

RULES FOR TERMINAL TOOL USE:
1. Always inspect directory contents or file state before editing.
2. Formulate small, incremental edits using precise line-based or patch tools.
3. Verify changes by executing unit tests or build commands after editing.
4. Keep natural language responses concise and focused on execution results.`;
  }
}
