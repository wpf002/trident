import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { appliedMigrations, migrate } from "./schema.js";
import { createSpine } from "./spine.js";
import type { Provenance } from "./types.js";

const prov = (): Provenance => ({
  session_id: "sesn_test",
  models_consulted: ["claude"],
  verdict: null,
  confidence: null,
  raw_response_ref: null,
});

/** Stand-in for the real session replay table spine has to coexist with. */
function withExistingSessionRuns(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE session_runs (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL, prompt TEXT NOT NULL,
      responses TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_session_runs_mode ON session_runs(mode);
  `);
  db.prepare("INSERT INTO session_runs (id, mode, prompt, responses) VALUES (?,?,?,?)").run(
    "sesn_existing",
    "chain",
    "pre-existing run",
    "[]"
  );
  return db;
}

describe("migration", () => {
  it("does not clobber existing session replay data", () => {
    const db = withExistingSessionRuns();
    migrate(db);

    const row = db.prepare("SELECT * FROM session_runs WHERE id = ?").get("sesn_existing") as {
      prompt: string;
    };
    expect(row.prompt).toBe("pre-existing run");
    expect(db.prepare("SELECT COUNT(*) c FROM session_runs").get()).toEqual({ c: 1 });

    // The pre-existing index survives too.
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_session_runs_mode'")
      .get();
    expect(idx).toBeTruthy();
  });

  it("only adds spine_-prefixed tables", () => {
    const db = withExistingSessionRuns();
    const before = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);

    migrate(db);

    const after = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    const added = after.filter((n) => !before.includes(n));

    expect(added.length).toBeGreaterThan(0);
    for (const t of added) expect(t.startsWith("spine_")).toBe(true);
  });

  it("is idempotent — re-running applies nothing and preserves data", () => {
    const db = withExistingSessionRuns();
    expect(migrate(db)).toEqual([1]);
    expect(migrate(db)).toEqual([]); // second run is a no-op
    expect(migrate(db)).toEqual([]);
    expect(appliedMigrations(db)).toEqual([1]);
  });

  it("survives a spine round-trip on a DB that already had session data", () => {
    const db = withExistingSessionRuns();
    const spine = createSpine(db);
    const res = spine.assert({
      statement: "claims can cite existing sessions",
      canonical_form: "spine.coexists",
      scope: "trident",
      provenance: { ...prov(), session_id: "sesn_existing" },
    });

    expect(spine.getClaim(res.claim.id)!.provenance.session_id).toBe("sesn_existing");
    expect(db.prepare("SELECT COUNT(*) c FROM session_runs").get()).toEqual({ c: 1 });
  });

  it("reports no applied migrations on a virgin database", () => {
    expect(appliedMigrations(new Database(":memory:"))).toEqual([]);
  });
});

describe("questions", () => {
  it("stores open questions as first-class rows, not absent answers", () => {
    const spine = createSpine(new Database(":memory:"));
    const q = spine.ask({ statement: "Do refresh tokens rotate?", scope: "trident" });

    expect(q.resolves_to).toBeNull();
    expect(spine.openQuestions("trident")).toHaveLength(1);
  });

  it("resolve() links the question to a claim and records an answers relation", () => {
    const spine = createSpine(new Database(":memory:"));
    const q = spine.ask({ statement: "Do refresh tokens rotate?", scope: "trident" });
    const c = spine.assert({
      statement: "Refresh tokens rotate on every use",
      canonical_form: "auth.refresh.rotation",
      scope: "trident",
      provenance: prov(),
    });

    const resolved = spine.resolve(q.id, c.claim.id);
    expect(resolved.resolves_to).toBe(c.claim.id);
    expect(spine.openQuestions("trident")).toHaveLength(0);

    const hist = spine.history(c.claim.id);
    expect(hist.answers.map((a) => a.id)).toContain(q.id);
    expect(hist.relations.some((r) => r.type === "answers" && r.to_id === q.id)).toBe(true);
  });

  it("scopes questions independently", () => {
    const spine = createSpine(new Database(":memory:"));
    spine.ask({ statement: "q1", scope: "project-a" });
    spine.ask({ statement: "q2", scope: "project-b" });

    expect(spine.openQuestions("project-a")).toHaveLength(1);
    expect(spine.openQuestions()).toHaveLength(2);
  });
});

describe("history", () => {
  it("returns the supersede lineage oldest-first", () => {
    const spine = createSpine(new Database(":memory:"));
    const v1 = spine.assert({
      statement: "Cap is 3",
      canonical_form: "http.retry.cap",
      scope: "trident",
      provenance: prov(),
    });
    const v2 = spine.assert({
      statement: "Cap is 5",
      canonical_form: "http.retry.cap",
      scope: "trident",
      provenance: prov(),
      supersedes: v1.claim.id,
    });
    const v3 = spine.assert({
      statement: "Cap is 10",
      canonical_form: "http.retry.cap",
      scope: "trident",
      provenance: prov(),
      supersedes: v2.claim.id,
    });

    const hist = spine.history(v3.claim.id);
    expect(hist.lineage.map((c) => c.statement)).toEqual(["Cap is 3", "Cap is 5", "Cap is 10"]);
    expect(spine.getClaim(v1.claim.id)!.status).toBe("superseded");
    expect(spine.getClaim(v1.claim.id)!.superseded_by).toBe(v2.claim.id);
  });

  it("carries provenance through to the stored claim", () => {
    const spine = createSpine(new Database(":memory:"));
    const res = spine.assert({
      statement: "Cap is 3",
      canonical_form: "http.retry.cap",
      scope: "trident",
      provenance: {
        session_id: "sesn_x",
        models_consulted: ["claude", "gpt", "gemini"],
        verdict: "mostly agree",
        confidence: 78,
        raw_response_ref: "session_runs:sesn_x#2",
      },
    });

    const p = spine.getClaim(res.claim.id)!.provenance;
    expect(p.session_id).toBe("sesn_x");
    expect(p.models_consulted).toEqual(["claude", "gpt", "gemini"]);
    expect(p.verdict).toBe("mostly agree");
    expect(p.confidence).toBe(78);
    expect(p.raw_response_ref).toBe("session_runs:sesn_x#2");
  });
});
