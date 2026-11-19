// v0.0.2-preview T4 — hybrid search native helpers. getVecStore() ủy thẳng
// cho native-bridge; embeddings helper nằm ở packages/memory/src/embeddings.ts.

export {
  getNativeVecStore,
  getVecDim,
  type VecHit,
  type VecStoreApi,
} from '@ghita/native-bridge';

import { getNativeVecStore, type VecStoreApi } from '@ghita/native-bridge';

/** Lazily-opened durable vec0 index — null khi addon vắng (JS fallback giữ nguyên). */
export function getVecStore(path?: string): VecStoreApi | null {
  return getNativeVecStore(path);
}
