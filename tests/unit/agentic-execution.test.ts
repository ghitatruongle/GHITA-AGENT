import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ensureInSandbox,
  listDirectory,
  readFile,
  writeFile,
  replaceFileContent,
  grepSearch,
  runCommand,
} from '../../packages/ai-engine/src/tools/workspace-tools.js';
import { createReActAgent, AIMessage } from '@ghita/agents';

describe('7: Sandboxed Workspace Tools & Agentic Execution', () => {
  let tempWorkspaceRoot: string;

  beforeAll(() => {
    // Setup a local temporary directory as the workspace root sandbox
    tempWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ghita-workspace-test-'));
    globalThis.ghitaWorkspaceRoot = tempWorkspaceRoot;
    process.env.GHITA_WORKSPACE = tempWorkspaceRoot;
  });

  afterAll(() => {
    // Cleanup temporary workspace folder
    try {
      fs.rmSync(tempWorkspaceRoot, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup error if files are locked
    }
    globalThis.ghitaWorkspaceRoot = undefined;
    globalThis.approveCommandHandler = null;
  });

  beforeEach(() => {
    globalThis.approveCommandHandler = null;
  });

  describe('Path Sandboxing Security Guard (ensureInSandbox)', () => {
    it('should resolve and allow safe paths inside the sandbox', () => {
      const resolved = ensureInSandbox('src/index.ts');
      expect(resolved).toBe(path.resolve(tempWorkspaceRoot, 'src/index.ts'));
    });

    it('should block directory traversal paths escaping the sandbox', () => {
      expect(() => {
        ensureInSandbox('../../../etc/passwd');
      }).toThrow(/outside the active workspace sandbox/i);
    });

    it('should block absolute paths outside the sandbox', () => {
      const outsideDir = os.platform() === 'win32' ? 'C:\\Windows\\System32' : '/etc';
      expect(() => {
        ensureInSandbox(outsideDir);
      }).toThrow(/Security Exception/i);
    });
  });

  describe('File Workspace Tools', () => {
    it('should support write_file and read_file successfully', async () => {
      const filename = 'hello.txt';
      const content =
        'Line 1: Hello Ghita!\nLine 2: Anti-gravity is awesome!\nLine 3: Coding agent works!';

      const writeResult = await writeFile({ filePath: filename, content });
      expect(writeResult).toContain('File written successfully');

      const readAll = await readFile({ filePath: filename });
      // Track 3.1: read_file có header [path#TAG] trên dòng đầu.
      const readAllLines = readAll.split('\n');
      expect(readAllLines[0].startsWith('[hello.txt#')).toBe(true);
      expect(readAllLines.slice(1).join('\n')).toBe(content);

      // Line range reading — tag hash TOÀN file, body là dải dòng yêu cầu.
      const readLines = await readFile({ filePath: filename, startLine: 2, endLine: 3 });
      const readLinesParts = readLines.split('\n');
      expect(readLinesParts[0]).toMatch(/^\[/);
      expect(readLinesParts.slice(1).join('\n')).toBe('Line 2: Anti-gravity is awesome!\nLine 3: Coding agent works!');
    });

    it('should support list_dir tool with directory recursive/non-recursive search', async () => {
      await writeFile({ filePath: 'src/core/main.ts', content: 'console.log("Core");' });
      await writeFile({
        filePath: 'src/utils/math.ts',
        content: 'export const add = (a, b) => a + b;',
      });

      const listResStr = await listDirectory({ recursive: true });
      const filesList = JSON.parse(listResStr);

      const paths = filesList.map((f: any) => f.path);
      expect(paths).toContain(path.normalize('src/core/main.ts'));
      expect(paths).toContain(path.normalize('src/utils/math.ts'));
    });

    it('should support replace_file_content tool correctly', async () => {
      const filename = 'patch_test.ts';
      const content = 'import { a } from "a";\n\nexport function run() {\n  return 1;\n}';

      await writeFile({ filePath: filename, content });

      const targetContent = 'export function run() {\n  return 1;\n}';
      const replacementContent = 'export function run() {\n  return 2;\n}';

      const patchResult = await replaceFileContent({
        filePath: filename,
        targetContent,
        replacementContent,
      });

      expect(patchResult).toContain('Successfully replaced content');

      const updated = await readFile({ filePath: filename });
      const updatedBody = updated.split('\n').slice(1).join('\n');
      expect(updatedBody).toBe('import { a } from "a";\n\nexport function run() {\n  return 2;\n}');
    });

    it('should support grep_search tool to scan matching files', async () => {
      await writeFile({
        filePath: 'test-grep1.txt',
        content: 'Find this magical word right here!',
      });
      await writeFile({ filePath: 'test-grep2.txt', content: 'Nothing special in this one.' });

      const searchRes = await grepSearch({ query: 'magical word' });
      const matches = JSON.parse(searchRes);

      expect(matches.length).toBe(1);
      expect(matches[0].file).toBe('test-grep1.txt');
      expect(matches[0].line).toBe(1);
      expect(matches[0].content).toContain('Find this magical word right here!');
    });
  });

  describe('Shell Command Execution Guard (runCommand)', () => {
    it('should successfully run a safe echo command', async () => {
      const cmd =
        process.platform === 'win32'
          ? 'cmd.exe /c echo "TEST_COMMAND_OK"'
          : 'echo "TEST_COMMAND_OK"';
      const res = await runCommand({ command: cmd });
      expect(res).toContain('TEST_COMMAND_OK');
    });

    it('should block dangerous shell commands in safety patterns', async () => {
      await expect(runCommand({ command: 'rm -rf /' })).rejects.toThrow(/Security Exception/i);
    });

    it('should integrate with the approveCommandHandler hook correctly', async () => {
      let approvedCount = 0;
      globalThis.approveCommandHandler = async (cmd) => {
        approvedCount++;
        return cmd.includes('allowed');
      };

      const cmdAllowed =
        process.platform === 'win32' ? 'cmd.exe /c echo allowed cmd' : 'echo "allowed cmd"';
      const cmdBlocked =
        process.platform === 'win32' ? 'cmd.exe /c echo blocked cmd' : 'echo "blocked cmd"';

      const allowedRes = await runCommand({ command: cmdAllowed });
      expect(allowedRes).toContain('allowed cmd');
      expect(approvedCount).toBe(1);

      await expect(runCommand({ command: cmdBlocked })).rejects.toThrow(/Permission Denied/i);
      expect(approvedCount).toBe(2);
    });
  });

  describe('End-to-End ReAct Agent Sandbox Loop Integration', () => {
    it('should orchestrate a reasoning and actions loop executing workspace tools stably', async () => {
      const task =
        'Create a config file config.json with key "port" set to 8080, then read it back and verify its contents.';

      // Let's mock a sequence of LLM responses to drive the ReAct Agent through steps:
      // Step 1: Think → Write config.json
      // Step 2: Think → Read config.json
      // Step 3: Think → Complete task
      let stepNum = 0;

      const llmCallMock = async (messages: any[]) => {
        stepNum++;
        if (stepNum === 1) {
          return new AIMessage(
            'I will create the configuration file `config.json` using the `write_file` tool.',
            {
              metadata: {
                toolCalls: [
                  {
                    id: 'call_write_config',
                    name: 'write_file',
                    arguments: { filePath: 'config.json', content: '{\n  "port": 8080\n}' },
                  },
                ],
              },
            },
          );
        } else if (stepNum === 2) {
          return new AIMessage(
            'The configuration file has been written. Now I will read it back to verify its content using `read_file`.',
            {
              metadata: {
                toolCalls: [
                  {
                    id: 'call_read_config',
                    name: 'read_file',
                    arguments: { filePath: 'config.json' },
                  },
                ],
              },
            },
          );
        } else {
          const lastMsg = messages[messages.length - 1];
          const observation = lastMsg.getText();
          return new AIMessage(
            `I have successfully verified the configuration file contents:\n${observation}\nThe task is completed!`,
            {},
          );
        }
      };

      const toolsList = [
        {
          name: 'write_file',
          description: 'Write file content',
          parameters: {},
          execute: async (args: any) =>
            await writeFile({ filePath: args.filePath, content: args.content }),
        },
        {
          name: 'read_file',
          description: 'Read file content',
          parameters: {},
          execute: async (args: any) => await readFile({ filePath: args.filePath }),
        },
      ];

      const agent = createReActAgent({
        config: {
          name: 'GhitaTestAgent',
          maxIterations: 5,
          tools: toolsList,
        },
        llmCall: llmCallMock,
      });

      const result = await agent.run(task);
      expect(result.iterations).toBe(3);
      expect(result.steps.length).toBe(2);
      expect(result.output).toContain('successfully verified');

      // Confirm the file is actually written in the sandboxed path
      const fileContent = fs.readFileSync(path.join(tempWorkspaceRoot, 'config.json'), 'utf8');
      expect(JSON.parse(fileContent).port).toBe(8080);
    });
  });
});
