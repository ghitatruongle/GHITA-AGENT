import type { BrowserController } from './index.js';

export interface AIBrowserContext {
  /** Optional LLM caller injected by the host (ai-engine). */
  llm?: (prompt: string, opts?: { json?: boolean; maxTokens?: number }) => Promise<string>;
  /** Maximum candidate elements passed to the LLM per call. */
  maxCandidates?: number;
  /** Timeout for one LLM call in ms. */
  timeoutMs?: number;
  /**
   * Trần số lần thử khi hành động hỏng (self-heal). Mặc định 2.
   * demo2 P3.1 (Điểm 4): trước đây cứng, không cấu hình được.
   */
  maxAttempts?: number;
  /**
   * Nhận số liệu sau mỗi lượt act — đẩy lên UI/telemetry.
   * demo2 P3.1 (Điểm 4): trước đây `attempts` không đi đâu.
   */
  onMetric?: (m: ActMetric) => void;
}

/** Số liệu một lượt hành động. */
export interface ActMetric {
  /** Số lần thử đã dùng (kể cả lượt retry do self-heal). */
  attempts: number;
  success: boolean;
  action: 'click' | 'fill';
  /** Có tự hồi phục được hay không (thử > 1 lần mới thành công). */
  recovered: boolean;
  error?: string;
}

export interface PageElementCandidate {
  /** Best-effort CSS selector (may include :nth-of-type). */
  selector: string;
  /** Visible text content (truncated). */
  text: string;
  /** Tag name (button, a, input, etc.). */
  tag: string;
  /** Optional attributes useful for the LLM (type, name, placeholder, href). */
  attrs: Record<string, string>;
}

export interface AIBrowserResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  /** Elements the LLM considered, for debugging. */
  candidates?: PageElementCandidate[];
}

/**
 * Heuristic: enumerate visible interactive elements. Keeps the candidate
 * set small (≤ maxCandidates) so it fits in an LLM context.
 */
export async function collectCandidates(page: unknown, max = 30): Promise<PageElementCandidate[]> {
  const p = page as {
    $$eval: (sel: string, fn: (els: Element[]) => unknown) => Promise<unknown>;
  };
  if (!p?.$$eval) return [];

  const raw = (await p.$$eval('a, button, input, textarea, select, [role="button"]', (els) =>
    (els as Element[]).map((el, idx) => {
      const attrs: Record<string, string> = {};
      for (const a of ['type', 'name', 'placeholder', 'aria-label', 'href']) {
        const v = el.getAttribute(a);
        if (v) attrs[a] = v;
      }
      return {
        selector:
          el.tagName.toLowerCase() +
          (el.id ? `#${el.id}` : '') +
          (el.className && typeof el.className === 'string'
            ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
            : ''),
        text: (el.textContent ?? '').trim().slice(0, 80),
        tag: el.tagName.toLowerCase(),
        attrs,
        index: idx,
      };
    }),
  )) as Array<Omit<PageElementCandidate, 'selector'> & { selector: string; index: number }>;

  return raw.slice(0, max).map(({ index, ...rest }) => ({
    selector: rest.selector || `${rest.tag}:nth-of-type(${index + 1})`,
    text: rest.text,
    tag: rest.tag,
    attrs: rest.attrs,
  }));
}

/**
 * Ask the LLM which selector matches a natural-language intent.
 * Falls back to a keyword match when no LLM is provided.
 */
export async function resolveSelectorByIntent(
  intent: string,
  candidates: PageElementCandidate[],
  ctx: AIBrowserContext = {},
): Promise<PageElementCandidate | null> {
  if (candidates.length === 0) return null;

  if (!ctx.llm) {
    const needle = intent.toLowerCase();
    const hit =
      candidates.find((c) => c.text.toLowerCase().includes(needle)) ??
      candidates.find((c) => Object.values(c.attrs).some((v) => v.toLowerCase().includes(needle)));
    return hit ?? null;
  }

  const prompt = [
    'You are a browser automation assistant.',
    'Pick the SINGLE element that best matches the user intent.',
    'Respond with JSON only: {"index": <number>} or {"index": -1}.',
    '',
    `Intent: ${intent}`,
    '',
    'Candidates:',
    ...candidates.map(
      (c, i) =>
        `[${i}] <${c.tag}> selector="${c.selector}" text="${c.text}" attrs=${JSON.stringify(c.attrs)}`,
    ),
  ].join('\n');

  try {
    const raw = await Promise.race([
      ctx.llm(prompt, { json: true, maxTokens: 64 }),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('LLM timeout')), ctx.timeoutMs ?? 8000),
      ),
    ]);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { index?: number };
    const idx = typeof parsed.index === 'number' ? parsed.index : -1;
    return idx >= 0 && idx < candidates.length ? (candidates[idx] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Click an element by natural-language description.
 */
export async function aiClick(
  controller: BrowserController,
  intent: string,
  page: unknown,
  ctx: AIBrowserContext = {},
): Promise<AIBrowserResult<{ selector: string }>> {
  const candidates = await collectCandidates(page, ctx.maxCandidates ?? 30);
  if (candidates.length === 0) {
    return { success: false, error: 'No interactive elements found on page.' };
  }
  const target = await resolveSelectorByIntent(intent, candidates, ctx);
  if (!target) {
    return {
      success: false,
      error: `No element matches intent: ${intent}`,
      candidates,
    };
  }
  const result = await controller.click(target.selector);
  return {
    success: result.success,
    data: { selector: target.selector },
    error: result.error,
    candidates,
  };
}

/**
 * Extract structured data using a JSON schema description.
 * The LLM maps the visible page text into the requested shape.
 */
export async function aiExtract<T = Record<string, unknown>>(
  controller: BrowserController,
  schemaDescription: string,
  _page: unknown,
  ctx: AIBrowserContext = {},
): Promise<AIBrowserResult<T>> {
  const textResult = await controller.extract();
  if (!textResult.success || typeof textResult.data !== 'string') {
    return { success: false, error: textResult.error ?? 'extract failed' };
  }
  if (!ctx.llm) {
    return {
      success: true,
      data: { raw: textResult.data } as unknown as T,
    };
  }
  const prompt = [
    'Extract structured data from the page text below.',
    'Return ONLY a JSON object matching the schema description.',
    '',
    `Schema: ${schemaDescription}`,
    '',
    'Page text:',
    textResult.data.slice(0, 4000),
  ].join('\n');

  try {
    const raw = await Promise.race([
      ctx.llm(prompt, { json: true, maxTokens: 1024 }),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('LLM timeout')), ctx.timeoutMs ?? 12000),
      ),
    ]);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { success: false, error: 'LLM did not return JSON' };
    return { success: true, data: JSON.parse(match[0]) as T };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
