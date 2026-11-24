// Track S3 P2 — StreamObject protocol: type classification, client-side
// merge, mobile wire roundtrip, the 4 provider generators' `type` parity,
// and the Orchestrator → EventStream bus wiring.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AIStreamChunk } from '@ghita/shared';
import {
  STREAM_OBJECT_TYPES,
  isStreamChunkType,
  streamObjectType,
  textDelta,
  reasoningDelta,
  toolCallChunk,
  toolResultChunk,
  toolIncompleteResultChunk,
  mergeStreamObjects,
  streamObjectToWire,
  streamObjectFromWire,
} from '../src/stream-protocol.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { GoogleProvider } from '../src/providers/google.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { Orchestrator } from '../src/orchestrator.js';

function streamingResponse(frames: string[], contentType = 'text/event-stream'): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': contentType } },
  );
}

async function collect(gen: AsyncGenerator<AIStreamChunk>): Promise<AIStreamChunk[]> {
  const chunks: AIStreamChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stream-protocol — classification', () => {
  it('the vocabulary has exactly the 5 canonical kinds', () => {
    expect(STREAM_OBJECT_TYPES).toEqual([
      'text-delta',
      'reasoning',
      'tool-call',
      'tool-result',
      'tool-incomplete-result',
    ]);
  });

  it('infers type for legacy chunks without the field', () => {
    expect(streamObjectType({ content: 'hi', done: false })).toBe('text-delta');
    expect(
      streamObjectType({
        content: '',
        done: true,
        toolCalls: [{ name: 'read_file', arguments: {} }],
      }),
    ).toBe('tool-call');
    expect(streamObjectType({ content: 'x', done: false, type: 'reasoning' })).toBe('reasoning');
  });

  it('rejects unknown type values as text deltas', () => {
    expect(isStreamChunkType('banana')).toBe(false);
    expect(streamObjectType({ content: 'x', done: false, type: 'banana' as never })).toBe(
      'text-delta',
    );
  });

  it('builders produce correctly typed chunks', () => {
    expect(textDelta('hi').type).toBe('text-delta');
    expect(reasoningDelta('thinking...').type).toBe('reasoning');
    const call = toolCallChunk([{ id: 'c1', name: 'choose', arguments: {} }]);
    expect(call.type).toBe('tool-call');
    expect(call.done).toBe(true);
    const result = toolResultChunk('payload', 'c1');
    expect(result.type).toBe('tool-result');
    expect(result.toolCallId).toBe('c1');
    const incomplete = toolIncompleteResultChunk('partial', 'aborted', 'c1');
    expect(incomplete.type).toBe('tool-incomplete-result');
    expect(incomplete.reason).toBe('aborted');
  });
});

describe('stream-protocol — client-side merge', () => {
  it('folds text, reasoning, tool calls, results, and incomplete results', () => {
    const merged = mergeStreamObjects([
      reasoningDelta('let me think'),
      reasoningDelta(' more'),
      textDelta('Hel'),
      textDelta('lo'),
      toolCallChunk([{ id: 'c1', name: 'web_search', arguments: { query: 'x' } }]),
      toolResultChunk('search results', 'c1'),
      toolIncompleteResultChunk('par', 'aborted', 'c2'),
      textDelta(' after'),
      {
        content: '',
        done: true,
        model: 'm1',
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      },
    ]);

    expect(merged.text).toBe('Hello after');
    expect(merged.reasoning).toBe('let me think more');
    expect(merged.toolCalls).toEqual([{ id: 'c1', name: 'web_search', arguments: { query: 'x' } }]);
    expect(merged.toolResults).toEqual([
      { toolCallId: 'c1', content: 'search results', incomplete: false },
      { toolCallId: 'c2', content: 'par', incomplete: true, reason: 'aborted' },
    ]);
    expect(merged.hasIncompleteResults).toBe(true);
    expect(merged.done).toBe(true);
    expect(merged.model).toBe('m1');
    expect(merged.usage?.totalTokens).toBe(3);
  });

  it('collapses duplicate tool calls by id (or name+args when id-less)', () => {
    const merged = mergeStreamObjects([
      toolCallChunk([{ id: 'c1', name: 'read_file', arguments: { filePath: 'a' } }]),
      toolCallChunk([{ id: 'c1', name: 'read_file', arguments: { filePath: 'a' } }]),
      toolCallChunk([{ name: 'list_dir', arguments: {} }]),
      toolCallChunk([{ name: 'list_dir', arguments: {} }]),
      toolCallChunk([{ name: 'list_dir', arguments: { path: 'src' } }]),
    ]);
    expect(merged.toolCalls).toHaveLength(3);
  });
});

