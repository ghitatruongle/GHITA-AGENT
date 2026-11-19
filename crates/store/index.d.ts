/* Hand-written typings (napi CLI 3.10.9 generates empty .d.ts on this machine —
   known env issue; runtime .node addons work fine, TS bridge uses these types). */

export interface VecHit {
  id: string;
  text: string;
  metadata: string;
  score: number;
}

export declare class GhitaStore {
  constructor();
  static new(path: string): GhitaStore;
  get(key: string): string | null;
  set(key: string, value: string): void;
  setMany(keys: Array<string>, values: Array<string>): void;
  delete(key: string): boolean;
  keys(): Array<string>;
  count(): number;
  vecEnsureSchema(dim: number): void;
  vecStore(id: string, text: string, vec: Float32Array, metadata: string): void;
  vecSearch(query: Float32Array, k: number): Array<VecHit>;
  vecDelete(id: string): boolean;
  vecCount(): number;
}
