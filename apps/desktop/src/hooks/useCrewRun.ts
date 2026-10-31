// useCrewRun — desktop-side bridge for the sidecar `crew_run` handler
// (CrewAI-style multi-agent orchestration). Streams replayable crew events
// into component state and exposes run/cancel actions.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { getSharedSocket } from '../utils/sharedSocket';

export interface CrewAgentDraft {
  id: string;
  name: string;
  role: string;
  goal: string;
  backstory: string;
  allowDelegation: boolean;
}

export interface CrewTaskDraft {
  id: string;
  description: string;
  expectedOutput: string;
  agentId: string;
  context: string[];
}

export type CrewEventPayload = {
  runId: string;
  event:
    | { type: 'crew_start'; crewId: string; process: string; taskCount: number; timestamp: number }
    | { type: 'plan_created'; steps: Array<{ taskId: string; plan: string }>; timestamp: number }
    | { type: 'task_start'; taskId: string; agentId?: string; timestamp: number }
    | { type: 'task_guardrail_retry'; taskId: string; attempt: number; reason: string; timestamp: number }
    | { type: 'task_complete'; taskId: string; agentId?: string; output: string; duration: number; timestamp: number }
    | { type: 'task_failed'; taskId: string; agentId?: string; error: string; timestamp: number }
    | { type: 'delegation'; fromAgentId?: string; toAgentId: string; kind: 'work' | 'question'; timestamp: number }
    | { type: 'crew_complete'; crewId: string; status: 'completed' | 'failed'; output: string; duration: number; timestamp: number };
};

export type CrewTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface CrewRunState {
  runId: string | null;
  status: 'idle' | 'running' | 'completed' | 'failed';
  /** True once the sidecar accepted the run (crew_start received). */
  sawStart: boolean;
  taskStatuses: Record<string, CrewTaskStatus>;
  delegations: number;
  output: string;
  error: string | null;
  events: CrewEventPayload['event'][];
}

const INITIAL_STATE: CrewRunState = {
  runId: null,
  status: 'idle',
  sawStart: false,
  taskStatuses: {},
  delegations: 0,
  output: '',
  error: null,
  events: [],
};

const MAX_TRACKED_EVENTS = 100;

export function useCrewRun() {
  const [state, setState] = useState<CrewRunState>(INITIAL_STATE);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    let active = true;
    const tracked: Array<[string, (...args: never[]) => void]> = [];
    void (async () => {
      const socket = await getSharedSocket();
      if (!active || !socket) return;
      socketRef.current = socket;

      const addTracked = (ev: string, handler: (...args: never[]) => void): void => {
        socket.on(ev, handler as never);
        tracked.push([ev, handler]);
      };

      addTracked('crew_event', (payload: CrewEventPayload) => {
        if (!active) return;
        setState((prev) => {
          const event = payload.event;
          const next: CrewRunState = {
            ...prev,
            runId: payload.runId,
            events: [...prev.events, event].slice(-MAX_TRACKED_EVENTS),
          };
          switch (event.type) {
            case 'crew_start':
              next.status = 'running';
              next.sawStart = true;
              break;
            case 'task_start':
              next.taskStatuses = { ...prev.taskStatuses, [event.taskId]: 'running' };
              break;
            case 'task_complete':
              next.taskStatuses = { ...prev.taskStatuses, [event.taskId]: 'completed' };
              break;
            case 'task_failed':
              next.taskStatuses = { ...prev.taskStatuses, [event.taskId]: 'failed' };
              break;
            case 'delegation':
              next.delegations = prev.delegations + 1;
              break;
            case 'crew_complete':
              next.status = event.status;
              next.output = event.output;
              break;
            default:
              break;
          }
          return next;
        });
      });

      addTracked(
        'crew_done',
        (payload: {
          runId: string;
          status: 'completed' | 'failed';
          output?: string;
          error?: string;
        }) => {
          if (!active) return;
          setState((prev) => ({
            ...prev,
            runId: payload.runId,
            status: payload.status,
            output: payload.output ?? prev.output,
            error: payload.error ?? null,
          }));
        },
      );

      // Pre-run rejections (another run active, unauthorized, invalid
      // payload) emit only `chat_error` — without this the optimistic
      // 'running' state would stick forever.
      addTracked('chat_error', (payload: { message?: string }) => {
        if (!active) return;
        setState((prev) => {
          if (prev.status !== 'running' || prev.sawStart) return prev;
          return { ...prev, status: 'failed', error: payload.message ?? 'Run was rejected.' };
        });
      });
    })();
    return () => {
      active = false;
      const socket = socketRef.current;
      if (socket) {
        for (const [ev, handler] of tracked) socket.off(ev, handler as never);
      }
    };
  }, []);

  const runCrew = useCallback(
    (payload: {
      process: 'sequential' | 'hierarchical';
      planning: boolean;
      agents: CrewAgentDraft[];
      tasks: CrewTaskDraft[];
      inputs?: Record<string, unknown>;
      permissionMode?: string;
    }) => {
      const socket = socketRef.current;
      if (!socket) return;
      setState({ ...INITIAL_STATE, status: 'running' });
      socket.emit('crew_run', payload);
    },
    [],
  );

  const cancelCrew = useCallback(() => {
    socketRef.current?.emit('crew_cancel');
  }, []);

  return { crewState: state, runCrew, cancelCrew };
}
