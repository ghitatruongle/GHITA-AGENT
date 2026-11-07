// GraphLibraryStore — persistence for graph definitions and run history
// (design ported from AutoGPT platform graph versioning — design ideas only,
// no code copied). JSON on disk: `graphs.json` keeps EVERY version per graph
// id (versions immutable, a save bumps to max+1); `runs.jsonl` keeps one
// record per execution keyed by executionId (upsert on re-record).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GraphDefinition } from './graph.js';

export interface GraphLibraryRecord {
  /** Every persisted version, ordered by `version` ascending. */
  versions: GraphDefinition[];
  updatedAt: number;
}

export interface GraphRunRecord {
  executionId: string;
  graphId: string;
  graphVersion: number;
  trigger: string;
  status: 'completed' | 'failed' | 'terminated' | 'incomplete';
  outputs: Record<string, unknown>;
  nodes: GraphExecutionResultLite[];
  error?: string;
  startedAt: number;
  finishedAt: number;
}

export interface GraphExecutionResultLite {
  nodeId: string;
  status: string;
  runs: number;
  error?: string;
  duration: number;
}

const GRAPHS_FILE = 'graphs.json';
const RUNS_FILE = 'runs.jsonl';

/**
 * File-backed graph library. Safe against concurrent writes within one
 * process (all mutations serialize on an internal promise chain); restarts
 * re-read the JSON files, so graphs and runs survive the app.
 */
export class GraphLibraryStore {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly dir: string) {}

  static async open(dir: string): Promise<GraphLibraryStore> {
    await fs.mkdir(dir, { recursive: true });
    return new GraphLibraryStore(dir);
  }

  /** Serialize mutations to keep the JSON files consistent. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // P1 fix: chain phải reassign — nếu không mọi mutation chạy song song.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private graphsPath(): string {
    return path.join(this.dir, GRAPHS_FILE);
  }

  private runsPath(): string {
    return path.join(this.dir, RUNS_FILE);
  }

  private async readGraphs(): Promise<Map<string, GraphLibraryRecord>> {
    // P2 fix: file hỏng bị QUARANTINE (.corrupt-<ts>) thay vì nuốt thành rỗng
    // — nếu không, lần save kế tiếp ghi đè và MẤT SẠCH thư viện graph.
    let raw = '';
    try {
      raw = await fs.readFile(this.graphsPath(), 'utf8');
    } catch {
      return new Map();
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, GraphLibraryRecord>;
      return new Map(Object.entries(parsed));
    } catch {
      await fs.rename(this.graphsPath(), `${this.graphsPath()  }.corrupt-${  String(Date.now())}`).catch(() => undefined);
      return new Map();
    }
  }

  private async writeGraphs(map: Map<string, GraphLibraryRecord>): Promise<void> {
    // CI D3 (2 store instance cùng thư mục): tmp tên CỐ ĐỊNH trùng nhau giữa
    // các process → instance A rename mất tmp của B → ENOENT. Tên tmp duy nhất
    // mỗi lần ghi chấm dứt đua; bản ghi dở của instance chết bị bỏ lại là rác
    // vô hại (không ai đọc đuôi .tmp-*).
    const tmp = `${this.graphsPath()}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = JSON.stringify(Object.fromEntries(map), null, 2);
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, this.graphsPath());
  }

  /**
   * Persist a graph. Versioning rules: when the latest stored version has
   * the same `version` number as the incoming draft, the save produces a NEW
   * version (max + 1) — identical drafts are NOT deduped (explicit saves are
   * explicit). A graph whose version is already ahead (imported) is stored
   * as-is.
   */
  async saveGraph(graph: GraphDefinition): Promise<GraphDefinition> {
    return this.enqueue(async () => {
      const graphs = await this.readGraphs();
      const record = graphs.get(graph.id) ?? { versions: [], updatedAt: 0 };
      const latest = record.versions.at(-1);
      let stored = graph;
      if (latest && graph.version <= latest.version) {
        stored = { ...graph, version: latest.version + 1 };
      }
      record.versions.push(stored);
      record.updatedAt = Date.now();
      graphs.set(stored.id, record);
      await this.writeGraphs(graphs);
      return stored;
    });
  }

  /** Latest version of every graph, ordered by updatedAt desc. */
  async listGraphs(): Promise<GraphDefinition[]> {
    const graphs = await this.readGraphs();
    return [...graphs.values()]
      .map((r) => r.versions.at(-1))
      .filter((g): g is GraphDefinition => g !== undefined)
      .sort((a, b) => {
        const ra = graphs.get(a.id)?.updatedAt ?? 0;
        const rb = graphs.get(b.id)?.updatedAt ?? 0;
        return rb - ra;
      });
  }

  /** One graph version: latest when `version` is omitted. */
  async getGraph(id: string, version?: number): Promise<GraphDefinition | undefined> {
    const graphs = await this.readGraphs();
    const record = graphs.get(id);
    if (!record) return undefined;
    if (version === undefined) return record.versions.at(-1);
    return record.versions.find((g) => g.version === version);
  }

  async deleteGraph(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const graphs = await this.readGraphs();
      const existed = graphs.delete(id);
      if (existed) await this.writeGraphs(graphs);
      return existed;
    });
  }

  /** Upsert one execution record (keyed by executionId). */
  async recordRun(record: GraphRunRecord): Promise<void> {
    await this.enqueue(async () => {
      const runs = await this.readRuns();
      const index = runs.findIndex((r) => r.executionId === record.executionId);
      if (index === -1) runs.push(record);
      else runs[index] = record;
      // Tên tmp duy nhất mỗi lần ghi — cùng lý do writeGraphs (CI D3).
      const tmp = `${this.runsPath()}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await fs.writeFile(tmp, `${runs.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
      await fs.rename(tmp, this.runsPath());
    });
  }

  /** Run history, newest first; optionally scoped to one graph. */
  async listRuns(graphId?: string): Promise<GraphRunRecord[]> {
    const runs = await this.readRuns();
    const scoped = graphId ? runs.filter((r) => r.graphId === graphId) : runs;
    return scoped.sort((a, b) => b.finishedAt - a.finishedAt);
  }

  private async readRuns(): Promise<GraphRunRecord[]> {
    try {
      const raw = await fs.readFile(this.runsPath(), 'utf8');
      return raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as GraphRunRecord);
    } catch {
      return [];
    }
  }
}
