// Built-in blocks. Categories mirror AutoGPT's library (io / ai / logic /
// tool / human / code / graph), reduced to the seams Ghita Agent already
// has: ai-engine LLM calls, ReAct tools, track5 human-input, ghita-sandbox.

import { HumanMessage, SystemMessage } from '../messages/message.js';
import type { BaseMessage } from '../messages/message.js';
import type { BlockContext, BlockDefinition } from './types.js';
import { BlockRegistry } from './registry.js';

const STRING_SCHEMA = { type: 'string' } as const;
const ERROR_SCHEMA = { type: 'string' } as const;

/** Extract the first JSON object/array from an LLM answer (fenced or raw). */
function extractJson(text: string): unknown {
  const fenced = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/```\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const startArray = candidate.indexOf('[');
  const from = start === -1 ? startArray : startArray === -1 ? start : Math.min(start, startArray);
  if (from === -1) return undefined;
  const lastCurly = candidate.lastIndexOf('}');
  const lastSquare = candidate.lastIndexOf(']');
  const to = Math.max(lastCurly, lastSquare);
  if (to <= from) return undefined;
  try {
    return JSON.parse(candidate.slice(from, to + 1));
  } catch {
    return undefined;
  }
}

const inputBlock: BlockDefinition = {
  id: 'block.input.v1',
  name: 'input',
  description: 'Graph entry point: passes a value into the workflow.',
  category: 'io',
  inputSchema: { type: 'object', properties: { value: {} } },
  outputSchemas: { output: {}, error: ERROR_SCHEMA },
  fixture: { input: { value: 42 }, expectOutputPin: 'output' },
  async *run(input) {
    yield ['output', input['value']];
  },
};

const outputBlock: BlockDefinition = {
  id: 'block.output.v1',
  name: 'output',
  description: 'Graph exit point: collects a value as a run output.',
  category: 'io',
  inputSchema: {
    type: 'object',
    properties: { value: {} },
    required: ['value'],
  },
  outputSchemas: { done: {}, error: ERROR_SCHEMA },
  fixture: { input: { value: 'ok' }, expectOutputPin: 'done' },
  async *run(input) {
    yield ['done', input['value']];
  },
};

const llmTextBlock: BlockDefinition = {
  id: 'block.llm_text.v1',
  name: 'llm_text',
  description: 'One-shot LLM text generation from a prompt (plus optional system/context).',
  category: 'ai',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'User prompt.' },
      system: { type: 'string', description: 'System instruction.' },
      context: { type: 'string', description: 'Extra background appended to the prompt.' },
    },
    required: ['prompt'],
  },
  outputSchemas: { output: STRING_SCHEMA, error: ERROR_SCHEMA },
  async *run(input, ctx) {
    const llmCall = ctx.llmCall;
    if (!llmCall) {
      yield ['error', 'llm_text requires a BlockContext.llmCall.'];
      return;
    }
    const promptValue = String(input['prompt'] ?? '');
    const contextValue = typeof input['context'] === 'string' ? input['context'] : undefined;
    const fullPrompt = contextValue
      ? `${promptValue}\n\n# Context\n${contextValue}`
      : promptValue;
    try {
      const messages: BaseMessage[] = [];
      if (typeof input['system'] === 'string') {
        messages.push(new SystemMessage(input['system']));
      }
      messages.push(new HumanMessage(fullPrompt));
      const response = await llmCall(messages, { signal: ctx.signal });
      yield ['output', response.getText()];
    } catch (err) {
      yield ['error', err instanceof Error ? err.message : String(err)];
    }
  },
};

