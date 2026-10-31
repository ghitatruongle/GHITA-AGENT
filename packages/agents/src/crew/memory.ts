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
