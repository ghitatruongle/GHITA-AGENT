// v0.2.5 AI Engine Modules Unit Tests

import { describe, it, expect } from 'vitest';
import { QueryEngine } from '../src/compact/query-engine.js';
import { LiteLLMGateway } from '../src/gateway/litellm-gateway.js';
import { ClaudeCodeTerminalLoop } from '../src/claude-code/terminal-loop.js';

describe('v0.2.5 AI Engine Integration', () => {
  it('should compact context window when token threshold is crossed', () => {
    const engine = new QueryEngine({ maxContextTokens: 100, triggerThresholdRatio: 0.5 });
    const messages = [
      {
        id: '1',
        role: 'system' as const,
        content: 'System prompt initial setup',
        timestamp: Date.now(),
      },
      {
        id: '2',
        role: 'user' as const,
        content: 'A very long query paragraph '.repeat(10),
        timestamp: Date.now(),
      },
      {
        id: '3',
        role: 'assistant' as const,
        content: 'Another long response paragraph '.repeat(10),
        timestamp: Date.now(),
      },
      { id: '4', role: 'user' as const, content: 'Third question', timestamp: Date.now() },
      { id: '5', role: 'assistant' as const, content: 'Final answer', timestamp: Date.now() },
    ];

    const result = engine.compactIfNeeded(messages);
    expect(result.compacted).toBe(true);
    expect(result.estimatedTokensSaved).toBeGreaterThan(0);
    expect(result.messages.some((m) => m.content.includes('[CONTEXT COMPACTION SUMMARY'))).toBe(
      true,
    );
  });

  it('should register and rotate keys in LiteLLMGateway', () => {
    const gateway = new LiteLLMGateway();
    gateway.registerKey('openai', 'sk-key-1');
    gateway.registerKey('openai', 'sk-key-2');

    const key1 = gateway.selectKey('openai');
    expect(['sk-key-1', 'sk-key-2']).toContain(key1);

    const fallbacks = gateway.getFallbackOrder('anthropic');
    expect(fallbacks[0]).toBe('anthropic');
    expect(fallbacks).toContain('openai');
  });

  it('should generate Claude Code style system prompt', () => {
    const prompt = ClaudeCodeTerminalLoop.generateSystemPrompt({
      workspaceCwd: '/home/user/project',
      osPlatform: 'linux',
      dangerLevel: 'normal',
    });

    expect(prompt).toContain('Ghita Agent');
    expect(prompt).toContain('/home/user/project');
  });
});
