// Public API for the Trident Builder package. The CLI and ui-server consume
// these — they never reach into the internals.

export {
  DEFAULT_CONFIG,
  type BuilderConfig,
  type BuilderTier,
  type BuilderCeilings,
  type BuilderEscalation,
  type BuilderLoopDetector,
  type BuildRow,
  type BuildStatus,
  type BuildSummary,
  type CreateBuildOptions,
  type PlanNode,
  type PlanTree,
  type StepEvaluation,
  type TaskRow,
  type TaskStatus,
  type Verification,
  type SpecDigest,
} from "./types.js";

export { globalBus, type BuildEvent, type BuildEventKind } from "./events.js";

export {
  getBuild,
  listBuilds,
  listTasksForBuild,
  listEvents,
  updateBuildStatus,
  type PersistedBuildEvent,
} from "./db.js";

export { createAndRunBuild, runBuildLoop } from "./loop.js";

export {
  attachWorkspace,
  createWorkspace,
  destroyWorkspace,
  prepareSourceRepo,
  defaultSourceRepo,
  defaultBaseBranch,
  dataDir,
} from "./state.js";

// Convenience helpers consumed by the CLI and ui-server.
import {
  getBuild as _getBuild,
  listTasksForBuild as _listTasks,
  updateBuildStatus as _updateBuildStatus,
} from "./db.js";
import type { BuildSummary } from "./types.js";

export function summarizeBuild(buildId: string): BuildSummary | null {
  const b = _getBuild(buildId);
  if (!b) return null;
  const tasks = _listTasks(buildId);
  const done = tasks.filter((t) => t.status === "done").length;
  return {
    id: b.id,
    spec_path: b.spec_path,
    source_repo: b.source_repo,
    status: b.status,
    cost_usd: b.cost_usd,
    tasks_total: tasks.length,
    tasks_done: done,
    started_at: b.started_at,
    finished_at: b.finished_at,
  };
}

export function abortBuild(buildId: string): boolean {
  const b = _getBuild(buildId);
  if (!b) return false;
  if (b.status === "done" || b.status === "aborted" || b.status === "failed") {
    return false;
  }
  // The loop checks build status before each step — flipping to aborted
  // causes a graceful stop on the next boundary.
  _updateBuildStatus(buildId, "aborted", new Date().toISOString());
  return true;
}

export function pauseBuild(buildId: string): boolean {
  const b = _getBuild(buildId);
  if (!b) return false;
  if (b.status !== "running" && b.status !== "planning") return false;
  _updateBuildStatus(buildId, "paused");
  return true;
}

export function resumeBuild(buildId: string): boolean {
  const b = _getBuild(buildId);
  if (!b) return false;
  if (b.status !== "paused") return false;
  _updateBuildStatus(buildId, "running");
  return true;
}
