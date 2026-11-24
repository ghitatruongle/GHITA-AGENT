// --- Platform ---
export type Platform = 'windows' | 'linux' | 'android' | 'macos' | 'ios';

// --- AI Provider ---
export type AIProviderType =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'ollama'
  | 'custom'
  | 'opengateway'
  | 'mimo'
  | 'openrouter'
  | 'deepseek'
  | 'groq'
  | 'mistral'
  | 'hicap'
  | 'github-models'
  // Phase 1.2: New providers
  | 'cerebras'
  | 'together'
  | 'fireworks'
  | 'cohere'
  | 'xai'
  | 'replicate'
  | 'perplexity'
  | 'voyage'
  | 'ai21'
  | 'sambanova'
  | 'novita'
  | 'opencode-zen'
  | 'nvidia-nim'
  // Phase 6: New vendors via defineVendor
  | 'kimi'
  | 'minimax'
  // v0.2.5: Advanced OpenAI & Anthropic Compatible Providers
  | 'vllm'
  | 'nebius'
  | 'siliconflow'
  | 'digitalocean'
  | 'azure-openai'
  | 'bedrock'
  | 'vertex-anthropic'
  | 'cloudflare-ai'
  | 'deepinfra'
  | 'hyperbolic'
  | 'zhipu'
  | 'qwen'
  | 'baichuan'
  | 'stepfun'
  | 'lmstudio'
  // v0.2.5 Expansion to 50 Providers Total
  | 'friendli'
  | 'octoai'
  | 'baseten'
  | 'modal'
  | 'lepton'
  | 'anyscale'
  | 'hunyuan';

export interface AIProviderConfig {
  type: AIProviderType;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  provider?: AIProviderType;
  model?: string;
}

/**
 * Track S3 P2 — StreamObject protocol. The 5 canonical chunk kinds carried on
 * the `type` field of every AIStreamChunk (and mirrored on the mobile wire).
 */
export type StreamChunkType =
  'text-delta' | 'reasoning' | 'tool-call' | 'tool-result' | 'tool-incomplete-result';

export interface AIStreamChunk {
  content: string;
  done: boolean;
  provider?: AIProviderType;
  model?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** StreamObject kind — see StreamChunkType. Legacy chunks without the field are text deltas. */
  type?: StreamChunkType;
  /** Tool-call correlation id for `tool-result` / `tool-incomplete-result` chunks. */
  toolCallId?: string;
  /** Why a `tool-incomplete-result` was cut short (abort, error, partial). */
  reason?: string;
  /** Provider-native function calls, emitted once their streamed arguments are complete. */
  toolCalls?: Array<{
    id?: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

// --- Skill ---
export type SkillCategory = 'file' | 'terminal' | 'browser' | 'computer' | 'screenshot' | 'app';

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  enabled: boolean;
  parameters?: Record<string, SkillParameter>;
}

export interface SkillParameter {
  type: 'string' | 'number' | 'boolean' | 'array';
  description: string;
  required: boolean;
  default?: unknown;
}

export interface SkillResult {
  success: boolean;
  output?: string;
  error?: string;
  data?: unknown;
  /** Whether this skill requires user approval before execution */
  requiresApproval?: boolean;
  /** ID of the skill that requires approval */
  skillId?: string;
  /** Name of the skill that requires approval */
  skillName?: string;
}

// --- Agent ---
export type AgentRole = 'coder' | 'reviewer' | 'researcher' | 'planner' | 'executor' | 'custom';

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  description: string;
  skills: string[];
  model?: string;
  systemPrompt?: string;
}

export interface AgentGroup {
  id: string;
  name: string;
  description: string;
  agents: string[];
  task?: string;
  status: 'idle' | 'working' | 'completed' | 'error';
}

export interface AgentTask {
  id: string;
  agentId: string;
  groupId?: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
  startTime?: number;
  endTime?: number;
}

// --- Communication ---
export type MessageType =
  'command' | 'screenshot' | 'status' | 'approve' | 'reject' | 'chat' | 'ping' | 'pong';

export interface SocketMessage {
  type: MessageType;
  payload: unknown;
  timestamp: number;
  deviceId?: string;
}

export interface PairingCode {
  code: string;
  expiresAt: number;
  deviceId?: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: Platform;
  connected: boolean;
  lastSeen: number;
}

export interface CommandPayload {
  action: string;
  params?: Record<string, unknown>;
  timestamp: number;
}

export interface ScreenStreamConfig {
  /** JPEG quality 1-100 */
  quality: number;
  /** Milliseconds between frames */
  interval: number;
  /** Max width in pixels (resize for bandwidth) */
  maxWidth: number;
}

// --- File System ---
export interface FileInfo {
  path: string;
  name: string;
  extension: string;
  size: number;
  isDirectory: boolean;
  modifiedAt: number;
}

export interface FileOperation {
  type: 'read' | 'write' | 'delete' | 'rename' | 'copy' | 'move';
  source: string;
  destination?: string;
  content?: string;
}

// --- Terminal ---
export interface TerminalCommand {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface TerminalResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
}

// --- Browser ---
export interface BrowserAction {
  type: 'navigate' | 'click' | 'type' | 'screenshot' | 'extract' | 'fill';
  selector?: string;
  value?: string;
  url?: string;
}

export interface BrowserResult {
  success: boolean;
  data?: string | Record<string, unknown>;
  screenshot?: string;
  error?: string;
}

// --- Memory ---
export interface MemoryEntry {
  id: string;
  type: 'conversation' | 'fact' | 'preference' | 'context';
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
  relevance?: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

// --- App Config ---
export interface AppConfig {
  language: string;
  theme: 'dark' | 'light' | 'system';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  socketPort: number;
  providers: AIProviderConfig[];
  autoUpdate: boolean;
}
