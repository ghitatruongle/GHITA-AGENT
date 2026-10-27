import type { SkillDefinition } from '@ghita/skills';
import type { SkillResult } from '@ghita/shared';
import { ActionParser } from './actionParser.js';

export * from './vision/types.js';
export { GuiGrounder } from './vision/grounding.js';
export { VisionScreenshotAnalyzer } from './vision/analyzer.js';
export { ActionParser } from './actionParser.js';
export {
  HeadlessSearchScanner,
  type HeadlessSearchOptions,
  type HeadlessSearchResult,
} from './scanner/headlessSearch.js';
export { UITarsBoundingBoxDetector, type UITarget } from './uitars/bounding-box-detector.js';

export const COMPUTER_USE_VERSION = '0.0.0-preview';

export interface Point {
  x: number;
  y: number;
}

export interface ScreenSize {
  width: number;
  height: number;
}

export interface ScreenCapture {
  mimeType: string;
  data: string;
  size?: ScreenSize;
}

export type MouseButton = 'left' | 'right' | 'middle';

export type ComputerUseAction =
  | { type: 'moveMouse'; point: Point }
  | { type: 'click'; point?: Point; button?: MouseButton }
  | { type: 'typeText'; text: string }
  | { type: 'pressKey'; key: string }
  | { type: 'screenshot' }
  | { type: 'wait' };

export interface ComputerUseActionResult {
  action: ComputerUseAction;
  success: boolean;
  output?: string;
  error?: string;
  data?: unknown;
}

export interface ComputerUseAdapter {
  getScreenSize?: () => Promise<ScreenSize>;
  moveMouse?: (point: Point) => Promise<void>;
  click?: (point?: Point, button?: MouseButton) => Promise<void>;
  typeText?: (text: string) => Promise<void>;
  pressKey?: (key: string) => Promise<void>;
  screenshot?: () => Promise<ScreenCapture>;
}

export interface ComputerUseStatus {
  available: boolean;
  missing: string[];
}

function success(
  action: ComputerUseAction,
  output: string,
  data?: unknown,
): ComputerUseActionResult {
  return { action, success: true, output, data };
}

function failure(action: ComputerUseAction, error: string): ComputerUseActionResult {
  return { action, success: false, error };
}

function toSkillResult(result: ComputerUseActionResult): SkillResult {
  return {
    success: result.success,
    output: result.output,
    error: result.error,
    data: result.data,
  };
}

