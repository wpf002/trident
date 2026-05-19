// Typed event vocabulary for the build event log.
// Every state transition, tool call, eval, intervention flows through here.
// UI subscribes via an EventEmitter; the DB layer also persists every event
// to build_events for replay.

import { EventEmitter } from "events";

export type BuildEventKind =
  | "build_started"
  | "plan_generated"
  | "plan_revised"
  | "task_started"
  | "tool_called"
  | "tool_result"
  | "step_evaluated"
  | "task_done"
  | "task_failed"
  | "escalation_triggered"
  | "intervention_requested"
  | "human_action"
  | "build_terminated";

export interface BuildEvent {
  build_id: string;
  task_id: string | null;
  kind: BuildEventKind;
  payload: Record<string, unknown>;
  session_id: string | null;
  created_at: string;
}

export class BuildEventBus {
  private emitter = new EventEmitter();

  emit(event: BuildEvent): void {
    this.emitter.emit("event", event);
    this.emitter.emit(`build:${event.build_id}`, event);
  }

  subscribe(buildId: string, handler: (e: BuildEvent) => void): () => void {
    const channel = `build:${buildId}`;
    this.emitter.on(channel, handler);
    return () => this.emitter.off(channel, handler);
  }

  subscribeAll(handler: (e: BuildEvent) => void): () => void {
    this.emitter.on("event", handler);
    return () => this.emitter.off("event", handler);
  }
}

// Single shared bus per process. The UI server gets its own subscription;
// the loop emits to this bus directly.
export const globalBus = new BuildEventBus();

export function makeEvent(
  buildId: string,
  kind: BuildEventKind,
  payload: Record<string, unknown>,
  opts?: { taskId?: string | null; sessionId?: string | null }
): BuildEvent {
  return {
    build_id: buildId,
    task_id: opts?.taskId ?? null,
    kind,
    payload,
    session_id: opts?.sessionId ?? null,
    created_at: new Date().toISOString(),
  };
}
