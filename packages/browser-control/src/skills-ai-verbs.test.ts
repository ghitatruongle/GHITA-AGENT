// v0.0.1 T6.2: AI page verbs (stagehand observe/act/extract) wired as skills.
//
// Uses a fake playwright-like page ($$eval) plus stubbed BrowserController
// adapters to verify browser.observe / browser.act / browser.extract: happy
// paths, no-llm and browser-not-ready error paths, and the legacy plain-text
// extract behaviour — all without a real browser or real LLM.

import { describe, it, expect, vi } from 'vitest';
import type { SkillDefinition, SkillInvocation } from '@ghita/skills';
import {
  AI_PROVIDER_NOT_CONFIGURED_ERROR,
  BROWSER_PAGE_UNAVAILABLE_ERROR,
  BROWSER_SESSION_NOT_READY_ERROR,
  BrowserController,
  createBrowserControlSkills,
  type BrowserControlAdapter,
} from './index.js';
import type { ObserveResult, SchemaLike } from './stagehand.js';

/** Fake page exposing $$eval like Playwright, returning fixed elements. */
function fakePage(
  elements: Array<{ tag: string; text: string; id?: string; attrs?: Record<string, string> }>,
) {
  return {
    $$eval: async (_sel: string, _fn: (els: Element[]) => unknown) =>
      elements.map((e, idx) => ({
        selector: e.tag + (e.id ? `#${e.id}` : ''),
        text: e.text,
        tag: e.tag,
        attrs: e.attrs ?? {},
        index: idx,
      })),
  };
}

/** Controller with a ready session (as if browser.open had run). */
async function readyController(adapter: BrowserControlAdapter): Promise<BrowserController> {
  const controller = new BrowserController({
    launch: vi.fn().mockResolvedValue(undefined),
    ...adapter,
  });
  await controller.launch();
  return controller;
}

function skillOf(skills: ReturnType<typeof createBrowserControlSkills>, id: string) {
  const skill = skills.find((s) => s.id === id);
  expect(skill, `skill ${id} should be registered`).toBeDefined();
  return skill!;
}

/** Run a skill with a stub execution context (AI verbs never touch it). */
function runSkill(skill: SkillDefinition, invocation: SkillInvocation) {
  return skill.run(invocation, { registry: {}, now: () => Date.now(), adapters: {} });
}

describe('AI verb skill registration (T6.2)', () => {
  it('registers browser.observe / browser.act / browser.extract like other browser skills', () => {
    const skills = createBrowserControlSkills();
    for (const id of ['browser.observe', 'browser.act', 'browser.extract']) {
      const skill = skills.find((s) => s.id === id);
      expect(skill).toBeDefined();
      expect(skill?.category).toBe('browser');
      expect(skill?.enabled).toBe(false);
      expect(skill?.status).toBe('disabled');
      expect(skill?.scopes).toEqual(['browser']);
    }
  });
});

