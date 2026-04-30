import Database, { Database as DatabaseInstance } from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../../../data");
const DB_PATH = path.join(DATA_DIR, "trident.db");

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db: DatabaseInstance = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");

// Schema
db.exec(`
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

// ─── Session Runs ─────────────────────────────────────────────────────────────

export interface SessionRunResponse {
  ai: string;
  content: string;
  error?: string;
  duration_ms: number;
  started_at: string;
  finished_at: string;
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

export function logSessionRun(run: SessionRunInput): void {
  const stmt = db.prepare(`
    INSERT INTO session_runs
      (id, mode, prompt, project, ais, responses, duration_ms, preset, system_prompt, metadata, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
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

interface SessionRunRow {
  id: string;
  mode: string;
  prompt: string;
  project: string | null;
  ais: string;
  responses: string;
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
    responses: JSON.parse(row.responses) as SessionRunResponse[],
    duration_ms: row.duration_ms,
    preset: row.preset,
    system_prompt: row.system_prompt,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
  };
}

export function listSessionRuns(options: {
  limit?: number;
  mode?: "parallel" | "chain";
  project?: string;
} = {}): SessionRunRecord[] {
  const limit = options.limit ?? 50;
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.mode) {
    clauses.push("mode = ?");
    params.push(options.mode);
  }
  if (options.project) {
    clauses.push("project = ?");
    params.push(options.project);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const stmt = db.prepare(
    `SELECT * FROM session_runs ${where} ORDER BY created_at DESC LIMIT ?`
  );
  const rows = stmt.all(...params, limit) as SessionRunRow[];
  return rows.map(parseRow);
}

export function getSessionRun(id: string): SessionRunRecord | null {
  const stmt = db.prepare("SELECT * FROM session_runs WHERE id = ?");
  const row = stmt.get(id) as SessionRunRow | undefined;
  if (!row) return null;
  return parseRow(row);
}

export default db;
