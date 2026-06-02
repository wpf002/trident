import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// Single source of truth for the shared session_runs store. Every package
// (cli, ui-server, scheduler) goes through this module so the schema, indexes,
// and connection pragmas can never drift.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.TRIDENT_DATA_DIR
  ? path.resolve(process.env.TRIDENT_DATA_DIR)
  : path.resolve(__dirname, "../../../data");
const DB_PATH = path.join(DATA_DIR, "trident.db");

let _db: Database.Database | null = null;

/** Lazily open (once) the shared SQLite connection. */
export function getDb(): Database.Database {
  if (_db) return _db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  // Wait up to 5s for a lock instead of throwing SQLITE_BUSY immediately —
  // multiple processes (CLI, UI server, scheduler daemon) share this file.
  _db.pragma("busy_timeout = 5000");
  _db.exec(`
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
  `);
  return _db;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionRunResponse {
  ai: string;
  content: string;
  error?: string;
  duration_ms: number;
  started_at: string;
  finished_at: string;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface SessionRunRecord {
  id: string;
  mode: "parallel" | "chain";
  prompt: string;
  project: string | null;
  ais: string[];
  responses: SessionRunResponse[];
  duration_ms: number;
  preset: string | null;
  system_prompt: string | null;
  metadata: Record<string, unknown> | null;
  started_at: string;
  finished_at: string;
  created_at: string;
}

export interface SessionRunInput {
  id: string;
  mode: "parallel" | "chain";
  prompt: string;
  project?: string | null;
  ais: string[];
  responses: SessionRunResponse[];
  duration_ms: number;
  preset?: string | null;
  system_prompt?: string | null;
  metadata?: Record<string, unknown> | null;
  started_at: string;
  finished_at: string;
}

interface SessionRunRow {
  id: string;
  mode: string;
  prompt: string;
  project: string | null;
  ais: string;
  responses: string | null;
  duration_ms: number;
  preset: string | null;
  system_prompt: string | null;
  metadata: string | null;
  started_at: string;
  finished_at: string;
  created_at: string;
}

function parseRow(row: SessionRunRow): SessionRunRecord {
  return {
    id: row.id,
    mode: row.mode as "parallel" | "chain",
    prompt: row.prompt,
    project: row.project,
    ais: JSON.parse(row.ais) as string[],
    responses: row.responses ? (JSON.parse(row.responses) as SessionRunResponse[]) : [],
    duration_ms: row.duration_ms,
    preset: row.preset,
    system_prompt: row.system_prompt,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
  };
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export function logSessionRun(run: SessionRunInput): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO session_runs
      (id, mode, prompt, project, ais, responses, duration_ms, preset, system_prompt, metadata, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id,
    run.mode,
    run.prompt,
    run.project ?? null,
    JSON.stringify(run.ais),
    JSON.stringify(run.responses),
    run.duration_ms,
    run.preset ?? null,
    run.system_prompt ?? null,
    run.metadata ? JSON.stringify(run.metadata) : null,
    run.started_at,
    run.finished_at
  );
}

export function clearSessionRuns(): number {
  return getDb().prepare("DELETE FROM session_runs").run().changes;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

interface ListOptions {
  limit?: number;
  mode?: "parallel" | "chain";
}

function whereClause(mode?: "parallel" | "chain"): { sql: string; params: unknown[] } {
  if (mode) return { sql: "WHERE mode = ?", params: [mode] };
  return { sql: "", params: [] };
}

/** Full records, including response bodies. Use when the caller needs content. */
export function listSessionRuns(options: ListOptions = {}): SessionRunRecord[] {
  const db = getDb();
  const { sql, params } = whereClause(options.mode);
  const rows = db
    .prepare(`SELECT * FROM session_runs ${sql} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, options.limit ?? 50) as SessionRunRow[];
  return rows.map(parseRow);
}

/**
 * Lightweight list for index/history views — omits the large `responses` and
 * `metadata` JSON blobs (returned as [] / null). Use when only the row header
 * is rendered, to avoid shipping every response body over the wire.
 */
export function listSessionSummaries(options: ListOptions = {}): SessionRunRecord[] {
  const db = getDb();
  const { sql, params } = whereClause(options.mode);
  const rows = db
    .prepare(
      `SELECT id, mode, prompt, project, ais, duration_ms, preset, system_prompt, started_at, finished_at, created_at
       FROM session_runs ${sql} ORDER BY created_at DESC LIMIT ?`
    )
    .all(...params, options.limit ?? 50) as SessionRunRow[];
  return rows.map(parseRow);
}

export function getSessionRun(id: string): SessionRunRecord | null {
  const row = getDb().prepare("SELECT * FROM session_runs WHERE id = ?").get(id) as
    | SessionRunRow
    | undefined;
  return row ? parseRow(row) : null;
}
