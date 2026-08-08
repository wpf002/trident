import type Database from "better-sqlite3";

// Rift shares Trident's SQLite database so queries can point at the session
// records that produced them. Two hard rules:
//
//   1. Rift READS Trident's tables and never writes them. Every table here is
//      `rift_`-prefixed. `session_runs` is referenced by id only — deliberately
//      NOT a SQL foreign key, so Rift can never block or cascade into a
//      Trident write (§9: Rift never blocks or delays a Trident query).
//   2. Every migration is reversible. `down` must return the database to the
//      exact state before `up` ran.

export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

export const RIFT_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial-capture-and-scoring",
    up: `
      -- One row per studied Trident run.
      CREATE TABLE IF NOT EXISTS rift_queries (
        id                 TEXT PRIMARY KEY,
        session_id         TEXT NOT NULL,          -- session_runs.id (soft ref, not FK)
        domain             TEXT NOT NULL CHECK (domain IN ('RACING','SPORTS','FINANCE','GENERAL')),
        answer_type        TEXT NOT NULL CHECK (answer_type IN ('BOOLEAN','CATEGORICAL','NUMERIC','ORDINAL','OPEN')),
        prompt             TEXT NOT NULL,
        asked_at           TEXT NOT NULL,
        resolves_after     TEXT,
        isolation_verified INTEGER NOT NULL DEFAULT 0,
        -- NULL = in the study set. Non-null = logged but excluded (§3/§5).
        exclusion_reason   TEXT CHECK (exclusion_reason IN
                             ('CHAINED','CONDITIONS_VARIED','UNSTUDYABLE',
                              'INSUFFICIENT_PARTICIPANTS','RESPONSE_ERROR'))
      );

      CREATE INDEX IF NOT EXISTS idx_rift_queries_session  ON rift_queries(session_id);
      CREATE INDEX IF NOT EXISTS idx_rift_queries_domain   ON rift_queries(domain, answer_type);
      -- The study-set scan: isolated, unexcluded, awaiting resolution.
      CREATE INDEX IF NOT EXISTS idx_rift_queries_studyset ON rift_queries(exclusion_reason, isolation_verified, resolves_after);

      CREATE TABLE IF NOT EXISTS rift_model_responses (
        id                 TEXT PRIMARY KEY,
        query_id           TEXT NOT NULL REFERENCES rift_queries(id) ON DELETE CASCADE,
        model              TEXT NOT NULL,
        raw_answer         TEXT NOT NULL,
        parsed_answer      TEXT,                   -- JSON, normalized per answer_type
        stated_confidence  REAL,                   -- each model's OWN report; NULL if not elicited
        latency_ms         INTEGER NOT NULL DEFAULT 0,
        token_cost         INTEGER NOT NULL DEFAULT 0,
        embedding          BLOB,                   -- OPEN answers only
        -- Held-fixed conditions (§3). Recorded per response so the exclusion
        -- rule can actually be evaluated instead of assumed.
        prompt_hash        TEXT NOT NULL DEFAULT '',
        system_prompt_hash TEXT NOT NULL DEFAULT '',
        sampling_params    TEXT NOT NULL DEFAULT '{}',
        UNIQUE (query_id, model)
      );

      CREATE INDEX IF NOT EXISTS idx_rift_responses_query ON rift_model_responses(query_id);

      CREATE TABLE IF NOT EXISTS rift_divergence (
        query_id       TEXT PRIMARY KEY REFERENCES rift_queries(id) ON DELETE CASCADE,
        metric         REAL NOT NULL CHECK (metric >= 0 AND metric <= 1),
        method         TEXT NOT NULL CHECK (method IN
                         ('SHANNON_ENTROPY','MAD_OVER_MEDIAN','KENDALL_W_INV',
                          'EMBEDDING_DISPERSION','JUDGE_SECONDARY')),
        n_participants INTEGER NOT NULL,
        computed_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS rift_resolutions (
        query_id    TEXT PRIMARY KEY REFERENCES rift_queries(id) ON DELETE CASCADE,
        truth       TEXT NOT NULL,                 -- JSON
        source      TEXT NOT NULL,
        resolved_by TEXT NOT NULL CHECK (resolved_by IN ('AUTOMATED','MANUAL')),
        resolved_at TEXT NOT NULL DEFAULT (datetime('now')),
        -- When the truth-determining event OCCURRED (not when we recorded it).
        -- The §3 leakage guard compares this against rift_queries.asked_at.
        event_at    TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rift_resolutions_event ON rift_resolutions(event_at);

      CREATE TABLE IF NOT EXISTS rift_scoring (
        query_id TEXT NOT NULL REFERENCES rift_queries(id) ON DELETE CASCADE,
        model    TEXT NOT NULL,
        correct  INTEGER NOT NULL,
        error    REAL,                             -- NUMERIC/ORDINAL only
        PRIMARY KEY (query_id, model)
      );
    `,
    down: `
      DROP TABLE IF EXISTS rift_scoring;
      DROP TABLE IF EXISTS rift_resolutions;
      DROP TABLE IF EXISTS rift_divergence;
      DROP TABLE IF EXISTS rift_model_responses;
      DROP TABLE IF EXISTS rift_queries;
    `,
  },
  {
    version: 2,
    name: "separate-judge-confidence-from-self-report",
    // Trident's existing confidence number is produced by a separate Claude
    // pass that scores ALL responses — a third-party judge, not each model's
    // self-report. Storing it in `stated_confidence` would silently mislabel
    // the §6 baseline as self-reported confidence and hide the circularity
    // (§4: a model measuring model disagreement). Two columns, honestly named:
    //   stated_confidence — the model's OWN report. NULL unless elicited.
    //   judge_confidence  — Trident's judge pass. Free, but circular; the
    //                       evaluation must label it as such.
    up: `
      ALTER TABLE rift_model_responses ADD COLUMN judge_confidence REAL;
      ALTER TABLE rift_model_responses ADD COLUMN judge_model TEXT;
    `,
    down: `
      ALTER TABLE rift_model_responses DROP COLUMN judge_model;
      ALTER TABLE rift_model_responses DROP COLUMN judge_confidence;
    `,
  },
  {
    version: 3,
    name: "one-query-per-session",
    // Capture runs both live (observer) and as a backlog sweep, and the sweep
    // may race the observer. A unique index makes double-capture impossible at
    // the database level rather than relying on the caller checking first.
    up: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rift_queries_session_unique
        ON rift_queries(session_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_rift_queries_session_unique;
    `,
  },
];

function ensureLedger(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rift_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/** Versions currently applied. */
export function appliedMigrations(db: Database.Database): number[] {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rift_migrations'")
    .get();
  if (!exists) return [];
  return db
    .prepare("SELECT version FROM rift_migrations ORDER BY version")
    .all()
    .map((r) => (r as { version: number }).version);
}

/**
 * Apply pending migrations. Idempotent; each runs in a transaction so a
 * failure leaves no half-built schema. Returns versions actually applied.
 */
export function migrate(db: Database.Database): number[] {
  ensureLedger(db);
  const applied = new Set(appliedMigrations(db));
  const ran: number[] = [];

  for (const m of RIFT_MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.up);
      db.prepare("INSERT INTO rift_migrations (version, name) VALUES (?, ?)").run(m.version, m.name);
    })();
    ran.push(m.version);
  }
  return ran;
}

/**
 * Roll back to `toVersion` (0 = fully reversed), newest first.
 *
 * Phase 0's exit criterion. Reversing drops only `rift_`-prefixed tables —
 * Trident's own tables are never touched by an `up` and so are never touched
 * by a `down`. Returns versions rolled back.
 */
export function rollback(db: Database.Database, toVersion = 0): number[] {
  ensureLedger(db);
  const applied = appliedMigrations(db)
    .filter((v) => v > toVersion)
    .sort((a, b) => b - a); // newest first

  const reversed: number[] = [];
  for (const version of applied) {
    const m = RIFT_MIGRATIONS.find((x) => x.version === version);
    if (!m) throw new Error(`Cannot roll back version ${version}: migration definition missing`);
    db.transaction(() => {
      db.exec(m.down);
      db.prepare("DELETE FROM rift_migrations WHERE version = ?").run(version);
    })();
    reversed.push(version);
  }

  // Fully reversed: remove the ledger too, so `down` leaves zero trace.
  if (toVersion === 0 && appliedMigrations(db).length === 0) {
    db.exec("DROP TABLE IF EXISTS rift_migrations;");
  }
  return reversed;
}
