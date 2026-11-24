import { WebSearchTool } from './web-search.js';
import { WebFetchTool } from './web-fetch.js';
import {
  listDirectory,
  readFile,
  writeFile,
  replaceFileContent,
  grepSearch,
  runCommand,
} from './workspace-tools.js';
import { ToolApprovalManager } from '../tool-calling/approvals.js';
import { AgentError } from '../errors/index.js';

export { WebSearchTool } from './web-search.js';
export type { SearchResult, SearchResponse } from './web-search.js';
export { WebFetchTool } from './web-fetch.js';
export type { FetchResponse } from './web-fetch.js';
export * from './workspace-tools.js';
export * from './registry.js';
export * from './custom-tools.js';

/** Built-in tool definitions cho AI function calling */
export interface BuiltInTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

// --- Track S3 P3: `choose` — human-in-the-loop decision tool ---
//
// The model asks the user to pick from 2-8 options and the run PAUSES until
// the user decides. Reuses the existing ToolApprovalManager (awaitDecision,
// deny-default) and the require_approval / approve_command event vocabulary —
// no new approval machinery.

/** Payload a host (sidecar / mobile bus) receives when `choose` starts waiting. */
export interface ChooseRequestPayload {
  id: string;
  question: string;
  options: string[];
  allowCustom: boolean;
}

interface ChooseHostGlobals {
  chooseRequestHandler?: (payload: ChooseRequestPayload) => void;
}

export const CHOOSE_TIMEOUT_MS = 60_000;
const CHOOSE_DECISION_PREFIX = 'choice:';

/** Shared approval manager for every `choose` invocation. */
const chooseApprovals = new ToolApprovalManager({ timeoutMs: CHOOSE_TIMEOUT_MS });

export function getChooseApprovalManager(): ToolApprovalManager {
  return chooseApprovals;
}

/**
 * Host-side resolver: feed the user's decision back into the pending `choose`
 * request. `choice` is the picked option text (or free text when allowCustom).
 * Wire-compatible with the existing approve_command / reject_command events —
 * the sidecar just calls this (or `approve(id)` for the default option).
 */
export function resolveChoose(id: string, approved: boolean, choice?: string): boolean {
  if (approved) {
    return chooseApprovals.approve(
      id,
      choice !== undefined ? `${CHOOSE_DECISION_PREFIX}${choice}` : 'user',
    );
  }
  return chooseApprovals.deny(id, choice ?? 'user');
}

function chooseError(
  message: string,
  code: 'invalid_request' | 'auth',
  details?: unknown,
): AgentError {
  return new AgentError(message, { code, provider: 'choose', retryable: false, details });
}

/** Execute the `choose` tool: broadcast the question, wait, report the pick. */
export async function executeChoose(args: Record<string, unknown>): Promise<string> {
  const question = String(args.question ?? '').trim();
  const options = Array.isArray(args.options) ? args.options.map((o) => String(o)) : [];
  const allowCustom = args.allowCustom === true;

  if (!question) {
    throw chooseError('choose: "question" is required', 'invalid_request');
  }
  if (options.length < 2 || options.length > 8 || options.some((o) => !o.trim())) {
    throw chooseError('choose: "options" must contain 2-8 non-empty choices', 'invalid_request');
  }

  const request = chooseApprovals.request('choose', { question, options, allowCustom }, 'choose');
  const host = globalThis as unknown as ChooseHostGlobals;
  if (typeof host.chooseRequestHandler === 'function') {
    try {
      host.chooseRequestHandler({
        id: request.call.id,
        question,
        options,
        allowCustom,
      });
    } catch (err) {
      console.warn('[choose] chooseRequestHandler failed:', err);
    }
  }

  const decision = await chooseApprovals.awaitDecision(request.call.id);
  if (decision.state !== 'approved') {
    throw chooseError(`User declined to answer: "${question}"`, 'auth', {
      decidedBy: decision.decidedBy ?? 'timeout',
      state: decision.state,
    });
  }

  const decidedBy = decision.decidedBy ?? '';
  let selected = '';
  let selectedIndex = -1;
  if (decidedBy.startsWith(CHOOSE_DECISION_PREFIX)) {
    const raw = decidedBy.slice(CHOOSE_DECISION_PREFIX.length);
    const index = options.indexOf(raw);
    if (index >= 0) {
      selected = raw;
      selectedIndex = index;
    } else if (allowCustom && raw) {
      // Free-text answer from the user.
      selected = raw;
    } else {
      // Plain approve (no encoded choice, e.g. desktop Approve button) or an
      // unrecognized choice — fall back to the first option.
      selected = options[0] ?? '';
      selectedIndex = 0;
    }
  } else {
    // Approved by session-default or a bare user approve.
    selected = options[0] ?? '';
    selectedIndex = 0;
  }

  return JSON.stringify(
    {
      approved: true,
      question,
      options,
      selected,
      selectedIndex,
      customAnswer: selectedIndex === -1,
      decidedBy,
    },
    null,
    2,
  );
}

