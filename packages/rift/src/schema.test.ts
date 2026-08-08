import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { appliedMigrations, migrate, rollback } from "./schema.js";

// Phase 0 exit criterion: the migration applies and reverses clean, against a
// database that already holds Trident's session replay.

/** Stand-in for Trident's existing tables. Rift must never touch these. */
function tridentDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE session_runs (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL, prompt TEXT NOT NULL,
      responses TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_session_runs_mode ON session_runs(mode);
  `);
  db.prepare("INSERT INTO session_runs (id, mode, prompt, responses) VALUES (?,?,?,?)").run(
    "sesn_1",
    "parallel",
    "who wins race 4",
    "[]"
  );
  return db;
}

const snapshot = (db: Database.Database) =>
  (
    db
      .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
      .all() as { type: string; name: string; sql: string }[]
  ).map((r) => `${r.type}:${r.name}:${r.sql ?? ""}`);

describe("migration — applies", () => {
  it("creates every rift table", () => {
    const db = tridentDb();
    expect(migrate(db)).toEqual([1]);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'rift_%'").all() as {
        name: string;
      }[]
    ).map((r) => r.name).sort();

    expect(tables).toEqual([
      "rift_divergence",
      "rift_migrations",
      "rift_model_responses",
      "rift_queries",
      "rift_resolutions",
      "rift_scoring",
    ]);
  });

  it("is idempotent", () => {
    const db = tridentDb();
    expect(migrate(db)).toEqual([1]);
    expect(migrate(db)).toEqual([]);
    expect(appliedMigrations(db)).toEqual([1]);
  });

  it("only adds rift_-prefixed objects", () => {
    const db = tridentDb();
    const before = snapshot(db).map((s) => s.split(":")[1]);
    migrate(db);
    const added = snapshot(db)
      .map((s) => s.split(":")[1])
      .filter((n) => !before.includes(n));

    expect(added.length).toBeGreaterThan(0);
    for (const name of added) {
      // Rift's own tables/indexes, plus the internal indexes SQLite creates
      // for rift's PRIMARY KEY / UNIQUE constraints. Nothing else may appear.
      const isRift =
        name.startsWith("rift_") || name.startsWith("idx_rift_") || name.startsWith("sqlite_autoindex_rift_");
      expect(isRift, `unexpected object added: ${name}`).toBe(true);
    }
  });
});

describe("migration — reverses clean", () => {
  it("restores the database byte-for-byte to its pre-migration schema", () => {
    const db = tridentDb();
    const before = snapshot(db);

    migrate(db);
    expect(snapshot(db)).not.toEqual(before);

    rollback(db, 0);
    // Every rift object gone, including the migrations ledger — zero trace.
    expect(snapshot(db)).toEqual(before);
  });

  it("leaves Trident's data and indexes untouched through a full up/down cycle", () => {
    const db = tridentDb();
    migrate(db);
    rollback(db, 0);

    expect(db.prepare("SELECT COUNT(*) c FROM session_runs").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT prompt FROM session_runs WHERE id='sesn_1'").get()).toEqual({
      prompt: "who wins race 4",
    });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_session_runs_mode'").get()
    ).toBeTruthy();
  });

  it("can re-apply after a rollback", () => {
    const db = tridentDb();
    migrate(db);
    rollback(db, 0);
    expect(appliedMigrations(db)).toEqual([]);
    expect(migrate(db)).toEqual([1]); // clean re-apply
  });

  it("rolling back an unmigrated database is a no-op", () => {
    const db = tridentDb();
    const before = snapshot(db);
    expect(rollback(db, 0)).toEqual([]);
    expect(snapshot(db)).toEqual(before);
  });
});

describe("schema constraints encode the methodology", () => {
  it("rejects a divergence metric outside 0-1", () => {
    const db = tridentDb();
    migrate(db);
    db.prepare(
      `INSERT INTO rift_queries (id, session_id, domain, answer_type, prompt, asked_at)
       VALUES ('q1','sesn_1','RACING','BOOLEAN','p','2026-01-01T00:00:00Z')`
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO rift_divergence (query_id, metric, method, n_participants)
           VALUES ('q1', 1.5, 'SHANNON_ENTROPY', 3)`
        )
        .run()
    ).toThrow();
  });

  it("rejects an unknown divergence method", () => {
    const db = tridentDb();
    migrate(db);
    db.prepare(
      `INSERT INTO rift_queries (id, session_id, domain, answer_type, prompt, asked_at)
       VALUES ('q1','sesn_1','RACING','BOOLEAN','p','2026-01-01T00:00:00Z')`
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO rift_divergence (query_id, metric, method, n_participants)
           VALUES ('q1', 0.5, 'VIBES', 3)`
        )
        .run()
    ).toThrow();
  });

  it("requires event_at on a resolution so the leakage guard is computable", () => {
    const db = tridentDb();
    migrate(db);
    db.prepare(
      `INSERT INTO rift_queries (id, session_id, domain, answer_type, prompt, asked_at)
       VALUES ('q1','sesn_1','RACING','BOOLEAN','p','2026-01-01T00:00:00Z')`
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO rift_resolutions (query_id, truth, source, resolved_by)
           VALUES ('q1','true','feed','AUTOMATED')`
        )
        .run()
    ).toThrow(); // event_at is NOT NULL — a resolution without it cannot be recorded
  });

  it("allows only one response per model per query", () => {
    const db = tridentDb();
    migrate(db);
    db.prepare(
      `INSERT INTO rift_queries (id, session_id, domain, answer_type, prompt, asked_at)
       VALUES ('q1','sesn_1','RACING','BOOLEAN','p','2026-01-01T00:00:00Z')`
    ).run();
    const ins = db.prepare(
      `INSERT INTO rift_model_responses (id, query_id, model, raw_answer) VALUES (?,?,?,?)`
    );
    ins.run("r1", "q1", "claude", "yes");
    expect(() => ins.run("r2", "q1", "claude", "no")).toThrow();
  });
});