const llmStructuredBlock: BlockDefinition = {
  id: 'block.llm_structured.v1',
  name: 'llm_structured',
  description: 'LLM generation constrained to JSON, parsed into an object.',
  category: 'ai',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      system: { type: 'string' },
      context: { type: 'string' },
    },
    required: ['prompt'],
  },
  outputSchemas: { output: { type: 'object' }, error: ERROR_SCHEMA },
  async *run(input, ctx) {
    const llmCall = ctx.llmCall;
    if (!llmCall) {
      yield ['error', 'llm_structured requires a BlockContext.llmCall.'];
      return;
    }
    const promptValue = String(input['prompt'] ?? '');
    const contextValue = typeof input['context'] === 'string' ? input['context'] : undefined;
    const fullPrompt = [
      promptValue,
      contextValue ? `\n\n# Context\n${contextValue}` : '',
      '\n\nRespond with a single JSON value and nothing else.',
    ].join('');
    try {
      const messages: BaseMessage[] = [];
      if (typeof input['system'] === 'string') {
        messages.push(new SystemMessage(input['system']));
      }
      messages.push(new HumanMessage(fullPrompt));
      const response = await llmCall(messages, { signal: ctx.signal });
      const parsed = extractJson(response.getText());
      if (parsed === undefined) {
        yield ['error', 'LLM response did not contain parsable JSON.'];
        return;
      }
      yield ['output', parsed];
    } catch (err) {
      yield ['error', err instanceof Error ? err.message : String(err)];
    }
  },
};

const conditionBlock: BlockDefinition = {
  id: 'block.condition.v1',
  name: 'condition',
  description: 'Branches on a value: emits pin "true" or "false".',
  category: 'logic',
  inputSchema: {
    type: 'object',
    properties: {
      value: { description: 'Value to test.' },
      operator: {
        type: 'string',
        enum: ['truthy', 'falsy', 'equals', 'contains'],
        description: 'Comparison to apply.',
      },
      compareTo: { description: 'Right-hand side for equals/contains.' },
    },
    required: ['value', 'operator'],
  },
  outputSchemas: { true: {}, false: {}, error: ERROR_SCHEMA },
  fixture: { input: { value: 'hello world', operator: 'contains', compareTo: 'world' }, expectOutputPin: 'true' },
  async *run(input) {
    const value = input['value'];
    const operator = input['operator'];
    const compareTo = input['compareTo'];
    let branch: boolean;
    switch (operator) {
      case 'truthy':
        branch = Boolean(value);
        break;
      case 'falsy':
        branch = !value;
        break;
      case 'equals':
        branch = value === compareTo;
        break;
      case 'contains':
        branch = String(value).includes(String(compareTo));
        break;
      default:
        yield ['error', `Unknown operator: ${String(operator)}`];
        return;
    }
    yield [branch ? 'true' : 'false', value];
  },
};

const stepThroughItemsBlock: BlockDefinition = {
  id: 'block.step_through_items.v1',
  name: 'step_through_items',
  description: 'Emits each array item on pin "item" — the fan-out primitive.',
  category: 'logic',
  inputSchema: {
    type: 'object',
    properties: { items: { type: 'array' } },
    required: ['items'],
  },
  outputSchemas: { item: {}, error: ERROR_SCHEMA },
  fixture: { input: { items: [1, 2, 3] }, expectOutputPin: 'item' },
  async *run(input) {
    const items = input['items'];
    if (!Array.isArray(items)) {
      yield ['error', 'input.items must be an array.'];
      return;
    }
    for (const item of items) {
      yield ['item', item];
    }
  },
};

const delayBlock: BlockDefinition = {
  id: 'block.delay.v1',
  name: 'delay',
  description: 'Waits a number of milliseconds, then emits "done".',
  category: 'logic',
  inputSchema: {
    type: 'object',
    properties: { ms: { type: 'number', minimum: 0 } },
    required: ['ms'],
  },
  outputSchemas: { done: {}, error: ERROR_SCHEMA },
  async *run(input, ctx) {
    const ms = Number(input['ms'] ?? 0);
    if (!Number.isFinite(ms) || ms < 0) {
      yield ['error', 'input.ms must be a non-negative number.'];
      return;
    }
    if (ms > 0) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(new Error('delay cancelled'));
        };
        const timer = setTimeout(() => {
          ctx.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    yield ['done', true];
  },
};

const toolBlock: BlockDefinition = {
  id: 'block.tool.v1',
  name: 'tool',
  description: 'Runs a registered ReAct tool by name with the given arguments.',
  category: 'tool',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Tool name from BlockContext.tools.' },
      args: { type: 'object', description: 'Tool arguments.' },
    },
    required: ['name'],
  },
  outputSchemas: { output: STRING_SCHEMA, error: ERROR_SCHEMA },
  async *run(input, ctx) {
    const name = String(input['name'] ?? '');
    const tool = ctx.tools?.find((t) => t.name === name);
    if (!tool) {
      const available = (ctx.tools ?? []).map((t) => t.name).join(', ') || 'none';
      yield ['error', `Tool "${name}" not found. Available: ${available}`];
      return;
    }
    const rawArgs = input['args'];
    if (rawArgs !== undefined && (typeof rawArgs !== 'object' || rawArgs === null)) {
      yield ['error', `Tool "${name}" received non-object args (${typeof rawArgs}).`];
      return;
    }
    try {
      const result = await tool.execute((rawArgs as Record<string, unknown>) ?? {});
      yield ['output', result];
    } catch (err) {
      yield ['error', err instanceof Error ? err.message : String(err)];
    }
  },
};