export function createBuiltInTools(): BuiltInTool[] {
  const webSearch = new WebSearchTool();
  const webFetch = new WebFetchTool();

  return [
    {
      name: 'web_search',
      description:
        'Search the web for information. Returns search results with titles, URLs, and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          maxResults: { type: 'number', description: 'Max results (default 5)', default: 5 },
        },
        required: ['query'],
      },
      execute: async (args) => {
        const query = String(args.query ?? '');
        const maxResults = Number(args.maxResults ?? 5);
        const result = await webSearch.search(query, maxResults);
        return JSON.stringify(result, null, 2);
      },
    },
    {
      name: 'web_fetch',
      description: 'Fetch content from a URL. Returns the page content as text/markdown.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
        },
        required: ['url'],
      },
      execute: async (args) => {
        const url = String(args.url ?? '');
        const result = await webFetch.fetch(url);
        return `Title: ${result.title}\nURL: ${result.url}\nStatus: ${result.statusCode}\n\n${result.content}`;
      },
    },
    {
      name: 'list_dir',
      description:
        'List all files and directories recursively or non-recursively inside the workspace sandbox.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path of directory to list (optional, default is workspace root)',
          },
          recursive: {
            type: 'boolean',
            description: 'Whether to list subdirectories recursively (optional, default is false)',
          },
        },
      },
      execute: async (args) => {
        const pathParam = args.path !== undefined ? String(args.path) : undefined;
        const recursive = args.recursive === true;
        return await listDirectory({ path: pathParam, recursive });
      },
    },
    {
      name: 'read_file',
      description:
        'Read the contents of a file inside the workspace sandbox, optionally specifying a line range.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Relative path of the file to read' },
          startLine: { type: 'number', description: '1-indexed starting line to read (optional)' },
          endLine: {
            type: 'number',
            description: '1-indexed ending line to read (inclusive, optional)',
          },
        },
        required: ['filePath'],
      },
      execute: async (args) => {
        const filePath = String(args.filePath);
        const startLine = args.startLine !== undefined ? Number(args.startLine) : undefined;
        const endLine = args.endLine !== undefined ? Number(args.endLine) : undefined;
        return await readFile({ filePath, startLine, endLine });
      },
    },
    {
      name: 'write_file',
      description:
        'Write complete contents to a new or existing file inside the workspace sandbox.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Relative path of the file to write' },
          content: { type: 'string', description: 'The complete string content to write' },
        },
        required: ['filePath', 'content'],
      },
      execute: async (args) => {
        const filePath = String(args.filePath);
        const content = String(args.content);
        return await writeFile({ filePath, content });
      },
    },
    {
      name: 'replace_file_content',
      description:
        'Replace a single contiguous unique block of lines in an existing file inside the workspace sandbox.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Relative path of the file' },
          targetContent: {
            type: 'string',
            description: 'The precise lines of code in the file to be replaced',
          },
          replacementContent: {
            type: 'string',
            description: 'The complete replacement lines of code',
          },
        },
        required: ['filePath', 'targetContent', 'replacementContent'],
      },
      execute: async (args) => {
        const filePath = String(args.filePath);
        const targetContent = String(args.targetContent);
        const replacementContent = String(args.replacementContent);
        return await replaceFileContent({ filePath, targetContent, replacementContent });
      },
    },
    {
      name: 'grep_search',
      description:
        'Find occurrences of a text query across all supported files in the workspace sandbox.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The exact string/substring to look for' },
        },
        required: ['query'],
      },
      execute: async (args) => {
        const query = String(args.query);
        return await grepSearch({ query });
      },
    },
    {
      name: 'run_command',
      description:
        'Execute a terminal shell command inside the workspace sandbox with safety guardrails.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The terminal command to run' },
          timeoutMs: {
            type: 'number',
            description: 'Execution timeout in milliseconds (optional, default is 30000)',
          },
        },
        required: ['command'],
      },
      execute: async (args) => {
        const command = String(args.command);
        const timeoutMs = args.timeoutMs !== undefined ? Number(args.timeoutMs) : undefined;
        return await runCommand({ command, timeoutMs });
      },
    },
    {
      name: 'choose',
      description:
        'Ask the user to pick one option from 2-8 choices. The agent run pauses until the user answers; returns the option the user selected. Use for any decision that needs human input.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question to show the user',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '2-8 answer options the user can pick from',
          },
          allowCustom: {
            type: 'boolean',
            description: 'Whether the user may answer with free text instead of the listed options',
          },
        },
        required: ['question', 'options'],
      },
      execute: async (args) => await executeChoose(args),
    },
  ];
}
