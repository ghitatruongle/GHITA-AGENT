import type { SkillDefinition } from '@ghita/skills';
import type { BrowserAction, BrowserResult } from '@ghita/shared';
import { AIPageController } from './stagehand.js';
import type { AIBrowserContext } from './ai-browser.js';
import type { SchemaLike } from './stagehand.js';

export const BROWSER_CONTROL_VERSION = '0.0.1';

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
  /**
   * Raw page handle for the AI page verbs (v0.0.1 T6.2) — a playwright-like
   * object exposing `$$eval`. Optional: AI verb skills report a clear error
   * when the adapter cannot expose a live page.
   */
  getPage?: () => unknown;
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

  /**
   * Raw page handle for the AI page verbs (T6.2) — whatever the adapter
   * exposes (playwright-like object with `$$eval`); undefined when the
   * adapter has no page accessor or nothing is launched.
   */
  getPage(): unknown {
    return this.adapter.getPage?.();
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

// ---- AI page verbs (v0.0.1 T6.2: stagehand observe/act/extract as skills) ----

/** Error returned when no AI provider callable is reachable from the skill. */
export const AI_PROVIDER_NOT_CONFIGURED_ERROR =
  'AI provider not configured — pass input.llm or configure provider';

/** Error returned when the session was never launched (or already closed). */
export const BROWSER_SESSION_NOT_READY_ERROR =
  'Browser session not ready — call browser.open first';

/** Error returned when the adapter cannot expose a live page handle. */
export const BROWSER_PAGE_UNAVAILABLE_ERROR =
  'Browser adapter does not expose a page handle — AI verbs need adapter.getPage';

/** Host-side injection point for the AI page verbs (llm, limits, telemetry). */
export interface BrowserControlSkillsOptions {
  /** AI context used when the skill input does not carry its own `llm`. */
  aiContext?: AIBrowserContext;
}

type LlmFn = NonNullable<AIBrowserContext['llm']>;

/**
 * Resolve the LLM callable for an AI verb invocation: `input.llm` (callable,
 * passed in-process by the caller) wins over the host `aiContext.llm`.
 */
function resolveAiContext(
  input: Record<string, unknown> | undefined,
  hostContext: AIBrowserContext | undefined,
): AIBrowserContext | undefined {
  const candidate = input?.llm;
  const llm: LlmFn | undefined =
    typeof candidate === 'function' ? (candidate as LlmFn) : hostContext?.llm;
  if (!llm) return undefined;
  return { ...(hostContext ?? {}), llm };
}

/** Skill result shape for the AI verbs: full payload in `data`, JSON in `output`. */
function toAiVerbResult(payload: { success: boolean; error?: string } & Record<string, unknown>) {
  return {
    success: payload.success,
    output: JSON.stringify(payload),
    error: payload.error,
    data: payload,
  };
}

/** Map a thrown error to a fail result — AI verbs never crash the caller. */
function toAiVerbError(error: unknown) {
  return {
    success: false as const,
    error: error instanceof Error ? error.message : String(error),
  };
}

export function createBrowserControlSkills(
  controller = new BrowserController(),
  options: BrowserControlSkillsOptions = {},
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
      description:
        'Extract text from the page or a selector; when a query (and optional schema) is ' +
        'provided, AI-extracts structured data matching it instead (AI provider required).',
      category: 'browser',
      enabled: false,
      version: BROWSER_CONTROL_VERSION,
      scopes: ['browser'],
      status: 'disabled',
      parameters: {
        selector: {
          type: 'string',
          description: 'Optional CSS selector (plain text mode)',
          required: false,
        },
        query: {
          type: 'string',
          description:
            'Optional natural-language description of the data to extract — switches to AI structured extraction',
          required: false,
        },
        schema: {
          type: 'string',
          description:
            'Optional zod-compatible schema object exposing safeParse(data) to validate the AI extraction result',
          required: false,
        },
        llm: {
          type: 'string',
          description:
            'Optional AI provider callable passed by the host: input.llm(prompt, opts?) => Promise<string>',
          required: false,
        },
      },
      run: async ({ input }) => {
        const query = readString(input, 'query');
        const rawSchema = input?.schema;
        if (query === undefined && rawSchema === undefined) {
          // Legacy plain-text extraction path (unchanged behaviour).
          return toSkillResult(await controller.extract(readString(input, 'selector')));
        }
        // AI structured extraction path (T6.2).
        if (controller.getState().status !== 'ready')
          return { success: false, error: BROWSER_SESSION_NOT_READY_ERROR };
        const aiContext = resolveAiContext(input, options.aiContext);
        if (!aiContext) return { success: false, error: AI_PROVIDER_NOT_CONFIGURED_ERROR };
        let schema: SchemaLike<unknown> | undefined;
        if (rawSchema !== undefined) {
          if (
            typeof rawSchema !== 'object' ||
            rawSchema === null ||
            typeof (rawSchema as { safeParse?: unknown }).safeParse !== 'function'
          ) {
            return {
              success: false,
              error: 'schema must be a zod-compatible object exposing safeParse(data)',
            };
          }
          schema = rawSchema as SchemaLike<unknown>;
        }
        try {
          const aiPage = new AIPageController(controller, controller.getPage(), aiContext);
          const result = await aiPage.extract<unknown>(query ?? 'Extract the requested data.', schema);
          if (!result.success) {
            return {
              success: false,
              output: '{}',
              error: result.error ?? 'AI extraction failed',
              data: result,
            };
          }
          return {
            success: true,
            output: JSON.stringify(result.data ?? {}),
            data: result.data,
          };
        } catch (error) {
          return toAiVerbError(error);
        }
      },
    },
    {
      id: 'browser.observe',
      name: 'Observe Browser Page (AI)',
      description:
        'Enumerate actionable page elements (clickable/fillable) via the AI page API, ' +
        'optionally narrowing to the best match for a natural-language instruction (AI provider required).',
      category: 'browser',
      enabled: false,
      version: BROWSER_CONTROL_VERSION,
      scopes: ['browser'],
      status: 'disabled',
      parameters: {
        instruction: {
          type: 'string',
          description: 'Optional natural-language element to look for (e.g. "the login button")',
          required: false,
        },
        llm: {
          type: 'string',
          description:
            'Optional AI provider callable passed by the host: input.llm(prompt, opts?) => Promise<string>',
          required: false,
        },
      },
      run: async ({ input }) => {
        if (controller.getState().status !== 'ready')
          return { success: false, error: BROWSER_SESSION_NOT_READY_ERROR };
        const aiContext = resolveAiContext(input, options.aiContext);
        if (!aiContext) return { success: false, error: AI_PROVIDER_NOT_CONFIGURED_ERROR };
        try {
          const page = controller.getPage();
          if (page === undefined) return { success: false, error: BROWSER_PAGE_UNAVAILABLE_ERROR };
          const aiPage = new AIPageController(controller, page, aiContext);
          const results = await aiPage.observe(readString(input, 'instruction'));
          return toAiVerbResult({ success: true, count: results.length, elements: results });
        } catch (error) {
          return toAiVerbError(error);
        }
      },
    },
    {
      id: 'browser.act',
      name: 'Act On Browser Page (AI)',
      description:
        'Perform a natural-language action on the page (click or fill) via the AI page API, ' +
        'with selector self-heal retries (AI provider required).',
      category: 'browser',
      enabled: false,
      version: BROWSER_CONTROL_VERSION,
      scopes: ['browser'],
      status: 'disabled',
      parameters: {
        instruction: {
          type: 'string',
          description: 'Natural-language action to perform (e.g. "click login", "type \\"hi\\" into search")',
          required: true,
        },
        value: {
          type: 'string',
          description: 'Optional value to type when the action fills a field',
          required: false,
        },
        llm: {
          type: 'string',
          description:
            'Optional AI provider callable passed by the host: input.llm(prompt, opts?) => Promise<string>',
          required: false,
        },
      },
      run: async ({ input }) => {
        const instruction = readString(input, 'instruction');
        if (!instruction) return { success: false, error: 'Missing required input: instruction' };
        if (controller.getState().status !== 'ready')
          return { success: false, error: BROWSER_SESSION_NOT_READY_ERROR };
        const aiContext = resolveAiContext(input, options.aiContext);
        if (!aiContext) return { success: false, error: AI_PROVIDER_NOT_CONFIGURED_ERROR };
        try {
          const page = controller.getPage();
          if (page === undefined) return { success: false, error: BROWSER_PAGE_UNAVAILABLE_ERROR };
          const aiPage = new AIPageController(controller, page, aiContext);
          const result = await aiPage.act(instruction, readString(input, 'value'));
          return toAiVerbResult({ ...result });
        } catch (error) {
          return toAiVerbError(error);
        }
      },
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
