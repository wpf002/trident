import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { captureBacklog, captureEnabled } from "./capture.js";

// Rift is an experiment that may be rejected in Phase 6. Shipping it to
// production without an off switch would make it un-killable without a deploy.
// These tests pin the switch's exact semantics.

const original = process.env.RIFT_CAPTURE;
afterEach(() => {
  if (original === undefined) delete process.env.RIFT_CAPTURE;
  else process.env.RIFT_CAPTURE = original;
});

function tridentDb() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE session_runs (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL, prompt TEXT NOT NULL, project TEXT,
      ais TEXT NOT NULL, responses TEXT, duration_ms INTEGER NOT NULL DEFAULT 0,
      preset TEXT, system_prompt TEXT, metadata TEXT,
      started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return d;
}

const riftTables = (d: Database.Database) =>
  (d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'rift_%'").all() as {
    name: string;
  }[]).map((r) => r.name);

describe("capture kill switch", () => {
  it("is ON by default — sample size is the study's binding constraint", () => {
    delete process.env.RIFT_CAPTURE;
    expect(captureEnabled()).toBe(true);
  });

  it("stays ON for an empty or whitespace value", () => {
    process.env.RIFT_CAPTURE = "";
    expect(captureEnabled()).toBe(true);
    process.env.RIFT_CAPTURE = "   ";
    expect(captureEnabled()).toBe(true);
  });

  it("turns OFF for every documented falsey spelling", () => {
    for (const v of ["0", "false", "off", "no", "FALSE", "Off", "NO"]) {
      process.env.RIFT_CAPTURE = v;
      expect(captureEnabled(), `RIFT_CAPTURE=${v}`).toBe(false);
    }
  });

  it("stays ON for truthy spellings", () => {
    for (const v of ["1", "true", "on", "yes"]) {
      process.env.RIFT_CAPTURE = v;
      expect(captureEnabled(), `RIFT_CAPTURE=${v}`).toBe(true);
    }
  });

  it("gates the automatic path — core checks it before ever touching rift", () => {
    // core's logSessionRun calls captureEnabled() first and returns early, so
    // a database that never had capture enabled never acquires rift_ tables.
    // The end-to-end behaviour is exercised by the CLI integration check.
    process.env.RIFT_CAPTURE = "0";
    expect(captureEnabled()).toBe(false);
    process.env.RIFT_CAPTURE = "1";
    expect(captureEnabled()).toBe(true);
  });

  it("explicit operator actions still work when the switch is off", () => {
    // The switch gates AUTOMATIC capture. If you deliberately run
    // `trident rift backfill`, you mean it.
    process.env.RIFT_CAPTURE = "0";
    const d = tridentDb();
    d.prepare(
      `INSERT INTO session_runs (id, mode, prompt, ais, responses, started_at, finished_at)
       VALUES ('s1','parallel','q','["claude"]','[]','2026-03-01T12:00:00Z','2026-03-01T12:00:05Z')`
    ).run();

    const res = captureBacklog(d);
    expect(res.captured).toBe(1);
    expect(riftTables(d)).toContain("rift_queries");
  });
});
