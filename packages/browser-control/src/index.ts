import type { SkillDefinition } from '@ghita/skills';
import type { BrowserAction, BrowserResult } from '@ghita/shared';

export const BROWSER_CONTROL_VERSION = '0.0.0-preview';

export type BrowserSessionStatus = 'idle' | 'launching' | 'ready' | 'closed' | 'error';

export interface BrowserSessionState {
  status: BrowserSessionStatus;
  currentUrl?: string;
  lastError?: string;
  launchedAt?: number;
}

export interface BrowserControlAdapter {
  launch?: (options?: { headless?: boolean }) => Promise<void>;
  close?: () => Promise<void>;
  navigate?: (url: string) => Promise<void>;
  click?: (selector: string) => Promise<void>;
  type?: (selector: string, value: string) => Promise<void>;
  fill?: (selector: string, value: string) => Promise<void>;
  extractText?: (selector?: string) => Promise<string>;
  screenshot?: () => Promise<{ mimeType: string; data: string }>;
}

function ok(data?: string | Record<string, unknown>, screenshot?: string): BrowserResult {
  return { success: true, data, screenshot };
}

function fail(error: string): BrowserResult {
  return { success: false, error };
}

function readString(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export class BrowserController {
  private state: BrowserSessionState = { status: 'idle' };

  constructor(private readonly adapter: BrowserControlAdapter = {}) {}

  getState(): BrowserSessionState {
    return { ...this.state };
  }

  async launch(options?: { headless?: boolean }): Promise<BrowserResult> {
    if (!this.adapter.launch) return fail('Browser launch adapter is not available.');

    this.state = { status: 'launching' };
    try {
      await this.adapter.launch(options);
      this.state = { status: 'ready', launchedAt: Date.now() };
      return ok({ status: this.state.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state = { status: 'error', lastError: message };
      return fail(message);
    }
  }

  async close(): Promise<BrowserResult> {
    if (!this.adapter.close) return fail('Browser close adapter is not available.');
    await this.adapter.close();
    this.state = { status: 'closed' };
    return ok({ status: this.state.status });
  }

  async navigate(url: string): Promise<BrowserResult> {
    if (!this.adapter.navigate) return fail('Browser navigation adapter is not available.');
    await this.adapter.navigate(url);
    this.state = { ...this.state, status: 'ready', currentUrl: url };
    return ok({ url });
  }

  async click(selector: string): Promise<BrowserResult> {
    if (!this.adapter.click) return fail('Browser click adapter is not available.');
    await this.adapter.click(selector);
    return ok({ selector });
  }

  async fill(selector: string, value: string): Promise<BrowserResult> {
    const handler = this.adapter.fill ?? this.adapter.type;
    if (!handler) return fail('Browser fill adapter is not available.');
    await handler(selector, value);
    return ok({ selector, valueLength: value.length });
  }

  async extract(selector?: string): Promise<BrowserResult> {
    if (!this.adapter.extractText) return fail('Browser extract adapter is not available.');
    const text = await this.adapter.extractText(selector);
    return ok(text);
  }

  async screenshot(): Promise<BrowserResult> {
    if (!this.adapter.screenshot) return fail('Browser screenshot adapter is not available.');
    const capture = await this.adapter.screenshot();
    return ok({ mimeType: capture.mimeType }, capture.data);
  }

  async runAction(action: BrowserAction): Promise<BrowserResult> {
    switch (action.type) {
      case 'navigate':
        return action.url ? this.navigate(action.url) : fail('Missing url.');
      case 'click':
        return action.selector ? this.click(action.selector) : fail('Missing selector.');
      case 'type':
      case 'fill':
        return action.selector && action.value !== undefined
          ? this.fill(action.selector, action.value)
          : fail('Missing selector or value.');
      case 'extract':
        return this.extract(action.selector);
      case 'screenshot':
        return this.screenshot();
    }
  }
}

function toSkillResult(result: BrowserResult) {
  return {
    success: result.success,
    output: typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? {}),
    error: result.error,
    data: result,
  };
}

export function createBrowserControlSkills(
  controller = new BrowserController(),
): SkillDefinition[] {
  return [
    {
      id: 'browser.open',
      name: 'Open Browser',
      description: 'Launch a controlled browser session.',
      category: 'browser',
      enabled: false,
      version: BROWSER_CONTROL_VERSION,
      scopes: ['browser'],
      status: 'disabled',
      run: async () => toSkillResult(await controller.launch({ headless: false })),
    },
    {
      id: 'browser.close',
      name: 'Close Browser',
      description: 'Close the controlled browser session and release its resources.',
      category: 'browser',
      enabled: false,
      version: BROWSER_CONTROL_VERSION,
      scopes: ['browser'],
      status: 'disabled',
      run: async () => toSkillResult(await controller.close()),
    },
    {
      id: 'browser.navigate',
      name: 'Navigate Browser',
      description: 'Navigate the controlled browser to a URL.',
      category: 'browser',
      enabled: false,
      version: BROWSER_CONTROL_VERSION,
      scopes: ['browser'],
      status: 'disabled',
      parameters: {
        url: { type: 'string', description: 'URL to open', required: true },
      },
      run: async ({ input }) => {
        const url = readString(input, 'url');
        if (!url) return { success: false, error: 'Missing required input: url' };
        return toSkillResult(await controller.navigate(url));
      },
    },
    {
      id: 'browser.click',
      name: 'Click Browser Element',
      description: 'Click an element in the controlled page using a CSS selector.',
      category: 'browser',
      enabled: false,
      version: BROWSER_CONTROL_VERSION,
      scopes: ['browser'],
      status: 'disabled',
      parameters: {
        selector: { type: 'string', description: 'CSS selector to click', required: true },
      },
      run: async ({ input }) => {
        const selector = readString(input, 'selector');
        if (!selector) return { success: false, error: 'Missing required input: selector' };
        return toSkillResult(await controller.click(selector));
      },
    },
    {
      id: 'browser.extract',
      name: 'Extract Page Text',
      description: 'Extract text from the page or a selector.',
      category: 'browser',
      enabled: false,
      version: BROWSER_CONTROL_VERSION,
      scopes: ['browser'],
      status: 'disabled',
      parameters: {
        selector: { type: 'string', description: 'Optional CSS selector', required: false },
      },
      run: async ({ input }) =>
        toSkillResult(await controller.extract(readString(input, 'selector'))),
    },
    {
      id: 'browser.screenshot',
      name: 'Capture Browser Screenshot',
      description: 'Capture a screenshot of the controlled page.',
      category: 'browser',
      enabled: false,
      version: BROWSER_CONTROL_VERSION,
      scopes: ['browser'],
      status: 'disabled',
      run: async () => toSkillResult(await controller.screenshot()),
    },
    {
      id: 'browser.fill',
      name: 'Fill Browser Field',
      description: 'Fill a browser input field.',
      category: 'browser',
      enabled: false,
      version: BROWSER_CONTROL_VERSION,
      scopes: ['browser'],
      status: 'disabled',
      parameters: {
        selector: { type: 'string', description: 'CSS selector', required: true },
        value: { type: 'string', description: 'Value to enter', required: true },
      },
      run: async ({ input }) => {
        const selector = readString(input, 'selector');
        const value = readString(input, 'value');
        if (!selector || value === undefined)
          return { success: false, error: 'Missing selector or value' };
        return toSkillResult(await controller.fill(selector, value));
      },
    },
  ];
}

export * from './dom-extractor.js';

// v0.4.9 A6: AI page API — act/extract/observe
export { AIPageController } from './stagehand.js';
export type { SchemaLike, ObserveResult, ActResult, ExtractResult } from './stagehand.js';

export { BrowserMCPServer, createBrowserMCPServer } from './mcp-server.js';
export type { BrowserLike, BrowserMCPServerConfig } from './mcp-server.js';

export * from './track7/index.js';

export {
  isUrlAllowed,
  evaluatePopup,
  redactSensitiveData,
  redactHarEntry,
  DEFAULT_DOMAIN_POLICY,
} from './browser-safety.js';
export type { DomainPolicy, PopupDecision, RedactionResult } from './browser-safety.js';
export {
  runStealthPreflight,
  checkTimezoneConsistency,
  checkLocaleConsistency,
  checkWebRtcConsistency,
  humanizeScrollSteps,
} from './stealth-v2.js';
export type { ConsistencyCheck, PreflightReport, ScrollStep } from './stealth-v2.js';
