import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../../../data");
const DB_PATH = path.join(DATA_DIR, "trident.db");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let _db: Database.Database | null = null;
export function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL DEFAULT 'global',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      source TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, key)
    );
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
  `);
  return _db;
}

export interface MemoryEntry {
  project: string;
  key: string;
  value: string;
  source: string | null;
  updated_at: string;
  created_at: string;
}

export function listMemory(project?: string): MemoryEntry[] {
  const db = getDb();
  const rows = project
    ? db.prepare(
        "SELECT project, key, value, source, updated_at, created_at FROM memory WHERE project = ? ORDER BY updated_at DESC"
      ).all(project)
    : db.prepare(
        "SELECT project, key, value, source, updated_at, created_at FROM memory ORDER BY project, updated_at DESC"
      ).all();
  return rows as MemoryEntry[];
}

export function getMemory(project: string, key: string): MemoryEntry | null {
  const db = getDb();
  const row = db
    .prepare("SELECT project, key, value, source, updated_at, created_at FROM memory WHERE project = ? AND key = ?")
    .get(project, key) as MemoryEntry | undefined;
  return row ?? null;
}

export function upsertMemory(project: string, key: string, value: string, source = "ui"): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO memory (project, key, value, source, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project, key) DO UPDATE SET
      value = excluded.value,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(project, key, value, source);
}

export function deleteMemory(project: string, key: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM memory WHERE project = ? AND key = ?").run(project, key);
  return result.changes > 0;
}

export function listProjects(): Array<{ project: string; count: number }> {
  const db = getDb();
  return db
    .prepare("SELECT project, COUNT(*) as count FROM memory GROUP BY project ORDER BY project")
    .all() as Array<{ project: string; count: number }>;
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

export interface SessionRun {
  id: string;
  mode: "parallel" | "chain";
  prompt: string;
  project: string | null;
  ais: string[];
  responses: Array<{
    ai: string;
    content: string;
    error?: string;
    duration_ms: number;
    started_at: string;
    finished_at: string;
  }>;
  duration_ms: number;
  preset: string | null;
  system_prompt: string | null;
  metadata: Record<string, unknown> | null;
  started_at: string;
  finished_at: string;
  created_at: string;
}

function parseRow(row: SessionRunRow): SessionRun {
  return {
    id: row.id,
    mode: row.mode as "parallel" | "chain",
    prompt: row.prompt,
    project: row.project,
    ais: JSON.parse(row.ais) as string[],
    responses: JSON.parse(row.responses) as SessionRun["responses"],
    duration_ms: row.duration_ms,
    preset: row.preset,
    system_prompt: row.system_prompt,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
  };
}

export function listSessions(limit = 100): SessionRun[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM session_runs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as SessionRunRow[];
  return rows.map(parseRow);
}

export function getSession(id: string): SessionRun | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM session_runs WHERE id = ?").get(id) as SessionRunRow | undefined;
  return row ? parseRow(row) : null;
}

export function insertSession(run: Omit<SessionRun, "created_at"> & { created_at?: string }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO session_runs
      (id, mode, prompt, project, ais, responses, duration_ms, preset, system_prompt, metadata, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id,
    run.mode,
    run.prompt,
    run.project,
    JSON.stringify(run.ais),
    JSON.stringify(run.responses),
    run.duration_ms,
    run.preset,
    run.system_prompt,
    run.metadata ? JSON.stringify(run.metadata) : null,
    run.started_at,
    run.finished_at
  );
}
