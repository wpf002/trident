import chalk from "chalk";
import { getDb, captureBacklog, migrate, STUDY_POLICY, captureEnabled } from "@trident/core";

// Reports what's been captured. Nothing here computes a divergence metric or
// changes how Trident answers anything.

interface CountRow {
  k: string | null;
  c: number;
}

export function riftStatus() {
  const db = getDb();
  migrate(db);

  const one = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;

  const sessions = one("SELECT COUNT(*) c FROM session_runs");
  const captured = one("SELECT COUNT(*) c FROM rift_queries");
  const uncaptured = one(
    "SELECT COUNT(*) c FROM session_runs s LEFT JOIN rift_queries q ON q.session_id = s.id WHERE q.id IS NULL"
  );
  const studySet = one("SELECT COUNT(*) c FROM rift_queries WHERE exclusion_reason IS NULL");
  const resolved = one(
    "SELECT COUNT(*) c FROM rift_queries q JOIN rift_resolutions r ON r.query_id = q.id WHERE q.exclusion_reason IS NULL"
  );
  const responses = one("SELECT COUNT(*) c FROM rift_model_responses");

  console.log("\n" + chalk.bold.white("  Rift — capture status") + chalk.gray("  (Phase 1: capture only)\n"));
  console.log(`  ${chalk.gray("Trident sessions".padEnd(24))} ${sessions}`);
  console.log(`  ${chalk.gray("Captured".padEnd(24))} ${captured}`);
  if (uncaptured > 0) {
    console.log(`  ${chalk.yellow("Not yet captured".padEnd(24))} ${chalk.yellow(String(uncaptured))} ${chalk.gray("→ run: trident rift backfill")}`);
  }
  console.log(`  ${chalk.gray("Model responses".padEnd(24))} ${responses}`);
  console.log(`  ${chalk.bold("In study set".padEnd(24))} ${chalk.bold(String(studySet))}`);
  console.log(`  ${chalk.gray("…of those, resolved".padEnd(24))} ${resolved}`);

  const excluded = db
    .prepare(
      "SELECT exclusion_reason k, COUNT(*) c FROM rift_queries WHERE exclusion_reason IS NOT NULL GROUP BY exclusion_reason ORDER BY c DESC"
    )
    .all() as CountRow[];
  if (excluded.length) {
    console.log("\n  " + chalk.bold.white("Excluded") + chalk.gray("  (logged, never silently dropped)"));
    for (const e of excluded) console.log(`  ${chalk.gray((e.k ?? "?").padEnd(28))} ${e.c}`);
  }

  const byDomain = db
    .prepare(
      "SELECT domain k, COUNT(*) c FROM rift_queries WHERE exclusion_reason IS NULL GROUP BY domain ORDER BY c DESC"
    )
    .all() as CountRow[];
  if (byDomain.length) {
    console.log("\n  " + chalk.bold.white("Study set by domain") + chalk.gray(`  (need ${150} per domain to claim)`));
    for (const d of byDomain) {
      const enough = d.c >= 150 ? chalk.green("✓") : chalk.gray("·");
      console.log(`  ${enough} ${chalk.gray((d.k ?? "?").padEnd(26))} ${d.c}`);
    }
  }

  // Progress against the preregistered pooled minimum.
  const POOLED_MIN = 500;
  const pct = Math.min(100, Math.round((resolved / POOLED_MIN) * 100));
  console.log(
    "\n  " +
      chalk.bold.white("Toward first report") +
      chalk.gray(`  (preregistered n≥${POOLED_MIN} resolved)`)
  );
  console.log(`  ${resolved}/${POOLED_MIN}  ${chalk.gray(`${pct}%`)}`);
  if (resolved < POOLED_MIN) {
    console.log(chalk.gray(`  No claim may be made below ${POOLED_MIN}. See docs/rift-hypothesis.md`));
  }

  console.log(
    chalk.gray(
      `\n  Policy: min ${STUDY_POLICY.MIN_PARTICIPANTS} participants, prefer ${STUDY_POLICY.PREFERRED_PARTICIPANTS}. ` +
        `OPEN divergence ${STUDY_POLICY.OPEN_DIVERGENCE_ENABLED ? "enabled" : "disabled (costs embeddings)"}. ` +
        `Capture ${captureEnabled() ? "ON" : "OFF (RIFT_CAPTURE)"}.\n`
    )
  );
}

export function riftBackfill(opts: { limit?: string }) {
  const db = getDb();
  const limit = opts.limit ? Number.parseInt(opts.limit, 10) : 1000;

  console.log(chalk.gray(`\n  Sweeping up to ${limit} uncaptured sessions…`));
  const res = captureBacklog(db, limit);

  console.log("\n" + chalk.green.bold("  Backfill complete"));
  console.log(`  ${chalk.gray("scanned".padEnd(20))} ${res.scanned}`);
  console.log(`  ${chalk.gray("captured".padEnd(20))} ${res.captured}`);
  if (res.alreadyCaptured) console.log(`  ${chalk.gray("already captured".padEnd(20))} ${res.alreadyCaptured}`);
  console.log("");
}
