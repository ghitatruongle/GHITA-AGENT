// Track S3 P3 — `choose` tool: registration, human-in-the-loop approval flow
// (ToolApprovalManager + require_approval/approve_command vocabulary), and
// error paths via the S2 AgentError contract.

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  createBuiltInTools,
  executeChoose,
  getChooseApprovalManager,
  resolveChoose,
  CHOOSE_TIMEOUT_MS,
} from '../src/tools/index.js';
import { AgentError } from '../src/errors/index.js';

interface ChooseHostGlobals {
  chooseRequestHandler?: (payload: {
    id: string;
    question: string;
    options: string[];
    allowCustom: boolean;
  }) => void;
}

function setChooseHandler(handler: ChooseHostGlobals['chooseRequestHandler']): void {
  (globalThis as ChooseHostGlobals).chooseRequestHandler = handler;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  delete (globalThis as ChooseHostGlobals).chooseRequestHandler;
  getChooseApprovalManager().clear();
  vi.restoreAllMocks();
});

describe('choose — registration', () => {
  it('is registered among the built-in tools', () => {
    const tools = createBuiltInTools().map((t) => t.name);
    expect(tools).toContain('choose');
    const choose = createBuiltInTools().find((t) => t.name === 'choose');
    expect(choose?.parameters).toMatchObject({
      type: 'object',
      required: ['question', 'options'],
    });
  });

  it('exposes a shared approval manager with the 60s deny-default timeout', () => {
    expect(CHOOSE_TIMEOUT_MS).toBe(60_000);
    expect(getChooseApprovalManager()).toBeDefined();
  });
});

describe('choose — approval flow', () => {
  it('pauses, broadcasts the question via chooseRequestHandler, and returns the selected option', async () => {
    const payloads: Array<{
      id: string;
      question: string;
      options: string[];
      allowCustom: boolean;
    }> = [];
    setChooseHandler((p) => payloads.push(p));

    const promise = executeChoose({
      question: 'Deploy now or later?',
      options: ['Deploy now', 'Deploy later'],
    });

    // The handler fires synchronously before the tool starts waiting.
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.question).toBe('Deploy now or later?');
    expect(payloads[0]?.options).toEqual(['Deploy now', 'Deploy later']);

    const decision = resolveChoose(payloads[0]!.id, true, 'Deploy later');
    expect(decision).toBe(true);

    const raw = await promise;
    const result = JSON.parse(raw) as {
      approved: boolean;
      selected: string;
      selectedIndex: number;
      options: string[];
    };
    expect(result.approved).toBe(true);
    expect(result.selected).toBe('Deploy later');
    expect(result.selectedIndex).toBe(1);
  });

  it('supports free-text answers when allowCustom is set', async () => {
    let capturedId = '';
    setChooseHandler((p) => {
      capturedId = p.id;
    });

    const promise = executeChoose({
      question: 'Name the branch',
      options: ['main', 'develop'],
      allowCustom: true,
    });
    await wait(30);
    resolveChoose(capturedId, true, 'feature/custom-branch');

    const result = JSON.parse(await promise) as {
      selected: string;
      selectedIndex: number;
      customAnswer: boolean;
    };
    expect(result.selected).toBe('feature/custom-branch');
    expect(result.selectedIndex).toBe(-1);
    expect(result.customAnswer).toBe(true);
  });

  it('a plain approve (no encoded choice) falls back to the first option', async () => {
    let capturedId = '';
    setChooseHandler((p) => {
      capturedId = p.id;
    });

    const promise = executeChoose({ question: 'Proceed?', options: ['yes', 'no'] });
    await wait(30);
    // Simulate the existing desktop Approve button (approve_command without a choice).
    getChooseApprovalManager().approve(capturedId, 'user');

    const result = JSON.parse(await promise) as { selected: string; selectedIndex: number };
    expect(result.selected).toBe('yes');
    expect(result.selectedIndex).toBe(0);
  });

  it('denial throws an AgentError with code auth (not retryable)', async () => {
    let capturedId = '';
    setChooseHandler((p) => {
      capturedId = p.id;
    });

    const promise = executeChoose({ question: 'Proceed?', options: ['yes', 'no'] });
    await wait(30);
    resolveChoose(capturedId, false);

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AgentError);
      const agentErr = err as AgentError;
      expect(agentErr.code).toBe('auth');
      expect(agentErr.retryable).toBe(false);
      expect(agentErr.provider).toBe('choose');
      return true;
    });
  });

  it('manager deny (timeout path) also surfaces as auth AgentError', async () => {
    let capturedId = '';
    setChooseHandler((p) => {
      capturedId = p.id;
    });

    const promise = executeChoose({ question: 'Proceed?', options: ['yes', 'no'] });
    await wait(30);
    // What the 60s timeout does internally (denied by 'timeout').
    getChooseApprovalManager().deny(capturedId, 'timeout');

    await expect(promise).rejects.toMatchObject({ code: 'auth', retryable: false });
  });

  it('invalid arguments reject with invalid_request before any approval request', async () => {
    setChooseHandler(() => {
      throw new Error('handler must not be called for invalid args');
    });

    await expect(executeChoose({ options: ['a', 'b'] })).rejects.toMatchObject({
      code: 'invalid_request',
      provider: 'choose',
    });
    await expect(executeChoose({ question: 'q', options: ['only-one'] })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(executeChoose({ question: 'q', options: [] })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(getChooseApprovalManager().list()).toHaveLength(0); // nothing pending
  });
});
