// useWorkflowRun — desktop-side bridge for the sidecar `workflow_run`
// handler (AutoGPT-style block graph execution). Tracks per-node statuses
// from the streamed events and drives the human-in-the-loop round trip.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { getSharedSocket } from '../utils/sharedSocket';

export interface WorkflowGraphPayload {
  id: string;
  name: string;
  version: number;
  nodes: Array<{
    id: string;
    blockName: string;
    inputDefault?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }>;
  links: Array<{
    source: string;
    sourceOutput: string;
    sink: string;
    sinkInput: string;
    isStatic?: boolean;
  }>;
}

export type WorkflowNodeStatus = 'waiting' | 'running' | 'completed' | 'failed' | 'skipped';

export interface WorkflowRunState {
  runId: string | null;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'terminated' | 'incomplete';
  /** True once the sidecar accepted the run (execution_start received). */
  sawStart: boolean;
  nodeStatuses: Record<string, WorkflowNodeStatus>;
  outputs: Record<string, unknown>;
  error: string | null;
  pendingInput: { ticket: string; nodeId: string; prompt: string } | null;
}

const INITIAL_STATE: WorkflowRunState = {
  runId: null,
  status: 'idle',
  sawStart: false,
  nodeStatuses: {},
  outputs: {},
  error: null,
  pendingInput: null,
};

interface WorkflowEventPayload {
  runId: string;
  event:
    | { type: 'execution_start'; executionId: string; timestamp: number }
    | { type: 'node_start'; nodeId: string; timestamp: number }
    | { type: 'node_output'; nodeId: string; outputName: string; value: unknown; timestamp: number }
    | { type: 'node_complete'; nodeId: string; timestamp: number }
    | { type: 'node_failed'; nodeId: string; error: string; timestamp: number }
    | { type: 'node_skipped'; nodeId: string; reason: string; timestamp: number }
    | { type: 'execution_complete'; executionId: string; status: string; timestamp: number };
}

export function useWorkflowRun() {
  const [state, setState] = useState<WorkflowRunState>(INITIAL_STATE);
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

      addTracked('workflow_event', (payload: WorkflowEventPayload) => {
        if (!active) return;
        setState((prev) => {
          const event = payload.event;
          const next: WorkflowRunState = { ...prev, runId: payload.runId };
          switch (event.type) {
            case 'execution_start':
              next.status = 'running';
              next.sawStart = true;
              break;
            case 'node_start':
              next.nodeStatuses = { ...prev.nodeStatuses, [event.nodeId]: 'running' };
              break;
            case 'node_complete':
              next.nodeStatuses = { ...prev.nodeStatuses, [event.nodeId]: 'completed' };
              break;
            case 'node_failed':
              next.nodeStatuses = { ...prev.nodeStatuses, [event.nodeId]: 'failed' };
              // A failed node with a pending question can never be answered.
              if (prev.pendingInput?.nodeId === event.nodeId) {
                next.pendingInput = null;
              }
              break;
            case 'node_skipped':
              next.nodeStatuses = { ...prev.nodeStatuses, [event.nodeId]: 'skipped' };
              break;
            case 'execution_complete':
              next.status = event.status as WorkflowRunState['status'];
              break;
            default:
              return prev;
          }
          return next;
        });
      });

      addTracked(
        'workflow_done',
        (payload: {
          runId: string;
          status: WorkflowRunState['status'];
          outputs?: Record<string, unknown>;
          error?: string;
        }) => {
          if (!active) return;
          setState((prev) => ({
            ...prev,
            runId: payload.runId,
            status: payload.status,
            outputs: payload.outputs ?? prev.outputs,
            error: payload.error ?? null,
            // No answer can arrive after the run ended — never leave the
            // human-input modal hanging over a finished run.
            pendingInput: null,
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

      addTracked(
        'workflow_human_input_required',
        (payload: { runId: string; ticket: string; nodeId: string; prompt: string }) => {
          if (!active) return;
          setState((prev) => ({
            ...prev,
            pendingInput: { ticket: payload.ticket, nodeId: payload.nodeId, prompt: payload.prompt },
          }));
        },
      );
    })();
    return () => {
      active = false;
      const socket = socketRef.current;
      if (socket) {
        for (const [ev, handler] of tracked) socket.off(ev, handler as never);
      }
    };
  }, []);

  const runWorkflow = useCallback(
    (payload: { graph: WorkflowGraphPayload; inputs?: Record<string, unknown>; permissionMode?: string }) => {
      const socket = socketRef.current;
      if (!socket) return;
      setState({ ...INITIAL_STATE, status: 'running' });
      socket.emit('workflow_run', payload);
    },
    [],
  );

  const cancelWorkflow = useCallback(() => {
    socketRef.current?.emit('workflow_cancel');
  }, []);

  const submitHumanInput = useCallback((ticket: string, answer: string) => {
    socketRef.current?.emit('workflow_human_input_response', { ticket, answer });
    setState((prev) => ({ ...prev, pendingInput: null }));
  }, []);

  return { workflowState: state, runWorkflow, cancelWorkflow, submitHumanInput };
}
