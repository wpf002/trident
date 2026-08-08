import chalk from "chalk";
import { createSpine, InvariantViolationError, type Claim, type Conflict } from "@trident/spine";

// CLI surface over @trident/spine. Deliberately thin: the spine reports
// conflicts, it never resolves them, and neither does this.

const DEFAULT_SCOPE = "trident";

function statusColor(status: Claim["status"]): string {
  switch (status) {
    case "held":
      return chalk.green(status);
    case "superseded":
      return chalk.gray(status);
    case "refuted":
      return chalk.red(status);
    default:
      return chalk.white(status);
  }
}

function printClaim(c: Claim, indent = "  ") {
  const lock = c.locked ? chalk.yellow(" [locked]") : "";
  console.log(`${indent}${chalk.bold.white(c.id)}  ${statusColor(c.status)}${lock}`);
  console.log(`${indent}${c.statement}`);
  console.log(
    `${indent}${chalk.gray("key:")} ${chalk.cyan(c.canonical_form)}  ${chalk.gray("scope:")} ${c.scope}`
  );
  const p = c.provenance;
  const models = p.models_consulted.length ? p.models_consulted.join(", ") : "—";
  const conf = p.confidence != null ? `${p.confidence}/100` : "—";
  console.log(
    `${indent}${chalk.gray(`session: ${p.session_id || "—"} • models: ${models} • verdict: ${p.verdict ?? "—"} • confidence: ${conf}`)}`
  );
}

function printConflicts(conflicts: Conflict[], spine: ReturnType<typeof createSpine>) {
  console.log(
    "\n" + chalk.yellow.bold(`  ⚠ ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} recorded`)
  );
  console.log(chalk.gray("  Spine does not resolve these — both claims stay live.\n"));
  for (const c of conflicts) {
    const other = spine.getClaim(c.claim_a);
    console.log(`  ${chalk.bold(c.id)}  ${chalk.gray(c.detected_at)}`);
    console.log(`  ${chalk.gray("reason:")} ${c.reason}`);
    if (other) console.log(`  ${chalk.gray("existing:")} ${other.id} — "${other.statement}"`);
    console.log("");
  }
}

