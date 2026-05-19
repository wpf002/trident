// Builder's SQLite layer. Shares data/trident.db with mcp-server's
// session_runs table — the schema below uses CREATE IF NOT EXISTS so both
// can initialize independently.

import Database, { Database as DatabaseInstance } from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import type {
  BuildRow,
  BuildStatus,
  BuilderConfig,
  PlanTree,
  SpecDigest,
  StepEvaluation,
  TaskRow,
  TaskStatus,
  Verification,
} from "./types.js";
import type { BuildEvent } from "./events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../../data");
const DB_PATH = path.join(DATA_DIR, "trident.db");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db: DatabaseInstance = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  -- mcp-server also creates this; idempotent.
  CREATE TABLE IF NOT EXISTS session_runs (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    prompt TEXT NOT NULL,
    project TEXT,
    ais TEXT NOT NULL,
    responses TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    preset TEXT,
    system_prompt TEXT,
    metadata TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_session_runs_mode ON session_runs(mode);
  CREATE INDEX IF NOT EXISTS idx_session_runs_created ON session_runs(created_at);

  CREATE TABLE IF NOT EXISTS builds (
    id              TEXT PRIMARY KEY,
    spec_path       TEXT NOT NULL,
    spec_digest     TEXT,
    source_repo     TEXT NOT NULL,
    base_branch     TEXT NOT NULL,
    builder_branch  TEXT NOT NULL,
    workspace_path  TEXT NOT NULL,
    status          TEXT NOT NULL,
    current_step_id TEXT,
    plan_tree       TEXT,
    cost_usd        REAL NOT NULL DEFAULT 0,
    config          TEXT,
    metadata        TEXT,
    started_at      TEXT NOT NULL,
    finished_at     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_builds_status ON builds(status);
  CREATE INDEX IF NOT EXISTS idx_builds_created ON builds(created_at);

  CREATE TABLE IF NOT EXISTS build_tasks (
    id               TEXT PRIMARY KEY,
    build_id         TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
    parent_id        TEXT REFERENCES build_tasks(id),
    kind             TEXT NOT NULL,
    ordinal          INTEGER NOT NULL,
    intent           TEXT NOT NULL,
    expected_files   TEXT,
    verification     TEXT,
    status           TEXT NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL DEFAULT 3,
    last_evaluation  TEXT,
    snapshot_before  TEXT,
    started_at       TEXT,
    finished_at      TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_build_tasks_build  ON build_tasks(build_id);
  CREATE INDEX IF NOT EXISTS idx_build_tasks_parent ON build_tasks(parent_id);
  CREATE INDEX IF NOT EXISTS idx_build_tasks_status ON build_tasks(status);

  CREATE TABLE IF NOT EXISTS build_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    build_id    TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
    task_id     TEXT REFERENCES build_tasks(id),
    kind        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    session_id  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_build_events_build ON build_events(build_id, id);
  CREATE INDEX IF NOT EXISTS idx_build_events_kind  ON build_events(kind);
`);

export default db;

// ─── builds CRUD ──────────────────────────────────────────────────────────

interface BuildRowDb {
  id: string;
  spec_path: string;
  spec_digest: string | null;
  source_repo: string;
  base_branch: string;
  builder_branch: string;
  workspace_path: string;
  status: string;
  current_step_id: string | null;
  plan_tree: string | null;
  cost_usd: number;
  config: string | null;
  metadata: string | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
}

function parseBuild(row: BuildRowDb): BuildRow {
  return {
    id: row.id,
    spec_path: row.spec_path,
    spec_digest: row.spec_digest ? (JSON.parse(row.spec_digest) as SpecDigest) : null,
    source_repo: row.source_repo,
    base_branch: row.base_branch,
    builder_branch: row.builder_branch,
    workspace_path: row.workspace_path,
    status: row.status as BuildStatus,
    current_step_id: row.current_step_id,
    plan_tree: row.plan_tree ? (JSON.parse(row.plan_tree) as PlanTree) : null,
    cost_usd: row.cost_usd,
    config: row.config ? (JSON.parse(row.config) as BuilderConfig) : (null as never),
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
  };
}

export interface InsertBuildInput {
  id: string;
  spec_path: string;
  source_repo: string;
  base_branch: string;
  builder_branch: string;
  workspace_path: string;
  status: BuildStatus;
  config: BuilderConfig;
  metadata?: Record<string, unknown>;
  started_at: string;
}

export function insertBuild(input: InsertBuildInput): void {
  db.prepare(
    `INSERT INTO builds
      (id, spec_path, source_repo, base_branch, builder_branch, workspace_path,
       status, config, metadata, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.spec_path,
    input.source_repo,
    input.base_branch,
    input.builder_branch,
    input.workspace_path,
    input.status,
    JSON.stringify(input.config),
    input.metadata ? JSON.stringify(input.metadata) : null,
    input.started_at
  );
}

export function getBuild(id: string): BuildRow | null {
  const row = db.prepare("SELECT * FROM builds WHERE id = ?").get(id) as BuildRowDb | undefined;
  return row ? parseBuild(row) : null;
}

export function listBuilds(limit = 50): BuildRow[] {
  const rows = db
    .prepare("SELECT * FROM builds ORDER BY created_at DESC LIMIT ?")
    .all(limit) as BuildRowDb[];
  return rows.map(parseBuild);
}

export function updateBuildStatus(
  id: string,
  status: BuildStatus,
  finishedAt?: string
): void {
  if (finishedAt) {
    db.prepare("UPDATE builds SET status = ?, finished_at = ? WHERE id = ?").run(
      status,
      finishedAt,
      id
    );
  } else {
    db.prepare("UPDATE builds SET status = ? WHERE id = ?").run(status, id);
  }
}

export function setBuildPlanTree(id: string, tree: PlanTree): void {
  db.prepare("UPDATE builds SET plan_tree = ? WHERE id = ?").run(
    JSON.stringify(tree),
    id
  );
}

export function setBuildSpecDigest(id: string, digest: SpecDigest): void {
  db.prepare("UPDATE builds SET spec_digest = ? WHERE id = ?").run(
    JSON.stringify(digest),
    id
  );
}

export function setBuildCurrentStep(id: string, stepId: string | null): void {
  db.prepare("UPDATE builds SET current_step_id = ? WHERE id = ?").run(stepId, id);
}

export function bumpBuildCost(id: string, deltaUsd: number): number {
  const r = db
    .prepare(
      "UPDATE builds SET cost_usd = cost_usd + ? WHERE id = ? RETURNING cost_usd"
    )
    .get(deltaUsd, id) as { cost_usd: number } | undefined;
  return r?.cost_usd ?? 0;
}

// ─── tasks CRUD ───────────────────────────────────────────────────────────

interface TaskRowDb {
  id: string;
  build_id: string;
  parent_id: string | null;
  kind: string;
  ordinal: number;
  intent: string;
  expected_files: string | null;
  verification: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  last_evaluation: string | null;
  snapshot_before: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

function parseTask(row: TaskRowDb): TaskRow {
  return {
    id: row.id,
    build_id: row.build_id,
    parent_id: row.parent_id,
    kind: row.kind as TaskRow["kind"],
    ordinal: row.ordinal,
    intent: row.intent,
    expected_files: row.expected_files ? (JSON.parse(row.expected_files) as string[]) : [],
    verification: row.verification
      ? (JSON.parse(row.verification) as Verification)
      : null,
    status: row.status as TaskStatus,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    last_evaluation: row.last_evaluation
      ? (JSON.parse(row.last_evaluation) as StepEvaluation)
      : null,
    snapshot_before: row.snapshot_before,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
  };
}

export interface InsertTaskInput {
  id: string;
  build_id: string;
  parent_id: string | null;
  kind: TaskRow["kind"];
  ordinal: number;
  intent: string;
  expected_files: string[];
  verification: Verification | null;
  status: TaskStatus;
  max_attempts: number;
}

export function insertTask(input: InsertTaskInput): void {
  db.prepare(
    `INSERT INTO build_tasks
      (id, build_id, parent_id, kind, ordinal, intent, expected_files, verification, status, max_attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.build_id,
    input.parent_id,
    input.kind,
    input.ordinal,
    input.intent,
    JSON.stringify(input.expected_files),
    input.verification ? JSON.stringify(input.verification) : null,
    input.status,
    input.max_attempts
  );
}

export function listTasksForBuild(buildId: string): TaskRow[] {
  const rows = db
    .prepare("SELECT * FROM build_tasks WHERE build_id = ? ORDER BY ordinal")
    .all(buildId) as TaskRowDb[];
  return rows.map(parseTask);
}

export function getTask(id: string): TaskRow | null {
  const row = db
    .prepare("SELECT * FROM build_tasks WHERE id = ?")
    .get(id) as TaskRowDb | undefined;
  return row ? parseTask(row) : null;
}

export function updateTaskStatus(
  id: string,
  status: TaskStatus,
  opts?: { startedAt?: string; finishedAt?: string }
): void {
  const sets: string[] = ["status = ?"];
  const params: unknown[] = [status];
  if (opts?.startedAt) {
    sets.push("started_at = ?");
    params.push(opts.startedAt);
  }
  if (opts?.finishedAt) {
    sets.push("finished_at = ?");
    params.push(opts.finishedAt);
  }
  params.push(id);
  db.prepare(`UPDATE build_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export function bumpTaskAttempts(id: string): number {
  const r = db
    .prepare(
      "UPDATE build_tasks SET attempts = attempts + 1 WHERE id = ? RETURNING attempts"
    )
    .get(id) as { attempts: number } | undefined;
  return r?.attempts ?? 0;
}

export function setTaskEvaluation(id: string, evaluation: StepEvaluation): void {
  db.prepare("UPDATE build_tasks SET last_evaluation = ? WHERE id = ?").run(
    JSON.stringify(evaluation),
    id
  );
}

export function setTaskSnapshot(id: string, snapshotId: string): void {
  db.prepare("UPDATE build_tasks SET snapshot_before = ? WHERE id = ?").run(
    snapshotId,
    id
  );
}

// ─── events ───────────────────────────────────────────────────────────────

export function insertEvent(event: BuildEvent): number {
  const r = db
    .prepare(
      `INSERT INTO build_events (build_id, task_id, kind, payload, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      event.build_id,
      event.task_id,
      event.kind,
      JSON.stringify(event.payload),
      event.session_id,
      event.created_at
    );
  return r.lastInsertRowid as number;
}

interface EventRowDb {
  id: number;
  build_id: string;
  task_id: string | null;
  kind: string;
  payload: string;
  session_id: string | null;
  created_at: string;
}

export interface PersistedBuildEvent extends BuildEvent {
  id: number;
}

export function listEvents(
  buildId: string,
  opts: { afterId?: number; limit?: number } = {}
): PersistedBuildEvent[] {
  const limit = Math.min(opts.limit ?? 500, 2000);
  const after = opts.afterId ?? 0;
  const rows = db
    .prepare(
      `SELECT * FROM build_events
       WHERE build_id = ? AND id > ?
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(buildId, after, limit) as EventRowDb[];
  return rows.map((r) => ({
    id: r.id,
    build_id: r.build_id,
    task_id: r.task_id,
    kind: r.kind as BuildEvent["kind"],
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    session_id: r.session_id,
    created_at: r.created_at,
  }));
}

// ─── session_runs (for builder LLM call tracking) ─────────────────────────

export interface LogSessionInput {
  id: string;
  build_id: string;
  step_id: string | null;
  phase: string;
  ai: string;
  model: string;
  prompt: string;
  response: string;
  duration_ms: number;
  started_at: string;
  finished_at: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
}

export function logBuilderSessionRun(input: LogSessionInput): void {
  const responses = [
    {
      ai: input.ai,
      content: input.response,
      error: input.error,
      duration_ms: input.duration_ms,
      started_at: input.started_at,
      finished_at: input.finished_at,
    },
  ];
  const metadata = {
    builder: {
      build_id: input.build_id,
      step_id: input.step_id,
      phase: input.phase,
      model: input.model,
      usage: input.usage,
    },
  };
  db.prepare(
    `INSERT INTO session_runs
      (id, mode, prompt, project, ais, responses, duration_ms, metadata, started_at, finished_at)
     VALUES (?, 'parallel', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.prompt,
    input.build_id,
    JSON.stringify([input.ai]),
    JSON.stringify(responses),
    input.duration_ms,
    JSON.stringify(metadata),
    input.started_at,
    input.finished_at
  );
}