describe('browser.observe skill', () => {
  it('returns page candidates when the session is ready and llm is provided', async () => {
    const llm = vi.fn(async () => '{"index":0}');
    const controller = await readyController({
      click: vi.fn().mockResolvedValue(undefined),
      getPage: () =>
        fakePage([
          { tag: 'button', text: 'Login', id: 'login' },
          { tag: 'input', text: '', attrs: { placeholder: 'Email' } },
        ]),
    });
    const skills = createBrowserControlSkills(controller);
    const observe = skillOf(skills, 'browser.observe');

    const result = await runSkill(observe, { input: { llm } });
    expect(result.success).toBe(true);
    const data = result.data as { count: number; elements: ObserveResult[] };
    expect(data.count).toBe(2);
    expect(data.elements[0]?.selector).toBe('button#login');
    expect(data.elements[0]?.suggestedAction).toBe('click');
    expect(data.elements[1]?.suggestedAction).toBe('fill');
  });

  it('narrows to the best match for an instruction via the llm', async () => {
    const llm = vi.fn(async () => '{"index":1}');
    const controller = await readyController({
      getPage: () =>
        fakePage([
          { tag: 'button', text: 'Login', id: 'login' },
          { tag: 'button', text: 'Cancel', id: 'cancel' },
        ]),
    });
    const skills = createBrowserControlSkills(controller);
    const observe = skillOf(skills, 'browser.observe');

    const result = await runSkill(observe, {
      input: { instruction: 'the cancel button', llm },
    });
    expect(result.success).toBe(true);
    const data = result.data as { count: number; elements: ObserveResult[] };
    expect(data.count).toBe(1);
    expect(data.elements[0]?.selector).toBe('button#cancel');
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('falls back to the host aiContext llm when input has none', async () => {
    const llm = vi.fn(async () => '{"index":0}');
    const controller = await readyController({
      getPage: () => fakePage([{ tag: 'button', text: 'Login', id: 'login' }]),
    });
    const skills = createBrowserControlSkills(controller, { aiContext: { llm } });
    const observe = skillOf(skills, 'browser.observe');

    // An instruction is required for the llm to actually be consulted.
    const result = await runSkill(observe, { input: { instruction: 'the login button' } });
    expect(result.success).toBe(true);
    const data = result.data as { elements: ObserveResult[] };
    expect(data.elements[0]?.selector).toBe('button#login');
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('reports a clear error when no AI provider is configured', async () => {
    const controller = await readyController({
      getPage: () => fakePage([{ tag: 'button', text: 'Login', id: 'login' }]),
    });
    const skills = createBrowserControlSkills(controller);
    const observe = skillOf(skills, 'browser.observe');

    const result = await runSkill(observe, { input: {} });
    expect(result.success).toBe(false);
    expect(result.error).toBe(AI_PROVIDER_NOT_CONFIGURED_ERROR);
  });

  it('reports a clear error when the browser session is not ready', async () => {
    const skills = createBrowserControlSkills(new BrowserController());
    const observe = skillOf(skills, 'browser.observe');

    const result = await runSkill(observe, { input: { llm: async () => '{"index":0}' } });
    expect(result.success).toBe(false);
    expect(result.error).toBe(BROWSER_SESSION_NOT_READY_ERROR);
  });

  it('reports a clear error when the adapter exposes no page handle', async () => {
    const controller = await readyController({});
    const skills = createBrowserControlSkills(controller);
    const observe = skillOf(skills, 'browser.observe');

    const result = await runSkill(observe, { input: { llm: async () => '{"index":0}' } });
    expect(result.success).toBe(false);
    expect(result.error).toBe(BROWSER_PAGE_UNAVAILABLE_ERROR);
  });
});

describe('browser.act skill', () => {
  it('clicks the matched element', async () => {
    const click = vi.fn(async () => {});
    const llm = vi.fn(async () => '{"index":0}');
    const controller = await readyController({
      click,
      getPage: () => fakePage([{ tag: 'button', text: 'Login', id: 'login' }]),
    });
    const skills = createBrowserControlSkills(controller);
    const act = skillOf(skills, 'browser.act');

    const result = await runSkill(act, { input: { instruction: 'click login', llm } });
    expect(result.success).toBe(true);
    const data = result.data as { action: string; selector: string; attempts: number };
    expect(data.action).toBe('click');
    expect(data.selector).toBe('button#login');
    expect(click).toHaveBeenCalledWith('button#login');
  });

  it('fills a field using the value input', async () => {
    const fill = vi.fn(async () => {});
    const llm = vi.fn(async () => '{"index":0}');
    const controller = await readyController({
      fill,
      getPage: () =>
        fakePage([{ tag: 'input', text: '', id: 'email', attrs: { placeholder: 'Email' } }]),
    });
    const skills = createBrowserControlSkills(controller);
    const act = skillOf(skills, 'browser.act');

    const result = await runSkill(act, {
      input: { instruction: 'fill the email field', value: 'typed value', llm },
    });
    expect(result.success).toBe(true);
    expect(fill).toHaveBeenCalledWith('input#email', 'typed value');
  });

  it('reports a clear error when instruction is missing', async () => {
    const controller = await readyController({
      getPage: () => fakePage([{ tag: 'button', text: 'Login', id: 'login' }]),
    });
    const skills = createBrowserControlSkills(controller);
    const act = skillOf(skills, 'browser.act');

    const result = await runSkill(act, { input: { llm: async () => '{"index":0}' } });
    expect(result.success).toBe(false);
    expect(result.error).toContain('instruction');
  });

  it('reports a clear error when the browser session is not ready', async () => {
    const skills = createBrowserControlSkills(new BrowserController());
    const act = skillOf(skills, 'browser.act');

    const result = await runSkill(act, {
      input: { instruction: 'click login', llm: async () => '{}' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe(BROWSER_SESSION_NOT_READY_ERROR);
  });

  it('reports a clear error when no AI provider is configured', async () => {
    const controller = await readyController({
      click: vi.fn(async () => {}),
      getPage: () => fakePage([{ tag: 'button', text: 'Login', id: 'login' }]),
    });
    const skills = createBrowserControlSkills(controller);
    const act = skillOf(skills, 'browser.act');

    const result = await runSkill(act, { input: { instruction: 'click login' } });
    expect(result.success).toBe(false);
    expect(result.error).toBe(AI_PROVIDER_NOT_CONFIGURED_ERROR);
  });
});

describe('browser.extract skill (AI mode)', () => {
  const titleSchema: SchemaLike<{ title: string }> = {
    safeParse: (data) => {
      const d = data as { title?: unknown };
      return typeof d.title === 'string'
        ? { success: true, data: { title: d.title } }
        : { success: false, error: 'title must be a string' };
    },
  };

  it('AI-extracts structured data and validates it against the schema', async () => {
    const llm = vi.fn(async () => '{"title":"Hello"}');
    const controller = await readyController({
      extractText: vi.fn().mockResolvedValue('Hello world page text'),
    });
    const skills = createBrowserControlSkills(controller);
    const extract = skillOf(skills, 'browser.extract');

    const result = await runSkill(extract, {
      input: { query: 'the page title', schema: titleSchema, llm },
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ title: 'Hello' });
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('extracts without a schema (llm output passed through)', async () => {
    const llm = vi.fn(async () => '{"title":"T","author":"A"}');
    const controller = await readyController({
      extractText: vi.fn().mockResolvedValue('text'),
    });
    const skills = createBrowserControlSkills(controller);
    const extract = skillOf(skills, 'browser.extract');

    const result = await runSkill(extract, { input: { query: 'title and author', llm } });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ title: 'T', author: 'A' });
  });

  it('reports a validation failure when the schema rejects the data', async () => {
    const llm = vi.fn(async () => '{"title":123}');
    const controller = await readyController({
      extractText: vi.fn().mockResolvedValue('text'),
    });
    const skills = createBrowserControlSkills(controller);
    const extract = skillOf(skills, 'browser.extract');

    const result = await runSkill(extract, {
      input: { query: 'title', schema: titleSchema, llm },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('schema validation');
  });

  it('rejects a schema that does not expose safeParse', async () => {
    const controller = await readyController({
      extractText: vi.fn().mockResolvedValue('text'),
    });
    const skills = createBrowserControlSkills(controller);
    const extract = skillOf(skills, 'browser.extract');

    const result = await runSkill(extract, {
      input: { query: 'title', schema: { type: 'object' }, llm: async () => '{}' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('safeParse');
  });

  it('reports a clear error when the browser session is not ready (AI mode only)', async () => {
    const skills = createBrowserControlSkills(new BrowserController());
    const extract = skillOf(skills, 'browser.extract');

    const result = await runSkill(extract, {
      input: { query: 'title', llm: async () => '{"title":"x"}' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe(BROWSER_SESSION_NOT_READY_ERROR);
  });

  it('keeps the legacy plain-text path working without a query/schema', async () => {
    const extractText = vi.fn().mockResolvedValue('Hello');
    const controller = await readyController({ extractText });
    const skills = createBrowserControlSkills(controller);
    const extract = skillOf(skills, 'browser.extract');

    const result = await runSkill(extract, { input: {} });
    expect(result.success).toBe(true);
    expect(extractText).toHaveBeenCalledTimes(1);
    // Legacy path also works before any launch (no session gate).
    const idleController = new BrowserController({ extractText });
    const idleSkills = createBrowserControlSkills(idleController);
    const idleExtract = idleSkills.find((s) => s.id === 'browser.extract');
    const idleResult = idleExtract
      ? await runSkill(idleExtract, { input: { selector: '.content' } })
      : undefined;
    expect(idleResult?.success).toBe(true);
    expect(extractText).toHaveBeenCalledWith('.content');
  });
});
