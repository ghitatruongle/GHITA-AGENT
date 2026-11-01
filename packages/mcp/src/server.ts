import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';
import type { ServerConfig, ServerHooks, ToolDefinition } from './types.js';

const SHAPE_FUNCTIONS: Record<string, () => z.ZodTypeAny> = {
  string: () => z.string(),
  number: () => z.number(),
  integer: () => z.number().int(),
  boolean: () => z.boolean(),
  array: () => z.array(z.any()),
  object: () => z.record(z.string(), z.any()),
};

function schemaToZod(input: ToolDefinition['inputSchema']): ZodRawShape {
  // zod v4 types ZodRawShape as readonly; build a fresh mutable record and
  // hand the SDK the finished shape.
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = input.required ?? [];
  for (const [key, raw] of Object.entries(input.properties ?? {})) {
    const type = (raw as { type?: string })?.type;
    const factory = type ? SHAPE_FUNCTIONS[type] : undefined;
    const base = factory ? factory() : z.any();
    shape[key] = required.includes(key) ? base : base.optional();
  }
  return shape;
}

/** Minimal tool registry with deny-default guard hooks. */
export class GhitaMCPServer {
  readonly server: McpServer;
  private readonly hooks: ServerHooks = {};

  constructor(config: ServerConfig) {
    this.server = new McpServer({
      name: config.name,
      version: config.version,
    });
    this.hooks = config.hooks ?? {};
    for (const tool of config.tools ?? []) {
      this.registerTool(tool);
    }
  }

  /** Register one tool with zod-converted input schema + guard hooks. */
  registerTool(def: ToolDefinition): void {
    const zodShape = schemaToZod(def.inputSchema);
    const zod = z.object(zodShape);
    this.server.tool(
      def.name,
      def.description,
      zod.shape,
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const started = Date.now();
        try {
          const deny = this.hooks.preToolCall
            ? await this.hooks.preToolCall(def.name, args)
            : undefined;
          if (deny) {
            return {
              content: [{ type: 'text', text: `denied by policy: ${deny}` }],
              isError: true,
            };
          }
          const result = await def.handler(args);
          const callable: CallToolResult = {
            content: result.content,
            isError: result.isError ?? false,
          };
          this.hooks.postToolCall?.(def.name, result, Date.now() - started);
          return callable;
        } catch (err) {
          this.hooks.onError?.(def.name, err);
          return {
            content: [
              {
                type: 'text',
                text: `tool error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      },
    );
  }

  /** Connect to a client transport (stdio server transport or in-memory pair). */
  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    await this.server.close().catch(() => undefined);
  }
}

export function createMCPServer(config: ServerConfig): GhitaMCPServer {
  return new GhitaMCPServer(config);
}
