import type Database from "better-sqlite3";

// Spine shares the existing Trident SQLite database so claims sit alongside the
// session replay they cite. Two rules this file must never break:
//
//   1. It only ever creates `spine_*` tables. `session_runs` (and anything else
//      already in the file) is never altered, renamed, or dropped.
//   2. Every migration is idempotent and gated on `spine_migrations`, so
//      running against an existing populated DB is safe and repeatable.

export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const SPINE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial-claims-questions-conflicts",
    up: `
      CREATE TABLE IF NOT EXISTS spine_claims (
        id             TEXT PRIMARY KEY,
        statement      TEXT NOT NULL,
        canonical_form TEXT NOT NULL,
        scope          TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'open',
        locked         INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        superseded_by  TEXT REFERENCES spine_claims(id)
      );

      -- The conflict check reads on (scope, canonical_form); make it cheap.
      CREATE INDEX IF NOT EXISTS idx_spine_claims_scope_key
        ON spine_claims(scope, canonical_form);
      CREATE INDEX IF NOT EXISTS idx_spine_claims_status
        ON spine_claims(status);

      -- Exactly one provenance row per claim.
      CREATE TABLE IF NOT EXISTS spine_provenance (
        claim_id         TEXT PRIMARY KEY REFERENCES spine_claims(id) ON DELETE CASCADE,
        session_id       TEXT NOT NULL,
        models_consulted TEXT NOT NULL DEFAULT '[]',
        verdict          TEXT,
        confidence       INTEGER,
        raw_response_ref TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_spine_provenance_session
        ON spine_provenance(session_id);

      CREATE TABLE IF NOT EXISTS spine_questions (
        id          TEXT PRIMARY KEY,
        statement   TEXT NOT NULL,
        scope       TEXT NOT NULL,
        opened_at   TEXT NOT NULL DEFAULT (datetime('now')),
        resolves_to TEXT REFERENCES spine_claims(id)
      );

      CREATE INDEX IF NOT EXISTS idx_spine_questions_scope
        ON spine_questions(scope);
      CREATE INDEX IF NOT EXISTS idx_spine_questions_open
        ON spine_questions(resolves_to);

      -- A conflict is a RECORD, not a resolution. Both sides are kept.
      CREATE TABLE IF NOT EXISTS spine_conflicts (
        id          TEXT PRIMARY KEY,
        claim_a     TEXT NOT NULL REFERENCES spine_claims(id),
        claim_b     TEXT NOT NULL REFERENCES spine_claims(id),
        scope       TEXT NOT NULL,
        reason      TEXT NOT NULL,
        detected_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_spine_conflicts_claims
        ON spine_conflicts(claim_a, claim_b);

      -- Relation vocabulary is closed: supersedes | conflicts_with | answers.
      -- Columns are generic ids, not claim ids: 'answers' points a claim at a
      -- question, the other two point claim -> claim.
      CREATE TABLE IF NOT EXISTS spine_relations (
        from_id    TEXT NOT NULL,
        to_id      TEXT NOT NULL,
        type       TEXT NOT NULL CHECK (type IN ('supersedes','conflicts_with','answers')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (from_id, to_id, type)
      );

      CREATE INDEX IF NOT EXISTS idx_spine_relations_from ON spine_relations(from_id);
      CREATE INDEX IF NOT EXISTS idx_spine_relations_to   ON spine_relations(to_id);
    `,
  },
];

/**
 * Apply any spine migrations this database hasn't seen yet.
 *
 * Safe to call on every open: already-applied versions are skipped, and each
 * migration runs in a transaction so a failure leaves no half-built schema.
 * Returns the versions actually applied.
 */
export function migrate(db: Database.Database): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS spine_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare("SELECT version FROM spine_migrations").all().map((r) => (r as { version: number }).version)
  );

  const ran: number[] = [];
  for (const m of SPINE_MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const tx = db.transaction(() => {
      db.exec(m.up);
      db.prepare("INSERT INTO spine_migrations (version, name) VALUES (?, ?)").run(m.version, m.name);
    });
    tx();
    ran.push(m.version);
  }
  return ran;
}

/** Versions currently applied to this database. */
export function appliedMigrations(db: Database.Database): number[] {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='spine_migrations'")
    .get();
  if (!exists) return [];
  return db
    .prepare("SELECT version FROM spine_migrations ORDER BY version")
    .all()
    .map((r) => (r as { version: number }).version);
}
