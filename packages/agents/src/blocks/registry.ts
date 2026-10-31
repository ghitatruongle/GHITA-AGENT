// BlockRegistry — dynamic block discovery with load-time invariants, ported
// from AutoGPT's `load_all_blocks`: unique stable UUIDs, unique names, a
// mandatory string `error` output pin, and self-test fixtures.

import type { BlockContext, BlockDefinition } from './types.js';

export class BlockRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockRegistryError';
  }
}

function assertValidDefinition(def: BlockDefinition): void {
  if (!def.id || typeof def.id !== 'string') {
    throw new BlockRegistryError(`Block "${def.name ?? '?'}" must declare a stable string id.`);
  }
  if (!def.name || typeof def.name !== 'string') {
    throw new BlockRegistryError(`Block "${def.id}" must declare a registry name.`);
  }
  if (typeof def.run !== 'function') {
    throw new BlockRegistryError(`Block "${def.name}" must provide a run generator.`);
  }
  if (!def.outputSchemas || typeof def.outputSchemas !== 'object') {
    throw new BlockRegistryError(`Block "${def.name}" must declare outputSchemas.`);
  }
  // AutoGPT invariant: every block can fail, so it must expose `error: str`.
  const errorSchema = def.outputSchemas['error'];
  if (!errorSchema) {
    throw new BlockRegistryError(`Block "${def.name}" must declare an "error" output pin.`);
  }
  if (errorSchema['type'] !== 'string') {
    throw new BlockRegistryError(`Block "${def.name}" output pin "error" must be a string.`);
  }
  if (def.fixture && !Object.prototype.hasOwnProperty.call(def.outputSchemas, def.fixture.expectOutputPin)) {
    throw new BlockRegistryError(
      `Block "${def.name}" fixture expects unknown output pin "${def.fixture.expectOutputPin}".`,
    );
  }
}

export class BlockRegistry {
  private readonly byName = new Map<string, BlockDefinition>();
  private readonly byId = new Map<string, BlockDefinition>();

  register(def: BlockDefinition): this {
    assertValidDefinition(def);
    if (this.byName.has(def.name)) {
      throw new BlockRegistryError(`Block name already registered: ${def.name}`);
    }
    if (this.byId.has(def.id)) {
      throw new BlockRegistryError(`Block id already registered: ${def.id}`);
    }
    this.byName.set(def.name, def);
    this.byId.set(def.id, def);
    return this;
  }

  get(name: string): BlockDefinition | undefined {
    return this.byName.get(name);
  }

  getById(id: string): BlockDefinition | undefined {
    return this.byId.get(id);
  }

  /** Resolve or throw — graph validation reports unknown blocks via this. */
  require(name: string): BlockDefinition {
    const def = this.byName.get(name);
    if (!def) {
      throw new BlockRegistryError(`Unknown block: "${name}"`);
    }
    return def;
  }

  list(): BlockDefinition[] {
    return [...this.byName.values()];
  }

  /**
   * Run every self-describing fixture (AutoGPT self-testing blocks). Returns
   * one result per fixture; blocks without a fixture are skipped. A failing
   * fixture does not throw — callers decide how to report it.
   */
  async runFixtureTests(ctx: BlockContext): Promise<
    Array<{ block: string; ok: boolean; error?: string }>
  > {
    const results: Array<{ block: string; ok: boolean; error?: string }> = [];
    for (const def of this.list()) {
      if (!def.fixture) continue;
      try {
        let sawExpected = false;
        for await (const [pin] of def.run({ ...def.fixture.input }, ctx)) {
          if (pin === def.fixture.expectOutputPin) sawExpected = true;
        }
        results.push({ block: def.name, ok: sawExpected, ...(sawExpected ? {} : { error: 'fixture pin not emitted' }) });
      } catch (err) {
        results.push({
          block: def.name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }
}