const humanInTheLoopBlock: BlockDefinition = {
  id: 'block.human_in_the_loop.v1',
  name: 'human_in_the_loop',
  description: 'Pauses for a human answer before continuing.',
  category: 'human',
  inputSchema: {
    type: 'object',
    properties: { prompt: { type: 'string' } },
    required: ['prompt'],
  },
  outputSchemas: { output: STRING_SCHEMA, error: ERROR_SCHEMA },
  async *run(input, ctx) {
    if (!ctx.requestHumanInput) {
      yield ['error', 'human_in_the_loop requires BlockContext.requestHumanInput.'];
      return;
    }
    try {
      const answer = await ctx.requestHumanInput({
        nodeId: ctx.nodeId ?? '',
        prompt: String(input['prompt'] ?? ''),
      });
      yield ['output', answer];
    } catch (err) {
      yield ['error', err instanceof Error ? err.message : String(err)];
    }
  },
};

const subGraphBlock: BlockDefinition = {
  id: 'block.sub_graph.v1',
  name: 'sub_graph',
  description: 'Runs another graph by id as a single node (agent within a workflow).',
  category: 'graph',
  inputSchema: {
    type: 'object',
    properties: {
      graphId: { type: 'string' },
      inputs: { type: 'object', description: 'Values forwarded to the sub-graph input nodes.' },
    },
    required: ['graphId'],
  },
  outputSchemas: { output: { type: 'object' }, error: ERROR_SCHEMA },
  async *run(input, ctx) {
    if (!ctx.executeGraph) {
      yield ['error', 'sub_graph requires BlockContext.executeGraph.'];
      return;
    }
    try {
      const result = await ctx.executeGraph(
        String(input['graphId'] ?? ''),
        (input['inputs'] as Record<string, unknown>) ?? {},
      );
      yield ['output', result];
    } catch (err) {
      yield ['error', err instanceof Error ? err.message : String(err)];
    }
  },
};

const codeSandboxBlock: BlockDefinition = {
  id: 'block.code_sandbox.v1',
  name: 'code_sandbox',
  description: 'Runs generated code inside the configured sandbox.',
  category: 'code',
  inputSchema: {
    type: 'object',
    properties: { code: { type: 'string' } },
    required: ['code'],
  },
  outputSchemas: { output: STRING_SCHEMA, error: ERROR_SCHEMA },
  async *run(input, ctx) {
    if (!ctx.runInSandbox) {
      yield [
        'error',
        'No sandbox executor configured. Wire BlockContext.runInSandbox to ghita-sandbox (native-bridge) or a JS fallback.',
      ];
      return;
    }
    try {
      const result = await ctx.runInSandbox(String(input['code'] ?? ''));
      yield ['output', result];
    } catch (err) {
      yield ['error', err instanceof Error ? err.message : String(err)];
    }
  },
};

/** Register the built-in library on a fresh registry. */
export function createDefaultBlockRegistry(): BlockRegistry {
  return new BlockRegistry()
    .register(inputBlock)
    .register(outputBlock)
    .register(llmTextBlock)
    .register(llmStructuredBlock)
    .register(conditionBlock)
    .register(stepThroughItemsBlock)
    .register(delayBlock)
    .register(toolBlock)
    .register(humanInTheLoopBlock)
    .register(subGraphBlock)
    .register(codeSandboxBlock);
}

// Re-exported so hosts can rebuild contexts without reaching into internals.
export type { BlockContext, BlockDefinition };