export function spineAssert(
  statement: string,
  opts: {
    key?: string;
    scope?: string;
    session?: string;
    models?: string;
    verdict?: string;
    confidence?: string;
    ref?: string;
    supersedes?: string;
  }
) {
  const spine = createSpine();
  const scope = opts.scope ?? DEFAULT_SCOPE;

  try {
    const { claim, conflicts } = spine.assert({
      statement,
      canonical_form: opts.key,
      scope,
      supersedes: opts.supersedes,
      provenance: {
        session_id: opts.session ?? "cli",
        models_consulted: opts.models ? opts.models.split(",").map((s) => s.trim()).filter(Boolean) : [],
        verdict: opts.verdict ?? null,
        confidence: opts.confidence != null ? Number.parseInt(opts.confidence, 10) : null,
        raw_response_ref: opts.ref ?? null,
      },
    });

    console.log("\n" + chalk.green.bold("  Claim asserted"));
    printClaim(claim);
    if (!opts.key) {
      console.log(
        chalk.gray(
          `\n  Note: no --key given, so the conflict key was derived from the statement.\n` +
            `  Competing claims won't be detected without a shared --key.`
        )
      );
    }
    if (conflicts.length) printConflicts(conflicts, spine);
    console.log("");
  } catch (err) {
    if (err instanceof InvariantViolationError) {
      console.error("\n" + chalk.red.bold("  ✖ Invariant violation — nothing was written"));
      console.error(`  ${err.message}\n`);
      console.error(chalk.gray(`  Existing invariant:`));
      printClaim(err.invariant, "  ");
      console.error(chalk.gray(`\n  To change it: trident spine unlock ${err.invariant.id}\n`));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

export function spineLock(claimId: string) {
  const spine = createSpine();
  const claim = spine.lock(claimId);
  console.log("\n" + chalk.yellow.bold("  Claim locked as an invariant"));
  printClaim(claim);
  console.log(chalk.gray("\n  Conflicting writes against this will now raise instead of merging.\n"));
}

export function spineUnlock(claimId: string) {
  const spine = createSpine();
  const claim = spine.unlock(claimId);
  console.log("\n" + chalk.bold("  Claim unlocked"));
  printClaim(claim);
  console.log("");
}

export function spineCheck(statement: string, opts: { key?: string; scope?: string }) {
  const spine = createSpine();
  const scope = opts.scope ?? DEFAULT_SCOPE;
  const { conflicts } = spine.check({ statement, canonical_form: opts.key, scope });

  if (conflicts.length === 0) {
    console.log("\n" + chalk.green("  No conflicts.") + chalk.gray(" Nothing was written.\n"));
    return;
  }

  console.log(
    "\n" +
      chalk.yellow.bold(`  ⚠ Would conflict with ${conflicts.length} existing claim${conflicts.length === 1 ? "" : "s"}`)
  );
  console.log(chalk.gray("  Dry run — nothing was written.\n"));
  for (const c of conflicts) {
    if (c.locked) console.log("  " + chalk.red.bold("LOCKED INVARIANT — an assert would raise"));
    printClaim(c.claim);
    console.log(`  ${chalk.gray("reason:")} ${c.reason}\n`);
  }
}

export function spineAsk(statement: string, opts: { scope?: string }) {
  const spine = createSpine();
  const q = spine.ask({ statement, scope: opts.scope ?? DEFAULT_SCOPE });
  console.log("\n" + chalk.cyan.bold("  Question opened"));
  console.log(`  ${chalk.bold.white(q.id)}  ${chalk.gray(q.opened_at)}`);
  console.log(`  ${q.statement}`);
  console.log(`  ${chalk.gray("scope:")} ${q.scope}  ${chalk.gray("status:")} ${chalk.yellow("open")}\n`);
}

export function spineResolve(questionId: string, claimId: string) {
  const spine = createSpine();
  const q = spine.resolve(questionId, claimId);
  console.log("\n" + chalk.green.bold("  Question resolved"));
  console.log(`  ${q.statement}`);
  console.log(`  ${chalk.gray("answered by:")} ${claimId}\n`);
}

export function spineList(opts: { scope?: string; questions?: boolean; conflicts?: boolean }) {
  const spine = createSpine();

  if (opts.conflicts) {
    const conflicts = spine.conflicts(opts.scope);
    if (!conflicts.length) {
      console.log(chalk.gray("\n  No conflicts recorded.\n"));
      return;
    }
    console.log("\n" + chalk.bold.white(`  Conflicts (${conflicts.length})`) + chalk.gray("  — unresolved by design\n"));
    for (const c of conflicts) {
      console.log(`  ${chalk.bold(c.id)}  ${chalk.gray(c.scope)}  ${chalk.gray(c.detected_at)}`);
      console.log(`  ${c.reason}\n`);
    }
    return;
  }

  if (opts.questions) {
    const qs = spine.openQuestions(opts.scope);
    if (!qs.length) {
      console.log(chalk.gray("\n  No open questions.\n"));
      return;
    }
    console.log("\n" + chalk.bold.white(`  Open questions (${qs.length})\n`));
    for (const q of qs) {
      console.log(`  ${chalk.bold.white(q.id)}  ${chalk.gray(q.scope)}`);
      console.log(`  ${q.statement}\n`);
    }
    return;
  }

  const claims = spine.listClaims(opts.scope);
  if (!claims.length) {
    console.log(chalk.gray("\n  No claims yet.\n"));
    return;
  }
  console.log("\n" + chalk.bold.white(`  Claims (${claims.length})\n`));
  for (const c of claims) {
    printClaim(c);
    console.log("");
  }
}

export function spineHistory(claimId: string) {
  const spine = createSpine();
  const h = spine.history(claimId);

  console.log("\n" + chalk.bold.white("  Claim"));
  printClaim(h.claim);

  if (h.lineage.length > 1) {
    console.log("\n" + chalk.bold.white("  Lineage") + chalk.gray(" (oldest first)"));
    for (const c of h.lineage) {
      const marker = c.id === h.claim.id ? chalk.cyan(" ← this") : "";
      console.log(`  ${statusColor(c.status)}  ${c.id}  "${c.statement}"${marker}`);
    }
  }

  if (h.conflicts.length) {
    console.log("\n" + chalk.yellow.bold(`  Conflicts (${h.conflicts.length})`));
    for (const c of h.conflicts) console.log(`  ${c.id}  ${c.reason}`);
  }

  if (h.answers.length) {
    console.log("\n" + chalk.bold.white("  Answers questions"));
    for (const q of h.answers) console.log(`  ${q.id}  "${q.statement}"`);
  }
  console.log("");
}
