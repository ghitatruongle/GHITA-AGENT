// v1.2.0-demo2 P3.1 (Điểm 3 + 4): cache best-effort cho AIPageController +
// cấu hình được trần retry và đưa `attempts` ra ngoài.
//
// Nguyên tắc bắt buộc (học từ stagehand):
//   • cache hit → replay deterministic, KHÔNG gọi LLM
//   • mọi lỗi cache → bỏ qua cache, gọi LLM thật (best-effort, không bao giờ
//     làm hỏng hành động)
//   • chỉ cache kết quả THÀNH CÔNG
//   • key KHÔNG chứa model → đổi model không invalidate cache

import { describe, it, expect, vi } from 'vitest';
import { BrowserController } from './index.js';
import { AIPageController, type AIBrowserContext } from './stagehand.js';
import { AIPageCache } from './stagehand-cache.js';

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

/** LLM giả: đếm số lần được gọi, luôn trả index 0. */
function countingLlm() {
  const fn = vi.fn(async () => JSON.stringify({ index: 0 }));
  return fn;
}

describe('AIPageCache', () => {
  it('gọi LLM đúng 1 lần cho 5 act() giống hệt nhau, 4 lần sau đó trả từ cache', async () => {
    const llm = countingLlm();
    const cache = new AIPageCache();
    const controller = new BrowserController({ click: async () => {} });
    const page = fakePage([{ tag: 'button', text: 'Login', id: 'login' }]);
    const ctx: AIBrowserContext = { llm: cache.wrap(llm) };
    const sh = new AIPageController(controller, page, ctx);

    for (let i = 0; i < 5; i++) {
      const r = await sh.act('click login');
      expect(r.success, `lần ${i + 1}`).toBe(true);
    }

    expect(llm).toHaveBeenCalledTimes(1);
    expect(cache.stats.hits).toBe(4);
    expect(cache.stats.misses).toBe(1);
  });

  it('cache key không phụ thuộc model — cùng trang thì vẫn dùng chung cache', async () => {
    const llmA = countingLlm();
    const llmB = countingLlm();
    const cache = new AIPageCache();
    const page = fakePage([{ tag: 'button', text: 'Login', id: 'login' }]);
    const controller = new BrowserController({ click: async () => {} });

    // "model khác" chỉ là một cặp option khác — không được nằm trong cache key.
    await new AIPageController(controller, page, {
      llm: cache.wrap(llmA),
      modelTag: 'opus',
    } as AIBrowserContext).act('click login');
    await new AIPageController(controller, page, {
      llm: cache.wrap(llmB),
      modelTag: 'sonnet',
    } as AIBrowserContext).act('click login');

    expect(llmA).toHaveBeenCalledTimes(1);
    expect(llmB).not.toHaveBeenCalled();
  });

  it('nội dung trang khác → gọi LLM lại (không trả nhầm selector cũ)', async () => {
    const llm = countingLlm();
    const cache = new AIPageCache();
    const controller = new BrowserController({ click: async () => {} });

    const pageA = fakePage([{ tag: 'button', text: 'Login', id: 'login' }]);
    const pageB = fakePage([{ tag: 'button', text: 'Logout', id: 'logout' }]);

    await new AIPageController(controller, pageA, { llm: cache.wrap(llm) }).act('click login');
    await new AIPageController(controller, pageB, { llm: cache.wrap(llm) }).act('click login');

    expect(llm).toHaveBeenCalledTimes(2);
  });

  it('lỗi LLM không bị cache — lần sau thử lại vẫn gọi LLM', async () => {
    // act() tự thử 2 lần, nên phải cho LLM hỏng 2 lần liên tiếp thì cả lượt
    // act() đầu mới thất bại. Lượt hỏng thứ 3 trở đi thành công.
    let calls = 0;
    const llm = vi.fn(async () => {
      calls++;
      if (calls <= 2) throw new Error('rate limited');
      return JSON.stringify({ index: 0 });
    });
    const cache = new AIPageCache();
    const controller = new BrowserController({ click: async () => {} });
    const page = fakePage([{ tag: 'button', text: 'Login', id: 'login' }]);
    const sh = new AIPageController(controller, page, { llm: cache.wrap(llm) });

    const first = await sh.act('click login');
    expect(first.success).toBe(false); // cả 2 lượt thử đều bị LLM từ chối
    expect(llm).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0); // lỗi KHÔNG được ghi vào cache

    const second = await sh.act('click login');
    expect(second.success).toBe(true);
    expect(llm).toHaveBeenCalledTimes(3); // vẫn gọi LLM thật, không dùng kết quả hỏng
    expect(cache.size).toBe(1); // chỉ cache kết quả thành công

    const third = await sh.act('click login');
    expect(third.success).toBe(true);
    expect(llm).toHaveBeenCalledTimes(3); // lượt 3 đi từ cache
  });

  it('BUG: câu trả lời rác KHÔNG được cache — LLM vốn có thể trả lời đúng ở lượt sau', async () => {
    // Trước đây set() chạy vô điều kiện, nên lời từ chối bị phát lại mãi.
    const cache = new AIPageCache();
    let n = 0;
    const w = cache.wrap(async () => {
      n++;
      return n === 1 ? "I'm sorry, I cannot help with that." : '{"index":0}';
    });

    const first = await w('p');
    const second = await w('p');

    expect(first).toContain('cannot help');
    expect(second).toBe('{"index":0}'); // phải hỏi lại LLM, không dùng kết quả rác
    expect(n).toBe(2);
    expect(cache.stats.rejected).toBe(1);
  });

  it('BUG: cùng prompt nhưng khác opts thì KHÔNG được dùng chung cache', async () => {
    const cache = new AIPageCache();
    const llm = vi.fn(async (_p: string, o?: { json?: boolean }) =>
      o?.json ? '{"a":1}' : 'plain text',
    );
    const w = cache.wrap(llm);
    const a = await w('cùng prompt', { json: true });
    const b = await w('cùng prompt', { json: false });
    expect(a).not.toBe(b);
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it('BUG: chuỗi rỗng không được cache', async () => {
    const cache = new AIPageCache();
    let n = 0;
    const w = cache.wrap(async () => {
      n++;
      return '';
    });
    await w('p');
    await w('p');
    expect(n).toBe(2);
  });

  it('lỗi bên trong cache không được làm hỏng hành động', async () => {
    const cache = new AIPageCache();
    // Cố tình làm hỏng Map để chứng minh cache best-effort.
    (cache as unknown as { map: Map<string, string> }).map = {
      get() {
        throw new Error('cache hỏng');
      },
      set() {
        throw new Error('cache hỏng');
      },
    } as unknown as Map<string, string>;

    const llm = countingLlm();
    const controller = new BrowserController({ click: async () => {} });
    const page = fakePage([{ tag: 'button', text: 'Login', id: 'login' }]);
    const sh = new AIPageController(controller, page, { llm: cache.wrap(llm) });

    const r = await sh.act('click login');
    expect(r.success).toBe(true); // vẫn chạy được nhờ rơi về LLM thật
    expect(llm).toHaveBeenCalledTimes(1);
  });
});

describe('AIPageController attempts (Điểm 4)', () => {
  it('giữ mặc định 2 lần thử (không hồi phục được vẫn là 2)', async () => {
    const controller = new BrowserController({
      click: async () => {
        throw new Error('detached node');
      },
    });
    const page = fakePage([{ tag: 'button', text: 'Save', id: 'save' }]);
    const r = await new AIPageController(controller, page).act('click save');
    expect(r.attempts).toBe(2);
    expect(r.success).toBe(false);
  });

  it('trần retry cấu hình được qua ctx.maxAttempts', async () => {
    const click = vi.fn(async () => {
      throw new Error('detached node');
    });
    const controller = new BrowserController({ click });
    const page = fakePage([{ tag: 'button', text: 'Save', id: 'save' }]);
    const sh = new AIPageController(controller, page, { maxAttempts: 4 });

    const r = await sh.act('click save');
    expect(r.attempts).toBe(4);
    expect(click).toHaveBeenCalledTimes(4);
  });

  it('báo cáo attempts qua onMetric để đưa lên UI/telemetry', async () => {
    const seen: number[] = [];
    let calls = 0;
    const click = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('detached node');
    });
    const controller = new BrowserController({ click });
    const page = fakePage([{ tag: 'button', text: 'Save', id: 'save' }]);
    const sh = new AIPageController(controller, page, {
      onMetric: (m) => seen.push(m.attempts),
    });

    await sh.act('click save');
    expect(seen).toEqual([2]);
  });
});
