// Native-first vector index (v0.0.2-preview T4): getNativeVecStore lazily
// opens the ghita-store addon's vec0 index (sqlite-vec). Returns null when
// the addon is missing → callers keep the JS cosine path (fallback = luồng cũ).

import { loadNative } from './index.js';

export interface VecHit {
  id: string;
  text: string;
  metadata: string;
  score: number;
}

export interface VecStoreApi {
  vecEnsureSchema(dim: number): void;
  vecStore(id: string, text: string, vec: Float32Array, metadata: string): void;
  vecSearch(query: Float32Array, k: number): VecHit[];
  vecDelete(id: string): boolean;
  vecCount(): number;
}

interface StoreNativeModule {
  GhitaStore: new (path: string) => {
    vecEnsureSchema(dim: number): void;
    vecStore(id: string, text: string, vec: Float32Array, metadata: string): void;
    vecSearch(query: Float32Array, k: number): VecHit[];
    vecDelete(id: string): boolean;
    vecCount(): number;
  };
}

const INSTANCE_CACHE = new Map<string, VecStoreApi | null>();

/** Số chiều embedding của vec0 index — env GHITA_MEMORY_VEC_DIM (default 1536,
 *  khớp text-embedding-3-small). Vector lệch dim không được index (F6 review). */
export function getVecDim(): number {
  const n = Number(process.env.GHITA_MEMORY_VEC_DIM ?? '1536');
  return Number.isFinite(n) && n > 0 ? n : 1536;
}

export function getNativeVecStore(path?: string): VecStoreApi | null {
  const dbPath = path ?? process.env.GHITA_MEMORY_VEC_DB ?? ':memory:';
  if (INSTANCE_CACHE.has(dbPath)) return INSTANCE_CACHE.get(dbPath) ?? null;
  let api: VecStoreApi | null = null;
  try {
    const loaded = loadNative<StoreNativeModule>('store', { GhitaStore: class {} } as never);
    if (loaded.native) {
      const store = new loaded.impl.GhitaStore(dbPath);
      store.vecEnsureSchema(getVecDim());
      api = store as unknown as VecStoreApi;
    }
  } catch {
    api = null;
  }
  INSTANCE_CACHE.set(dbPath, api);
  return api;
}
