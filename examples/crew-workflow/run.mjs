#!/usr/bin/env node
/**
 * Crew + block-graph engine demo — no network, no API keys.
 * Runs the real engines from @ghita/agents with a scripted LLM stub.
 *
 * Prerequisite: pnpm --filter @ghita/agents build
 */
const agentsDist = new URL('../../packages/agents/dist/index.js', import.meta.url);

let agents;
try {
  agents = await import(agentsDist.href);
} catch {
  console.error('Cannot import @ghita/agents dist. Run: pnpm --filter @ghita/agents build');
  process.exit(1);
}

const { AIMessage } = agents;

/** Scripted LLM: answers immediately with member-aware text, never calls tools. */
function fakeLlmCall(messages) {
  const system = messages.find((m) => m.role === 'system')?.getText() ?? '';
  const task = messages.at(-1)?.getText() ?? '';
  const name = system.match(/You are ([^,]+),/)?.[1] ?? 'member';
  return Promise.resolve(new AIMessage(`[${name}] done → ${task.split('\n')[0]}`));
}

const log = (...parts) => console.log(...parts);

async function runCrewDemo() {
  log('\n━━━ 1. Crew demo (sequential, with guardrail retry) ━━━');
  let reviewAttempts = 0;

  const crew = new agents.Crew({
    process: 'sequential',
    onEvent: (event) => {
      log(`  · event: ${event.type}${event.taskId ? ` (${event.taskId})` : ''}`);
    },
  })
    .addAgent({ id: 'researcher', name: 'Rex', role: 'researcher', goal: 'Gather requirements.' })
    .addAgent({ id: 'coder', name: 'Cara', role: 'coder', goal: 'Implement the feature.' })
    .addAgent({ id: 'reviewer', name: 'Rae', role: 'reviewer', goal: 'Verify the result.' })
    .addTask({
      id: 't1',
      description: 'Read the spec for {feature} and list acceptance criteria.',
      agentId: 'researcher',
    })
    .addTask({
      id: 't2',
      description: 'Implement the feature using the criteria above.',
      agentId: 'coder',
      context: ['t1'],
    })
    .addTask({
      id: 't3',
      description: 'Review the implementation.',
      agentId: 'reviewer',
      context: ['t1', 't2'],
      maxRetries: 1,
      // Guardrail demo: reject the first answer, accept the retry.
      guardrail: () => {
        reviewAttempts += 1;
        return reviewAttempts === 1 ? 'Say the final verdict explicitly.' : true;
      },
    });

  const executor = agents.createReActCrewTaskExecutor({ llmCall: fakeLlmCall });
  const result = await crew.kickoff({
    executor,
    inputs: { feature: 'dark mode' },
  });

  log(`  crew status : ${result.status}`);
  for (const output of result.taskOutputs) {
    log(`  ${output.taskId} (${output.duration}ms, retries=${output.retries}): ${output.output}`);
  }
  log(`  final output: ${result.output}`);
}

async function runGraphDemo() {
  log('\n━━━ 2. Block-graph demo (input → llm_text → output) ━━━');
  const registry = agents.createDefaultBlockRegistry();
  const executor = new agents.GraphExecutor(registry, {
    llmCall: async (messages) => {
      const prompt = messages.at(-1)?.getText() ?? '';
      return new AIMessage(`LLM says: ${prompt.slice(0, 60)}`);
    },
    onEvent: (event) => {
      if (
        event.type === 'node_start' ||
        event.type === 'node_complete' ||
        event.type === 'node_failed'
      ) {
        log(`  · ${event.type}: ${event.nodeId}`);
      }
    },
  });

  const graph = {
    id: 'demo_graph',
    name: 'Feature summary',
    version: 1,
    nodes: [
      { id: 'goal', blockName: 'input' },
      {
        id: 'analyze',
        blockName: 'llm_text',
        inputDefault: { prompt: 'Analyze the goal and list 3 concrete steps.' },
      },
      { id: 'result', blockName: 'output' },
    ],
    links: [
      { source: 'goal', sourceOutput: 'output', sink: 'analyze', sinkInput: 'context' },
      { source: 'analyze', sourceOutput: 'output', sink: 'result', sinkInput: 'value' },
    ],
  };

  const check = agents.validateGraph(graph, registry);
  if (!check.ok) {
    log('  invalid graph:', check.errors.join('; '));
    process.exitCode = 1;
    return;
  }

  const result = await executor.execute(graph, {
    inputs: { goal: 'Ship dark mode' },
    trigger: 'manual',
  });
  log(`  status : ${result.status}`);
  log(`  outputs: ${JSON.stringify(result.outputs)}`);
}

await runCrewDemo();
await runGraphDemo();
log('\n✅ Demo complete.');
