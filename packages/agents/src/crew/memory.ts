// Crew shared-memory bridge. Adapts @ghita/memory's AgentMemory to the small
// CrewMemoryBridge seam so Crew can recall context before each task and
// remember outputs after it, without depending on the memory package's API.

import type { AgentMemory } from '@ghita/memory';
import type { CrewMemoryBridge } from './types.js';

export function createAgentMemoryBridge(memory: AgentMemory): CrewMemoryBridge {
  return {
    recall(query: string, limit = 3): string | null {
      try {
        return memory.injectContext(query, { limit }) ?? null;
      } catch {
        return null;
      }
    },
    remember(content: string, metadata?: Record<string, unknown>): void {
      try {
        memory.remember({ type: 'context', content, metadata });
      } catch {
        // Memory is best-effort: a failing store must never break a crew run.
      }
    },
  };
}

// ---- Track 5.2 — memory thành tool cho agent (CrewAI unified memory) ----

import type { ReActTool } from '../react/types.js';

/**
 * Hai tool `crew_memorize` / `crew_recall` bọc CrewMemoryBridge: agent TỰ
 * tra cứu/ghi nhớ được giữa task (CrewAI _add_memory_tools) thay vì chỉ
 * recall-trước/remember-sau do crew khống chế.
 */
export function createMemoryTools(memory: CrewMemoryBridge): ReActTool[] {
  return [
    {
      name: 'crew_memorize',
      description:
        'Lưu một thông tin quan trọng vào bộ nhớ chia sẻ của crew (quyết định, ràng buộc, phát hiện). Gọi với {"content": "..."}',
      parameters: {
        type: 'object',
        properties: { content: { type: 'string', description: 'Nội dung cần ghi nhớ' } },
        required: ['content'],
      },
      execute: async (input) => {
        const content = typeof input['content'] === 'string' ? input['content'] : '';
        if (content.trim().length === 0) return 'Nothing to remember: content was empty.';
        memory.remember(content);
        return 'Remembered.';
      },
    },
    {
      name: 'crew_recall',
      description:
        'Tra bộ nhớ chia sẻ của crew theo từ khóa. Gọi với {"query": "..."}; trả về các mảnh nhớ gần khớp hoặc "(none)".',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Từ khóa cần tra' } },
        required: ['query'],
      },
      execute: async (input) => {
        const query = typeof input['query'] === 'string' ? input['query'] : '';
        return memory.recall(query) ?? '(none)';
      },
    },
  ];
}
