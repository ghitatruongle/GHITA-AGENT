// CrewRunner — UI for the CrewAI-style crew engine (packages/agents/src/crew).
// Edits a small crew definition, streams task progress from the sidecar's
// `crew_run` handler, and shows the final integrated output.

import { useMemo, useState } from 'react';
import { Button } from '../ui';
import { useCrewRun } from '../../hooks/useCrewRun';
import type { CrewAgentDraft, CrewTaskDraft, CrewTaskStatus } from '../../hooks/useCrewRun';

const TASK_STATUS_STYLES: Record<CrewTaskStatus, string> = {
  pending: 'bg-slate-700/60 text-slate-300 border-slate-600/50',
  running: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  completed: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  failed: 'bg-rose-500/15 text-rose-300 border-rose-500/40',
};

const inputClass =
  'px-2.5 py-1.5 text-xs rounded-md bg-slate-900/60 border border-white/10 text-slate-50 outline-none focus:border-indigo-500/50 w-full';

let draftCounter = 0;
function nextDraftId(prefix: string): string {
  draftCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${draftCounter}`;
}

export function CrewRunner() {
  const { crewState, runCrew, cancelCrew } = useCrewRun();

  const [process, setProcess] = useState<'sequential' | 'hierarchical'>('sequential');
  const [planning, setPlanning] = useState(false);
  const [goal, setGoal] = useState('');
  const [agents, setAgents] = useState<CrewAgentDraft[]>([
    {
      id: 'member_1',
      name: 'Coder',
      role: 'coder',
      goal: 'Implement the requested change cleanly.',
      backstory: '',
      allowDelegation: false,
    },
    {
      id: 'member_2',
      name: 'Reviewer',
      role: 'reviewer',
      goal: 'Verify correctness and point out risks.',
      backstory: '',
      allowDelegation: false,
    },
  ]);
  const [tasks, setTasks] = useState<CrewTaskDraft[]>([
    { id: 'task_1', description: '', expectedOutput: '', agentId: 'member_1', context: [] },
    { id: 'task_2', description: '', expectedOutput: '', agentId: 'member_2', context: [] },
  ]);

  const running = crewState.status === 'running';
  const canRun = useMemo(
    () =>
      !running &&
      agents.length > 0 &&
      tasks.length > 0 &&
      tasks.every((task) => task.description.trim().length > 0) &&
      agents.every((agent) => agent.name.trim() && agent.role.trim() && agent.goal.trim()),
    [running, agents, tasks],
  );

  const updateAgent = (id: string, patch: Partial<CrewAgentDraft>): void => {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  };
  const updateTask = (id: string, patch: Partial<CrewTaskDraft>): void => {
    setTasks((prev) => prev.map((task) => (task.id === id ? { ...task, ...patch } : task)));
  };

  const handleRun = (): void => {
    if (!canRun) return;
    runCrew({
      process,
      planning,
      agents: agents.map((a) => ({ ...a })),
      tasks: tasks.map((task) => ({
        ...task,
        description: goal.trim()
          ? `${task.description.trim()}\n\n# Overall goal\n${goal.trim()}`
          : task.description.trim(),
      })),
      permissionMode: 'custom',
    });
  };

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-white/5 bg-slate-800/40 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="m-0 text-sm font-bold tracking-wide text-indigo-200">
            👥 Crew orchestration
          </h3>
          <p className="m-0 text-[11px] text-slate-400">
            Multi-agent team run (design ported from CrewAI, MIT). Sequential routes each task to
            its member; hierarchical lets a manager delegate.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {running ? (
            <Button size="sm" variant="danger" onClick={cancelCrew}>
              ⏹ Cancel
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            className="text-indigo-300 bg-indigo-500/10 border-indigo-500/30"
            disabled={!canRun}
            onClick={handleRun}
          >
            {running ? '⏳ Running…' : '▶ Run crew'}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-300">
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="crew-process"
            checked={process === 'sequential'}
            onChange={() => setProcess('sequential')}
          />
          Sequential
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="crew-process"
            checked={process === 'hierarchical'}
            onChange={() => setProcess('hierarchical')}
          />
          Hierarchical (manager delegates)
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={planning} onChange={(e) => setPlanning(e.target.checked)} />
          Plan before run
        </label>
        {crewState.delegations > 0 ? (
          <span className="text-indigo-300">🔗 Delegations: {crewState.delegations}</span>
        ) : null}
      </div>

      <input
        className={inputClass}
        placeholder="Overall goal (optional context for every task)"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        disabled={running}
      />

      {/* Agents */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Members ({agents.length})
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={running}
            onClick={() =>
              setAgents((prev) => [
                ...prev,
                {
                  id: nextDraftId('member'),
                  name: '',
                  role: '',
                  goal: '',
                  backstory: '',
                  allowDelegation: false,
                },
              ])
            }
          >
            + Add member
          </Button>
        </div>
        {agents.map((agent) => (
          <div key={agent.id} className="grid grid-cols-[1fr_1fr_2fr_auto] gap-2 items-center">
            <input
              className={inputClass}
              placeholder="Name"
              value={agent.name}
              disabled={running}
              onChange={(e) => updateAgent(agent.id, { name: e.target.value })}
            />
            <input
              className={inputClass}
              placeholder="Role"
              value={agent.role}
              disabled={running}
              onChange={(e) => updateAgent(agent.id, { role: e.target.value })}
            />
            <input
              className={inputClass}
              placeholder="Goal"
              value={agent.goal}
              disabled={running}
              onChange={(e) => updateAgent(agent.id, { goal: e.target.value })}
            />
            <Button
              size="sm"
              variant="danger"
              disabled={running || agents.length <= 1}
              onClick={() => {
                setAgents((prev) => prev.filter((a) => a.id !== agent.id));
                setTasks((prev) =>
                  prev.map((task) =>
                    task.agentId === agent.id ? { ...task, agentId: '' } : task,
                  ),
                );
              }}
            >
              ✕
            </Button>
          </div>
        ))}
      </div>

      {/* Tasks */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Tasks ({tasks.length})
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={running}
            onClick={() =>
              setTasks((prev) => [
                ...prev,
                {
                  id: nextDraftId('task'),
                  description: '',
                  expectedOutput: '',
                  agentId: agents[0]?.id ?? '',
                  context: [],
                },
              ])
            }
          >
            + Add task
          </Button>
        </div>
        {tasks.map((task, index) => (
          <div key={task.id} className="grid grid-cols-[2fr_1fr_1fr_auto_auto] gap-2 items-center">
            <input
              className={inputClass}
              placeholder={`Task ${index + 1} description`}
              value={task.description}
              disabled={running}
              onChange={(e) => updateTask(task.id, { description: e.target.value })}
            />
            <input
              className={inputClass}
              placeholder="Expected output"
              value={task.expectedOutput}
              disabled={running}
              onChange={(e) => updateTask(task.id, { expectedOutput: e.target.value })}
            />
            <select
              className={inputClass}
              value={task.agentId}
              disabled={running}
              onChange={(e) => updateTask(task.id, { agentId: e.target.value })}
            >
              <option value="">auto</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name || agent.id}
                </option>
              ))}
            </select>
            <span
              className={`rounded border px-2 py-1 text-[10px] font-semibold ${
                TASK_STATUS_STYLES[crewState.taskStatuses[task.id] ?? 'pending']
              }`}
            >
              {crewState.taskStatuses[task.id] ?? 'pending'}
            </span>
            <Button
              size="sm"
              variant="danger"
              disabled={running || tasks.length <= 1}
              onClick={() => setTasks((prev) => prev.filter((item) => item.id !== task.id))}
            >
              ✕
            </Button>
          </div>
        ))}
      </div>

      {/* Result */}
      {crewState.error ? (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          ❌ {crewState.error}
        </div>
      ) : null}
      {crewState.output ? (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-slate-400">Crew output</span>
          <pre className="m-0 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/5 bg-[#090d16] p-3 text-[11px] text-emerald-300">
            {crewState.output}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
