import type { FlowStep, FlowStepResult, FlowContext, FlowConfig, FlowRunResult } from './types.js';

function generateId(): string {
  return `flow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Flow — Orchestrates multi-step task pipelines with dependencies.
 * Supports sequential, parallel, and DAG-based execution modes.
 * Inspired by CrewAI Flow.
 */
export class Flow {
  readonly name: string;
  readonly description?: string;
  private readonly steps: Map<string, FlowStep> = new Map();
  private readonly config: Required<Omit<FlowConfig, 'description'>>;

  constructor(config: FlowConfig) {
    this.name = config.name;
    this.description = config.description;
    this.config = {
      name: config.name,
      mode: config.mode ?? 'sequential',
      maxConcurrency: config.maxConcurrency ?? 5,
      timeout: config.timeout ?? 0,
      continueOnError: config.continueOnError ?? false,
    };
  }

  /** Add a step to the flow */
  addStep<TInput, TOutput>(step: FlowStep<TInput, TOutput>): this {
    this.steps.set(step.id, step as FlowStep);
    return this;
  }

  /** Remove a step */
  removeStep(id: string): boolean {
    return this.steps.delete(id);
  }

  /** Get a step by ID */
  getStep(id: string): FlowStep | undefined {
    return this.steps.get(id);
  }

  /** List all steps */
  listSteps(): FlowStep[] {
    return [...this.steps.values()];
  }

  /** Execute the flow */
  async run(initialState?: Record<string, unknown>): Promise<FlowRunResult> {
    const runId = generateId();
    const startTime = Date.now();
    const stateMap = new Map<string, unknown>();
    if (initialState) {
      for (const [k, v] of Object.entries(initialState)) stateMap.set(k, v);
    }
    const resultsMap = new Map<string, FlowStepResult>();

    const context: FlowContext = {
      runId,
      state: stateMap,
      results: resultsMap,
      set: <T>(key: string, value: T) => stateMap.set(key, value),
      get: <T>(key: string) => stateMap.get(key) as T | undefined,
      getStepOutput: <T>(stepId: string) => resultsMap.get(stepId)?.output as T | undefined,
    };

    let stepResults: FlowStepResult[];
    try {
      switch (this.config.mode) {
        case 'sequential':
          stepResults = await this.runSequential(context);
          break;
        case 'parallel':
          stepResults = await this.runParallel(context);
          break;
        case 'dag':
          stepResults = await this.runDAG(context);
          break;
        default:
          stepResults = await this.runSequential(context);
      }
    } catch (err) {
      return {
        runId,
        flowName: this.name,
        status: 'failed',
        steps: [...resultsMap.values()],
        duration: Date.now() - startTime,
        state: Object.fromEntries(stateMap),
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const hasFailure = stepResults.some((r) => r.status === 'failed');

    return {
      runId,
      flowName: this.name,
      status: hasFailure ? 'partial' : 'completed',
      steps: stepResults,
      duration: Date.now() - startTime,
      state: Object.fromEntries(stateMap),
    };
  }

  // ---- Execution Modes ----

  private async runSequential(context: FlowContext): Promise<FlowStepResult[]> {
    const results: FlowStepResult[] = [];
    for (const step of this.steps.values()) {
      const result = await this.executeStep(step, context);
      results.push(result);
      context.results.set(step.id, result);
      if (result.status === 'failed' && !this.config.continueOnError) {
        throw new Error(`Step "${step.id}" failed: ${result.error}`);
      }
    }
    return results;
  }

  private async runParallel(context: FlowContext): Promise<FlowStepResult[]> {
    const stepArray = [...this.steps.values()];
    const chunks = this.chunkArray(stepArray, this.config.maxConcurrency);
    const allResults: FlowStepResult[] = [];

    for (const chunk of chunks) {
      const chunkResults = await Promise.all(chunk.map((step) => this.executeStep(step, context)));
      for (const result of chunkResults) {
        context.results.set(result.stepId, result);
      }
      allResults.push(...chunkResults);
    }

    return allResults;
  }

  private async runDAG(context: FlowContext): Promise<FlowStepResult[]> {
    const results: FlowStepResult[] = [];
    const completed = new Set<string>();
    const stepMap = this.steps;

    // Topological execution
    const remaining = new Set(stepMap.keys());

    while (remaining.size > 0) {
      // Find steps whose dependencies are all satisfied
      const ready: FlowStep[] = [];
      for (const id of remaining) {
        const step = stepMap.get(id);
        if (!step) continue;
        const deps = step.dependsOn ?? [];
        const allDepsMet = deps.every((d) => completed.has(d));
        if (allDepsMet) ready.push(step);
      }

      if (ready.length === 0 && remaining.size > 0) {
        throw new Error('Circular dependency detected in flow DAG');
      }

      // Execute ready steps in parallel
      const chunkResults = await Promise.all(ready.map((step) => this.executeStep(step, context)));

      for (const result of chunkResults) {
        context.results.set(result.stepId, result);
        completed.add(result.stepId);
        remaining.delete(result.stepId);
        results.push(result);

        if (result.status === 'failed' && !this.config.continueOnError) {
          throw new Error(`Step "${result.stepId}" failed: ${result.error}`);
        }
      }
    }

    return results;
  }

  // ---- Step Execution ----

  private async executeStep(step: FlowStep, context: FlowContext): Promise<FlowStepResult> {
    const startTime = Date.now();
    const maxRetries = step.maxRetries ?? 0;
    let retries = 0;
    let lastError: string | undefined;

    // Check condition
    if (step.condition) {
      const shouldRun = await step.condition(context);
      if (!shouldRun) {
        return {
          stepId: step.id,
          status: 'skipped',
          duration: Date.now() - startTime,
          retries: 0,
        };
      }
    }

    // Gather input from dependencies
    const depOutputs: Record<string, unknown> = {};
    for (const depId of step.dependsOn ?? []) {
      const depResult = context.results.get(depId);
      if (depResult?.output !== undefined) {
        depOutputs[depId] = depResult.output;
      }
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        let output: unknown;

        if (step.timeout && step.timeout > 0) {
          // Timer phải được huỷ khi step xong sớm — nếu không, Promise.race đã
          // settle nhưng setTimeout vẫn treo tới hết `step.timeout`, giữ process
          // sống thừa đúng bằng thời gian timeout. `workflow-advanced.ts` đã
          // làm đúng chuyện này; bản ở `flow` thì bỏ sót.
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Step "${step.id}" timed out`)),
              step.timeout,
            );
          });
          try {
            output = await Promise.race([step.execute(depOutputs, context), timeoutPromise]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        } else {
          output = await step.execute(depOutputs, context);
        }

        return {
          stepId: step.id,
          status: 'completed',
          output,
          duration: Date.now() - startTime,
          // `attempt` là số lần thử lại ĐÃ DÙNG trên nhánh thành công (thử
          // đầu = 0). Dùng biến `retries` ở đây sẽ trả giá trị cũ của lần
          // catch gần nhất — fail 1 lần rồi thành công bị báo nhầm 0 retries.
          retries: attempt,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        retries = attempt; // `attempt` đã là số lần retry thực — cộng 1 là lệch
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }

    return {
      stepId: step.id,
      status: 'failed',
      error: lastError,
      duration: Date.now() - startTime,
      retries,
    };
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    // `size <= 0` khiến `i` không bao giờ tăng → vòng lặp vô tận nuốt CPU.
    // maxConcurrency tới từ người gọi nên phải chặn ở đây, không chỉ ở constructor.
    // NaN cũng phải chặn: Math.max(1, NaN) vẫn là NaN, `i += NaN` là false
    // ngay vòng đầu → cả flow chạy 0 step mà vẫn báo "completed".
    const step = Number.isFinite(size) ? Math.max(1, Math.floor(size)) : 1;
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += step) {
      chunks.push(arr.slice(i, i + step));
    }
    return chunks;
  }
}

/** Helper: create a flow step */
export function createStep<TInput, TOutput>(
  id: string,
  name: string,
  execute: (input: TInput, context: FlowContext) => Promise<TOutput>,
  options?: {
    description?: string;
    condition?: (context: FlowContext) => boolean | Promise<boolean>;
    dependsOn?: string[];
    maxRetries?: number;
    timeout?: number;
  },
): FlowStep<TInput, TOutput> {
  return {
    id,
    name,
    execute,
    description: options?.description,
    condition: options?.condition,
    dependsOn: options?.dependsOn,
    maxRetries: options?.maxRetries,
    timeout: options?.timeout,
  };
}
