export { MCPClient, createMCPClient } from './client.js';
export type { RemoteTool, CallToolResponse } from './client.js';
export { GhitaMCPServer, createMCPServer } from './server.js';
export { createLinkedPair } from './inmemory.js';
// demo2 P3.2 (Điểm 8): tầng health — trước demo2 chỉ có `connected: boolean`,
// không phân biệt được "chưa biết" với "biết là chết".
export { McpHealthStore, probeMcpHealth } from './health.js';
export type {
  McpHealthState,
  McpAuthState,
  McpHealthRecord,
  McpHealthProbeResult,
  McpHealthStoreOptions,
  McpHealthProbedClient,
} from './health.js';
export { MCP_VERSION } from './types.js';
export type {
  ClientTransportKind,
  MCPClientConfig,
  ClientStdioConfig,
  ClientUrlConfig,
  ClientInMemoryConfig,
  ToolDefinition,
  ToolInputSchema,
  MCPToolResult,
  ServerHooks,
  ServerConfig,
} from './types.js';
