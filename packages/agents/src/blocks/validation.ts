// Block input/output validation pipeline (design ported from AutoGPT
// validate_exec / BlockOutput validation — design ideas only, no code
// copied). Input pins are coerced and checked BEFORE a node runs; every
// output emission is checked against its pin schema AS it streams, so a
// block emitting garbage fails the node instead of poisoning downstream
// nodes silently.

import type { BlockDefinition, JsonSchema } from './types.js';

/** Thrown when a node's merged input record violates its block's schema. */
export class BlockInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockInputError';
  }
}

/** Thrown when an emitted output value violates its pin's schema. */
export class BlockOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockOutputError';
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function assertEnum(schema: JsonSchema, value: unknown, path: string): void {
  const allowed = schema['enum'];
  if (!Array.isArray(allowed)) return;
  if (!allowed.some((candidate) => candidate === value)) {
    throw new BlockInputError(
      `${path} must be one of [${allowed.map((c) => JSON.stringify(c)).join(', ')}], got ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Recursively validate/coerce one value against a JSON-Schema subset: type
 * coercion (string→number/boolean when unambiguous), enum membership,
 * object properties + required, array items. Returns the coerced value or
 * throws `BlockInputError` with an actionable path-qualified message.
 */
export function coerceValueAgainstSchema(
  schema: JsonSchema | undefined,
  value: unknown,
  path: string,
): unknown {
  if (!schema || typeof schema !== 'object') return value;
  const expectedType = schema['type'];
  if (typeof expectedType !== 'string') {
    assertEnum(schema, value, path);
    return value;
  }

  if (typeof value === 'string') {
    if (expectedType === 'number' || expectedType === 'integer') {
      if (value.trim().length === 0) {
        throw new BlockInputError(`${path  } expected ${  expectedType  }, got empty string`);
      }
      const parsed = Number(value);
      if (Number.isNaN(parsed)) {
        throw new BlockInputError(`${path} expected ${expectedType}, got unparseable string "${value}"`);
      }
      const coerced = expectedType === 'integer' ? Math.round(parsed) : parsed;
      assertEnum(schema, coerced, path);
      return coerced;
    }
    if (expectedType === 'boolean') {
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new BlockInputError(`${path} expected boolean, got unparseable string "${value}"`);
    }
  }

  if (expectedType === 'number' || expectedType === 'integer') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new BlockInputError(`${path} expected ${expectedType}, got ${describe(value)}`);
    }
    const finalValue = expectedType === 'integer' ? Math.round(value) : value;
    assertEnum(schema, finalValue, path);
    return finalValue;
  }

  if (expectedType === 'string') {
    if (typeof value !== 'string') {
      throw new BlockInputError(`${path} expected string, got ${describe(value)}`);
    }
    assertEnum(schema, value, path);
    return value;
  }

  if (expectedType === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new BlockInputError(`${path} expected boolean, got ${describe(value)}`);
    }
    return value;
  }

  if (expectedType === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BlockInputError(`${path} expected object, got ${describe(value)}`);
    }
    const properties = (schema['properties'] ?? {}) as Record<string, JsonSchema>;
    const required = (schema['required'] ?? []) as string[];
    const source = value as Record<string, unknown>;
    for (const key of required) {
      if (source[key] === undefined) {
        throw new BlockInputError(`${path}.${key} is required but missing`);
      }
    }
    const result: Record<string, unknown> = { ...source };
    for (const [key, propSchema] of Object.entries(properties)) {
      if (result[key] === undefined) {
        const def = propSchema['default'];
        if (def !== undefined) result[key] = coerceValueAgainstSchema(propSchema, def, `${path}.${key}`);
        continue;
      }
      result[key] = coerceValueAgainstSchema(propSchema, result[key], `${path}.${key}`);
    }
    return result;
  }

  if (expectedType === 'array') {
    if (!Array.isArray(value)) {
      throw new BlockInputError(`${path} expected array, got ${describe(value)}`);
    }
    const itemSchema = schema['items'] as JsonSchema | undefined;
    if (!itemSchema) return value;
    return value.map((item, index) => coerceValueAgainstSchema(itemSchema, item, `${path}[${index}]`));
  }

  return value;
}

/**
 * Validate + coerce a node's merged input record against its block schema
 * BEFORE the block runs. Defaults from the schema fill missing optional
 * pins; required pins missing entirely still fail with an actionable error
 * (the scheduler guarantees them, so this is a safety net, not the norm).
 */
export function validateBlockInput(
  block: BlockDefinition,
  input: Record<string, unknown>,
  nodeId: string,
): Record<string, unknown> {
  const schema = block.inputSchema;
  const properties = (schema['properties'] ?? {}) as Record<string, JsonSchema>;
  const required = (schema['required'] ?? []) as string[];
  const result: Record<string, unknown> = { ...input };

  for (const pin of required) {
    if (result[pin] === undefined) {
      const def = properties[pin]?.['default'];
      if (def !== undefined) {
        result[pin] = coerceValueAgainstSchema(properties[pin], def, `node "${nodeId}" input pin "${pin}"`);
        continue;
      }
      throw new BlockInputError(
        `Node "${nodeId}" (block ${block.name}) input pin "${pin}" is required but missing`,
      );
    }
  }

  for (const [pin, pinSchema] of Object.entries(properties)) {
    if (result[pin] === undefined) {
      const def = pinSchema['default'];
      if (def !== undefined) {
        result[pin] = coerceValueAgainstSchema(pinSchema, def, `node "${nodeId}" input pin "${pin}"`);
      }
      continue;
    }
    result[pin] = coerceValueAgainstSchema(pinSchema, result[pin], `node "${nodeId}" input pin "${pin}"`);
  }
  return result;
}

/**
 * Validate one emitted output value against its pin schema (AutoGPT
 * BlockOutput validation — a mismatch fails the NODE with a BlockOutputError
 * instead of poisoning downstream nodes). Empty schemas (`{}`) pass.
 */
export function validateEmission(
  block: BlockDefinition,
  pin: string,
  value: unknown,
): void {
  if (pin === 'error') return; // string invariant, always rethrown by the executor
  const schema = block.outputSchemas[pin];
  if (!schema || typeof schema !== 'object' || Object.keys(schema).length === 0) return;
  try {
    coerceValueAgainstSchema(schema, value, `output pin "${pin}"`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new BlockOutputError(
      `Block "${block.name}" emitted a value violating schema: ${reason}`,
    );
  }
}

/**
 * (6.2) Pin đánh dấu secret:true (UI hint) có giá trị bị thay bằng
 * <secret> trước khi vào event — secret không bao giờ lộ ra log/UI.
 */
export function redactSecretPins(
  block: BlockDefinition,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const properties = (block.inputSchema['properties'] ?? {}) as Record<string, JsonSchema>;
  const out: Record<string, unknown> = { ...input };
  for (const [pin, schema] of Object.entries(properties)) {
    if (schema['secret'] === true && out[pin] !== undefined) {
      out[pin] = '<secret>';
    }
  }
  return out;
}