describe('stream-protocol — mobile wire roundtrip', () => {
  it('converts chunk → wire (content becomes text) and back', () => {
    const wire = streamObjectToWire(
      toolIncompleteResultChunk('partial', 'aborted', 'c1', { provider: 'openai', model: 'm' }),
    );
    expect(wire).toEqual({
      type: 'tool-incomplete-result',
      text: 'partial',
      done: true,
      provider: 'openai',
      model: 'm',
      toolCallId: 'c1',
      reason: 'aborted',
    });
    const back = streamObjectFromWire(wire);
    expect(back.type).toBe('tool-incomplete-result');
    expect(back.content).toBe('partial');
    expect(back.toolCallId).toBe('c1');
    expect(back.reason).toBe('aborted');
  });

  it('merge works directly on wire objects roundtripped from chunks', () => {
    const wireStream = [
      reasoningDelta('think'),
      textDelta('ans'),
      toolCallChunk([{ id: 'c1', name: 'choose', arguments: { question: 'q' } }]),
      toolResultChunk('user picked option 1', 'c1'),
    ].map(streamObjectToWire);
    const merged = mergeStreamObjects(wireStream.map(streamObjectFromWire));
    expect(merged.reasoning).toBe('think');
    expect(merged.text).toBe('ans');
    expect(merged.toolCalls[0]?.name).toBe('choose');
    expect(merged.toolResults[0]?.content).toBe('user picked option 1');
  });
});

