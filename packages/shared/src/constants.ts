import type { AIProviderType, SkillCategory } from './types.js';

// --- App Info ---
export const APP_NAME = 'Ghita Agent';
export const APP_VERSION = '0.0.0';
export const APP_DESCRIPTION = 'Desktop AI Agent với multi-provider, skills, computer use';

// --- Default Config ---
export const DEFAULT_SOCKET_PORT = 8080;
export const DEFAULT_LANGUAGE = 'vi';
export const DEFAULT_THEME = 'dark' as const;
export const DEFAULT_LOG_LEVEL = 'info' as const;
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_TEMPERATURE = 0.7;

// --- AI Providers ---
export const AI_PROVIDERS: Record<AIProviderType, { name: string; defaultModel: string }> = {
  openai: { name: 'OpenAI', defaultModel: 'gpt-4o' },
  anthropic: { name: 'Anthropic', defaultModel: 'claude-sonnet-4-20250514' },
  google: { name: 'Google', defaultModel: 'gemini-1.5-pro' },
  ollama: { name: 'Ollama (Local)', defaultModel: 'llama3' },
  custom: { name: 'Custom', defaultModel: '' },
  opengateway: { name: 'Gitlawb Opengateway', defaultModel: 'mimo-v2.5-pro' },
  mimo: { name: 'Xiaomi MiMo', defaultModel: 'mimo-v2.5-pro' },
  openrouter: { name: 'OpenRouter', defaultModel: 'anthropic/claude-sonnet-4' },
  deepseek: { name: 'DeepSeek', defaultModel: 'deepseek-chat' },
  groq: { name: 'Groq', defaultModel: 'llama-3.1-70b-versatile' },
  mistral: { name: 'Mistral', defaultModel: 'mistral-large-latest' },
  hicap: { name: 'Hicap', defaultModel: '' },
  'github-models': { name: 'GitHub Models', defaultModel: 'gpt-4o' },

  cerebras: { name: 'Cerebras', defaultModel: 'llama3.1-8b' },
  together: { name: 'Together AI', defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo' },
  fireworks: {
    name: 'Fireworks AI',
    defaultModel: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
  },
  cohere: { name: 'Cohere', defaultModel: 'command-r-plus' },
  xai: { name: 'xAI (Grok)', defaultModel: 'grok-beta' },
  replicate: { name: 'Replicate', defaultModel: 'meta/llama-3.1-8b-instruct' },
  perplexity: { name: 'Perplexity', defaultModel: 'llama-3.1-sonar-small-128k-online' },
  voyage: { name: 'Voyage AI', defaultModel: 'voyage-3' },
  ai21: { name: 'AI21 Labs', defaultModel: 'jamba-1.5-large' },
  sambanova: { name: 'SambaNova', defaultModel: 'Meta-Llama-3.1-8B-Instruct' },
  novita: { name: 'Novita AI', defaultModel: 'meta-llama/llama-3.1-8b-instruct' },
  'opencode-zen': { name: 'OpenCode Zen', defaultModel: 'minimax-m3-free' },
  'nvidia-nim': { name: 'NVIDIA NIM', defaultModel: 'nvidia/nemotron-3-super-120b-a12b' },

  kimi: { name: 'Kimi (Moonshot AI)', defaultModel: 'moonshot-v1-8k' },
  minimax: { name: 'MiniMax', defaultModel: 'minimax-v1' },
  // v0.2.5: Advanced OpenAI & Anthropic Compatible Providers
  vllm: { name: 'vLLM (Local)', defaultModel: 'meta-llama/Llama-3.1-8B-Instruct' },
  nebius: { name: 'Nebius AI', defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct' },
  siliconflow: { name: 'SiliconFlow', defaultModel: 'Qwen/Qwen2.5-72B-Instruct' },
  digitalocean: { name: 'DigitalOcean GenAI', defaultModel: 'meta-llama-3.1-70b-instruct' },
  'azure-openai': { name: 'Azure OpenAI', defaultModel: 'gpt-4o' },
  bedrock: { name: 'Amazon Bedrock', defaultModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0' },
  'vertex-anthropic': {
    name: 'Google Vertex (Claude)',
    defaultModel: 'claude-3-5-sonnet@20241022',
  },
  'cloudflare-ai': {
    name: 'Cloudflare Workers AI',
    defaultModel: '@cf/meta/llama-3.1-8b-instruct',
  },
  deepinfra: { name: 'DeepInfra', defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct' },
  hyperbolic: { name: 'Hyperbolic AI', defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct' },
  zhipu: { name: 'Zhipu AI (GLM-4)', defaultModel: 'glm-4-flash' },
  qwen: { name: 'Alibaba Qwen', defaultModel: 'qwen-max' },
  baichuan: { name: 'Baichuan AI', defaultModel: 'Baichuan4' },
  stepfun: { name: 'StepFun', defaultModel: 'step-1-8k' },
  lmstudio: { name: 'LM Studio (Local)', defaultModel: 'local-model' },
  // v0.2.5 Expansion to 50 Providers Total
  friendli: { name: 'FriendliAI', defaultModel: 'meta-llama-3.1-70b-instruct' },
  octoai: { name: 'OctoAI', defaultModel: 'meta-llama-3.1-70b-instruct' },
  baseten: { name: 'Baseten AI', defaultModel: 'llama-3.1-70b-instruct' },
  modal: { name: 'Modal Labs', defaultModel: 'vllm-llama-3.1-70b' },
  lepton: { name: 'Lepton AI', defaultModel: 'llama3-1-70b' },
  anyscale: { name: 'Anyscale Endpoints', defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct' },
  hunyuan: { name: 'Tencent Hunyuan', defaultModel: 'hunyuan-pro' },
};

export const OLLAMA_DEFAULT_URL = 'http://localhost:11434';

// --- Skill Categories ---
export const SKILL_CATEGORIES: Record<SkillCategory, { name: string; icon: string }> = {
  file: { name: 'File Manager', icon: '📁' },
  terminal: { name: 'Terminal', icon: '💻' },
  browser: { name: 'Browser Control', icon: '🌐' },
  computer: { name: 'Computer Use', icon: '🖥️' },
  screenshot: { name: 'Screenshot', icon: '📸' },
  app: { name: 'App Control', icon: '⚙️' },
};

// --- Agent Roles ---
export const AGENT_ROLES = {
  coder: { name: 'Coder', description: 'Viết và sửa code' },
  reviewer: { name: 'Reviewer', description: 'Review code quality' },
  researcher: { name: 'Researcher', description: 'Tìm kiếm thông tin' },
  planner: { name: 'Planner', description: 'Lập kế hoạch task' },
  executor: { name: 'Executor', description: 'Thực thi task' },
  custom: { name: 'Custom', description: 'Tùy chỉnh' },
} as const;

// --- Socket Events ---
export const SOCKET_EVENTS = {
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  PAIR: 'pair',
  PAIR_CONFIRM: 'pair_confirm',
  COMMAND: 'command',
  SCREENSHOT: 'screenshot',
  STATUS: 'status',
  APPROVE: 'approve',
  REJECT: 'reject',
  CHAT: 'chat',
  SCREEN_STREAM: 'screen_stream',
  PING: 'ping',
  PONG: 'pong',
  ERROR: 'error',

  REQUIRE_APPROVAL: 'require_approval',
  APPROVE_COMMAND: 'approve_command',
  REJECT_COMMAND: 'reject_command',
  COST_TELEMETRY: 'cost_telemetry',
  SYNC_LANGUAGE: 'sync_language',
  FILE_CHANGE: 'file_change',
  VSCODE_FILE_CHANGE: 'vscode_file_change',
  MOBILE_TOUCH: 'mobile_touch',
  MOBILE_TYPE: 'mobile_type',
  MOBILE_KEY: 'mobile_key',

  FILE_APPROVAL: 'file_approval',
  REQUIRE_FILE_APPROVAL: 'require_file_approval',

  CHAT_START: 'chat_start',
} as const;

// --- Screen Stream Defaults ---
export const DEFAULT_SCREEN_QUALITY = 60;
export const DEFAULT_STREAM_INTERVAL = 1000;
export const DEFAULT_STREAM_MAX_WIDTH = 1280;
export const DEFAULT_PAIRING_TTL = 300_000; // 5 minutes

// --- File Extensions ---
export const CODE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.cpp',
  '.c',
  '.h',
  '.css',
  '.html',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.md',
  '.sql',
  '.sh',
] as const;

// --- Paths ---
export const CONFIG_DIR_NAME = '.ghita';
export const LOG_DIR_NAME = 'logs';
export const MEMORY_DIR_NAME = 'memory';