function readNumber(input: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = input?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export class ComputerUseController {
  constructor(private readonly adapter: ComputerUseAdapter = {}) {}

  getStatus(): ComputerUseStatus {
    const required: Array<keyof ComputerUseAdapter> = [
      'moveMouse',
      'click',
      'typeText',
      'pressKey',
      'screenshot',
    ];
    const missing = required.filter((key) => typeof this.adapter[key] !== 'function');
    return { available: missing.length === 0, missing };
  }

  async moveMouse(point: Point): Promise<ComputerUseActionResult> {
    const action: ComputerUseAction = { type: 'moveMouse', point };
    if (!this.adapter.moveMouse) return failure(action, 'Mouse movement adapter is not available.');
    await this.adapter.moveMouse(point);
    return success(action, `Moved mouse to ${point.x}, ${point.y}.`);
  }

  async click(point?: Point, button: MouseButton = 'left'): Promise<ComputerUseActionResult> {
    const action: ComputerUseAction = { type: 'click', point, button };
    if (!this.adapter.click) return failure(action, 'Mouse click adapter is not available.');
    await this.adapter.click(point, button);
    return success(action, `Clicked ${button}${point ? ` at ${point.x}, ${point.y}` : ''}.`);
  }

  async typeText(text: string): Promise<ComputerUseActionResult> {
    const action: ComputerUseAction = { type: 'typeText', text };
    if (!this.adapter.typeText) return failure(action, 'Keyboard typing adapter is not available.');
    await this.adapter.typeText(text);
    return success(action, `Typed ${text.length} characters.`);
  }

  async pressKey(key: string): Promise<ComputerUseActionResult> {
    const action: ComputerUseAction = { type: 'pressKey', key };
    if (!this.adapter.pressKey) return failure(action, 'Keyboard key adapter is not available.');
    await this.adapter.pressKey(key);
    return success(action, `Pressed ${key}.`);
  }

  async screenshot(): Promise<ComputerUseActionResult> {
    const action: ComputerUseAction = { type: 'screenshot' };
    if (!this.adapter.screenshot) return failure(action, 'Screenshot adapter is not available.');
    const capture = await this.adapter.screenshot();
    return success(action, 'Captured screenshot.', capture);
  }

  async runAction(action: ComputerUseAction): Promise<ComputerUseActionResult> {
    switch (action.type) {
      case 'moveMouse':
        return this.moveMouse(action.point);
      case 'click':
        return this.click(action.point, action.button);
      case 'typeText':
        return this.typeText(action.text);
      case 'pressKey':
        return this.pressKey(action.key);
      case 'screenshot':
        return this.screenshot();
      case 'wait': {
        const waitAction: ComputerUseAction = { type: 'wait' };
        return success(waitAction, 'Wait action is handled in executeActions.');
      }
    }
  }

  async runSequence(actions: ComputerUseAction[]): Promise<ComputerUseActionResult[]> {
    const results: ComputerUseActionResult[] = [];
    for (const action of actions) {
      const result = await this.runAction(action);
      results.push(result);
      if (!result.success) break;
    }
    return results;
  }

  /**
   * Execute prediction string (UI-TARS or multimodal action output) on screen context.
   */
  async executeActionText(
    prediction: string,
    size: ScreenSize,
  ): Promise<ComputerUseActionResult[]> {
    const parsedActions = ActionParser.parse({
      prediction,
      factor: 1000,
      screenContext: { width: size.width, height: size.height },
    });

    const results: ComputerUseActionResult[] = [];

    for (const action of parsedActions) {
      const type = action.action_type;
      const inputs = action.action_inputs;

      let result: ComputerUseActionResult;
      const startCoords = inputs.start_coords; // [physX, physY]
      // const endCoords = inputs.end_coords; // [physX, physY]

      const startPoint: Point | undefined = startCoords
        ? { x: startCoords[0], y: startCoords[1] }
        : undefined;
      // const endPoint: Point | undefined = endCoords ? { x: endCoords[0], y: endCoords[1] } : undefined;

      switch (type) {
        case 'mouse_move':
        case 'hover': {
          if (!startPoint) {
            result = failure(
              { type: 'moveMouse', point: { x: 0, y: 0 } },
              'Missing start_coords for hover/mouse_move',
            );
          } else {
            result = await this.moveMouse(startPoint);
          }
          break;
        }
        case 'click':
        case 'left_click':
        case 'left_single': {
          result = await this.click(startPoint, 'left');
          break;
        }
        case 'left_double':
        case 'double_click': {
          const actionObj: ComputerUseAction = { type: 'click', point: startPoint, button: 'left' };
          if (!this.adapter.click) {
            result = failure(actionObj, 'Mouse click adapter is not available.');
          } else {
            await this.adapter.click(startPoint, 'left');
            await new Promise((resolve) => setTimeout(resolve, 100));
            await this.adapter.click(startPoint, 'left');
            result = success(
              actionObj,
              `Double clicked left at ${startPoint ? `${startPoint.x}, ${startPoint.y}` : 'current position'}`,
            );
          }
          break;
        }
        case 'right_click':
        case 'right_single': {
          result = await this.click(startPoint, 'right');
          break;
        }
        case 'middle_click': {
          result = await this.click(startPoint, 'middle');
          break;
        }
        case 'type': {
          const text = inputs.content || inputs.text || '';
          if (startPoint) {
            const clickResult = await this.click(startPoint);
            if (!clickResult.success) {
              result = clickResult;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          result = await this.typeText(String(text));
          break;
        }
        case 'press':
        case 'hotkey': {
          const key = inputs.key || inputs.hotkey || inputs.text || '';
          result = await this.pressKey(String(key));
          break;
        }
        case 'screenshot': {
          result = await this.screenshot();
          break;
        }
        case 'wait': {
          const actionObj: ComputerUseAction = { type: 'wait' };
          const waitTime = inputs.time ? parseInt(String(inputs.time), 10) * 1000 : 5000;
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          result = success(actionObj, `Waited for ${waitTime}ms.`);
          break;
        }
        default: {
          const actionObj: ComputerUseAction = { type: 'screenshot' };
          result = failure(actionObj, `Unsupported action type: ${type}`);
        }
      }
      results.push(result);
      if (!result.success) break;
    }

    return results;
  }
}

// Node-only sandbox and guardrail exports live in '@ghita/computer-use/node'.

export function createComputerUseSkills(
  controller = new ComputerUseController(),
): SkillDefinition[] {
  return [
    {
      id: 'computer.moveMouse',
      name: 'Move Mouse',
      description: 'Move the mouse cursor to screen coordinates.',
      category: 'computer',
      enabled: false,
      version: COMPUTER_USE_VERSION,
      scopes: ['desktop'],
      status: 'disabled',
      parameters: {
        x: { type: 'number', description: 'X coordinate', required: true },
        y: { type: 'number', description: 'Y coordinate', required: true },
      },
      run: async ({ input }, _context) => {
        const x = readNumber(input, 'x');
        const y = readNumber(input, 'y');
        if (x === undefined || y === undefined) {
          return { success: false, error: 'Missing required inputs: x and y' };
        }
        return toSkillResult(await controller.moveMouse({ x, y }));
      },
    },
    {
      id: 'computer.click',
      name: 'Click Mouse',
      description: 'Click at the current cursor or a target coordinate.',
      category: 'computer',
      enabled: false,
      version: COMPUTER_USE_VERSION,
      scopes: ['desktop'],
      status: 'disabled',
      parameters: {
        x: { type: 'number', description: 'Optional X coordinate', required: false },
        y: { type: 'number', description: 'Optional Y coordinate', required: false },
      },
      run: async ({ input }, _context) => {
        const x = readNumber(input, 'x');
        const y = readNumber(input, 'y');
        const point = x === undefined || y === undefined ? undefined : { x, y };
        return toSkillResult(await controller.click(point));
      },
    },
    {
      id: 'computer.typeText',
      name: 'Type Text',
      description: 'Type text through the keyboard adapter.',
      category: 'computer',
      enabled: false,
      version: COMPUTER_USE_VERSION,
      scopes: ['desktop'],
      status: 'disabled',
      parameters: {
        text: { type: 'string', description: 'Text to type', required: true },
      },
      run: async ({ input }, _context) => {
        const text = readString(input, 'text');
        if (!text) return { success: false, error: 'Missing required input: text' };
        return toSkillResult(await controller.typeText(text));
      },
    },
    {
      id: 'computer.screenshot',
      name: 'Computer Screenshot',
      description: 'Capture the screen through the computer-use adapter.',
      category: 'computer',
      enabled: false,
      version: COMPUTER_USE_VERSION,
      scopes: ['desktop'],
      status: 'disabled',
      run: async (_invocation, _context) => toSkillResult(await controller.screenshot()),
    },
  ];
}