describe('provider generators — StreamObject type parity', () => {
  it('openai emits text-delta and reasoning_content as reasoning', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamingResponse([
          'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n',
          'data: {"choices":[{"delta":{"content":"answer"}}]}\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
          'data: [DONE]\n\n',
        ]),
      ),
    );
    const provider = new OpenAIProvider({ type: 'openai', apiKey: 'test', defaultModel: 'test' });
    const chunks = await collect(provider.chatStream([{ role: 'user', content: 'hi' }]));

    expect(chunks.map((c) => c.type)).toEqual([
      'reasoning',
      'text-delta',
      'text-delta', // terminal, no tool calls
    ]);
    expect(chunks[0]?.content).toBe('thinking');
    expect(chunks[1]?.content).toBe('answer');
    // S2 behavior intact: terminal chunk done + no toolCalls.
    expect(chunks.at(-1)?.done).toBe(true);
    expect(chunks.at(-1)?.toolCalls).toEqual([]);
  });

  it('openai marks the terminal chunk as tool-call when tool calls complete', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamingResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{}"}}]}}]}\n',
          'data: [DONE]\n\n',
        ]),
      ),
    );
    const provider = new OpenAIProvider({ type: 'openai', apiKey: 'test', defaultModel: 'test' });
    const chunks = await collect(
      provider.chatStream([{ role: 'user', content: 'hi' }], { tools: [], toolChoice: 'auto' }),
    );
    expect(chunks.at(-1)?.type).toBe('tool-call');
    expect(chunks.at(-1)?.toolCalls?.[0]?.name).toBe('read_file');
  });

  it('anthropic emits thinking_delta as reasoning and text as text-delta', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamingResponse([
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"pondering"}}\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"answer"}}\n',
          'data: {"type":"message_stop"}\n\n',
        ]),
      ),
    );
    const provider = new AnthropicProvider({
      type: 'anthropic',
      apiKey: 'test',
      defaultModel: 'test',
    });
    const chunks = await collect(provider.chatStream([{ role: 'user', content: 'hi' }]));

    expect(chunks.map((c) => c.type)).toEqual(['reasoning', 'text-delta', 'text-delta']);
    expect(chunks[0]?.content).toBe('pondering');
    expect(chunks[1]?.content).toBe('answer');
  });

  it('anthropic marks the terminal chunk as tool-call for tool_use streams', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamingResponse([
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu-1","name":"choose"}}\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"question\\":\\"q\\"}"}}\n',
          'data: {"type":"message_stop"}\n\n',
        ]),
      ),
    );
    const provider = new AnthropicProvider({
      type: 'anthropic',
      apiKey: 'test',
      defaultModel: 'test',
    });
    const chunks = await collect(
      provider.chatStream([{ role: 'user', content: 'hi' }], { tools: [], toolChoice: 'auto' }),
    );
    expect(chunks.at(-1)?.type).toBe('tool-call');
    expect(chunks.at(-1)?.toolCalls?.[0]?.name).toBe('choose');
  });

  it('google separates thought parts into reasoning chunks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamingResponse([
          'data: {"candidates":[{"content":{"parts":[{"text":"hidden thought","thought":true}]}}]}\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"visible"}]}}]}\n',
          'data: {"candidates":[{"content":{"parts":[{"text":" answer"}]}}]}\n',
        ]),
      ),
    );
    const provider = new GoogleProvider({ type: 'google', apiKey: 'test', defaultModel: 'test' });
    const chunks = await collect(provider.chatStream([{ role: 'user', content: 'hi' }]));

    expect(chunks.map((c) => c.type)).toEqual([
      'reasoning',
      'text-delta',
      'text-delta',
      'text-delta',
    ]);
    expect(chunks[0]?.content).toBe('hidden thought');
    expect(chunks[1]?.content).toBe('visible');
  });

  it('ollama streams thinking as reasoning and content as text-delta', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamingResponse(
          [
            JSON.stringify({ message: {}, thinking: 'local thought', done: false }),
            JSON.stringify({ message: { content: 'local answer' }, done: false }),
            JSON.stringify({ message: {}, done: true }),
          ].map((line) => `${line}\n`),
          'application/x-ndjson',
        ),
      ),
    );
    const provider = new OllamaProvider({ type: 'ollama', defaultModel: 'llama3' });
    const chunks = await collect(provider.chatStream([{ role: 'user', content: 'hi' }]));

    expect(chunks.map((c) => c.type)).toEqual(['reasoning', 'text-delta', 'text-delta']);
    expect(chunks[0]?.content).toBe('local thought');
    expect(chunks[1]?.content).toBe('local answer');
    expect(chunks.at(-1)?.done).toBe(true);
  });
});

describe('orchestrator — EventStream bus wiring', () => {
  it('streams chunks onto the bus as typed message.delta events', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamingResponse([
          'data: {"choices":[{"delta":{"reasoning_content":"bus reasoning"}}]}\n',
          'data: {"choices":[{"delta":{"content":"bus answer"}}]}\n',
          'data: [DONE]\n\n',
        ]),
      ),
    );

    const orchestrator = new Orchestrator({
      providers: [{ type: 'openai', apiKey: 'test' }],
      defaultProvider: 'openai',
    });
    const events: string[] = [];
    orchestrator.getEventStream().subscribe((event) => {
      events.push(event.type);
    });

    const chunks = await collect(
      orchestrator.chatStream([{ role: 'user', content: 'hi' }], { provider: 'openai' }),
    );
    expect(chunks.length).toBeGreaterThan(0);

    // One message.start, one message.delta per chunk (fan-out is synchronous),
    // and one message.complete for the terminal chunk.
    expect(events.filter((t) => t === 'message.start')).toHaveLength(1);
    expect(events.filter((t) => t === 'message.delta')).toHaveLength(chunks.length);
    expect(events.filter((t) => t === 'message.complete')).toHaveLength(1);

    // The ring buffer replay shows the typed deltas too.
    const buffered = orchestrator.getEventStream().snapshot();
    const types = buffered.filter((e) => e.type === 'message.delta').map((e) => e.data['type']);
    expect(types).toContain('reasoning');
    expect(types).toContain('text-delta');
  });
});
