/* Hand-written typings (napi CLI 3.10.9 generates empty .d.ts on this machine —
   known env issue; runtime .node addons work fine, TS bridge uses these types). */

export interface PatchSummary {
  applied: Array<string>;
  skipped: Array<string>;
  partial: boolean;
}

export declare function applyPatch(patchText: string, cwd: string): PatchSummary;
export declare function patchAvailable(): boolean;
