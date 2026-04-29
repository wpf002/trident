import Database from "better-sqlite3";
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

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");

// Schema
db.exec(`
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

  CREATE TABLE IF NOT EXISTS session_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    ai TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(project);
  CREATE INDEX IF NOT EXISTS idx_memory_key ON memory(key);
  CREATE INDEX IF NOT EXISTS idx_session_log_session ON session_log(session_id);
`);

export function memoryWrite(
  key: string,
  value: string,
  project = "global",
  source?: string
): void {
  const stmt = db.prepare(`
    INSERT INTO memory (project, key, value, source, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project, key) DO UPDATE SET
      value = excluded.value,
      source = excluded.source,
      updated_at = excluded.updated_at
  `);
  stmt.run(project, key, value, source ?? null);
}

export function memoryRead(
  key: string,
  project = "global"
): { key: string; value: string; source?: string; updated_at: string } | null {
  const stmt = db.prepare(
    "SELECT key, value, source, updated_at FROM memory WHERE project = ? AND key = ?"
  );
  return stmt.get(project, key) as {
    key: string;
    value: string;
    source?: string;
    updated_at: string;
  } | null;
}

export function memoryList(project?: string): Array<{
  project: string;
  key: string;
  value: string;
  source?: string;
  updated_at: string;
}> {
  if (project) {
    const stmt = db.prepare(
      "SELECT project, key, value, source, updated_at FROM memory WHERE project = ? ORDER BY updated_at DESC"
    );
    return stmt.all(project) as Array<{
      project: string;
      key: string;
      value: string;
      source?: string;
      updated_at: string;
    }>;
  }
  const stmt = db.prepare(
    "SELECT project, key, value, source, updated_at FROM memory ORDER BY project, updated_at DESC"
  );
  return stmt.all() as Array<{
    project: string;
    key: string;
    value: string;
    source?: string;
    updated_at: string;
  }>;
}

export function memoryDelete(key: string, project = "global"): boolean {
  const stmt = db.prepare(
    "DELETE FROM memory WHERE project = ? AND key = ?"
  );
  const result = stmt.run(project, key);
  return result.changes > 0;
}

export function logSession(
  sessionId: string,
  ai: string,
  role: "user" | "assistant",
  content: string
): void {
  const stmt = db.prepare(`
    INSERT INTO session_log (session_id, ai, role, content)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(sessionId, ai, role, content);
}

export function getProjects(): string[] {
  const stmt = db.prepare(
    "SELECT DISTINCT project FROM memory ORDER BY project"
  );
  const rows = stmt.all() as Array<{ project: string }>;
  return rows.map((r) => r.project);
}

export default db;
