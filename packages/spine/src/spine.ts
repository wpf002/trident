import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "@trident/core";
import { migrate } from "./schema.js";
import { InvariantViolationError, NotFoundError } from "./errors.js";
import type {
  AssertInput,
  AssertResult,
  CheckInput,
  CheckResult,
  Claim,
  ClaimHistory,
  Conflict,
  Question,
  Relation,
} from "./types.js";

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Normalization used for two things only: defaulting `canonical_form` when the
 * caller omits one, and comparing statements for equality. It is NOT semantic —
 * it will not notice that two differently-worded statements mean the same thing.
 */
export function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?;,]+$/, "");
}

/** Claims that still count. Superseded/refuted claims don't fire conflicts. */
const LIVE_STATUSES = ["open", "held"] as const;

interface ClaimRow {
  id: string;
  statement: string;
  canonical_form: string;
  scope: string;
  status: string;
  locked: number;
  created_at: string;
  superseded_by: string | null;
  session_id: string | null;
  models_consulted: string | null;
  verdict: string | null;
  confidence: number | null;
  raw_response_ref: string | null;
}

function hydrate(row: ClaimRow): Claim {
  return {
    id: row.id,
    statement: row.statement,
    canonical_form: row.canonical_form,
    scope: row.scope,
    status: row.status as Claim["status"],
    locked: row.locked === 1,
    created_at: row.created_at,
    superseded_by: row.superseded_by,
    provenance: {
      session_id: row.session_id ?? "",
      models_consulted: row.models_consulted ? (JSON.parse(row.models_consulted) as string[]) : [],
      verdict: row.verdict,
      confidence: row.confidence,
      raw_response_ref: row.raw_response_ref,
    },
  };
}

const SELECT_CLAIM = `
  SELECT c.*, p.session_id, p.models_consulted, p.verdict, p.confidence, p.raw_response_ref
  FROM spine_claims c
  LEFT JOIN spine_provenance p ON p.claim_id = c.id
`;

export interface Spine {
  assert(input: AssertInput): AssertResult;
  check(input: CheckInput): CheckResult;
  lock(claimId: string): Claim;
  unlock(claimId: string): Claim;
  ask(input: { statement: string; scope: string }): Question;
  resolve(questionId: string, claimId: string): Question;
  history(claimId: string): ClaimHistory;
  /** Read helpers — not part of the required surface, but needed to use it. */
  getClaim(claimId: string): Claim | null;
  listClaims(scope?: string): Claim[];
  openQuestions(scope?: string): Question[];
  conflicts(scope?: string): Conflict[];
  readonly db: Database.Database;
}

/**
 * Create a spine bound to a database.
 *
 * Defaults to the shared Trident SQLite database (the same file that holds the
 * session replay), so claims can cite the sessions that produced them. Pass an
 * explicit database to isolate — tests do this.
 */
export function createSpine(db?: Database.Database): Spine {
  const database = db ?? defaultDb();
  migrate(database);

  const findLive = database.prepare(
    `${SELECT_CLAIM} WHERE c.scope = ? AND c.canonical_form = ?
       AND c.status IN (${LIVE_STATUSES.map(() => "?").join(",")})`
  );

  /**
   * The conflict engine. Both check() and assert() go through here so a dry run
   * and a real write can never disagree.
   *
   * Rule: same scope + same canonical_form + different statement = conflict.
   * Identical statements are corroboration, not conflict.
   */
  function detect(scope: string, canonical: string, statement: string) {
    const existing = (findLive.all(scope, canonical, ...LIVE_STATUSES) as ClaimRow[]).map(hydrate);
    const incoming = normalize(statement);
    return existing
      .filter((c) => normalize(c.statement) !== incoming)
      .map((claim) => ({
        claim,
        locked: claim.locked,
        reason:
          `both claim "${canonical}" in scope "${scope}" but assert different things: ` +
          `stored "${claim.statement}" vs incoming "${statement}"`,
      }));
  }

  const spine: Spine = {
    db: database,

    check(input) {
      const canonical = input.canonical_form?.trim() || normalize(input.statement);
      return { conflicts: detect(input.scope, canonical, input.statement) };
    },

    assert(input) {
      const canonical = input.canonical_form?.trim() || normalize(input.statement);
      const found = detect(input.scope, canonical, input.statement);

      // Locked invariants raise BEFORE anything is written. No merge, no
      // silent overwrite, and the invariant itself is left untouched.
      const lockedHit = found.find((f) => f.locked);
      if (lockedHit) {
        throw new InvariantViolationError(
          lockedHit.claim,
          { statement: input.statement, canonical_form: canonical, scope: input.scope },
          lockedHit.reason
        );
      }

      const claimId = id("clm");
      const now = new Date().toISOString();
      const conflicts: Conflict[] = [];

      const tx = database.transaction(() => {
        database
          .prepare(
            `INSERT INTO spine_claims (id, statement, canonical_form, scope, status, locked, created_at, superseded_by)
             VALUES (?, ?, ?, ?, ?, 0, ?, NULL)`
          )
          .run(claimId, input.statement, canonical, input.scope, input.status ?? "open", now);

        const p = input.provenance;
        database
          .prepare(
            `INSERT INTO spine_provenance (claim_id, session_id, models_consulted, verdict, confidence, raw_response_ref)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            claimId,
            p.session_id,
            JSON.stringify(p.models_consulted ?? []),
            p.verdict ?? null,
            p.confidence ?? null,
            p.raw_response_ref ?? null
          );

        // Record every conflict. Never resolve one.
        for (const f of found) {
          const conflict: Conflict = {
            id: id("cfl"),
            claim_a: f.claim.id,
            claim_b: claimId,
            scope: input.scope,
            reason: f.reason,
            detected_at: now,
          };
          database
            .prepare(
              `INSERT INTO spine_conflicts (id, claim_a, claim_b, scope, reason, detected_at)
               VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(conflict.id, conflict.claim_a, conflict.claim_b, conflict.scope, conflict.reason, now);
          database
            .prepare(
              `INSERT OR IGNORE INTO spine_relations (from_id, to_id, type, created_at) VALUES (?, ?, 'conflicts_with', ?)`
            )
            .run(claimId, f.claim.id, now);
          conflicts.push(conflict);
        }

        // Explicit supersede is the caller resolving something deliberately.
        if (input.supersedes) {
          const prior = spine.getClaim(input.supersedes);
          if (!prior) throw new NotFoundError("Claim", input.supersedes);
          if (prior.locked) {
            throw new InvariantViolationError(
              prior,
              { statement: input.statement, canonical_form: canonical, scope: input.scope },
              "cannot supersede a locked invariant"
            );
          }
          database
            .prepare(`UPDATE spine_claims SET status = 'superseded', superseded_by = ? WHERE id = ?`)
            .run(claimId, input.supersedes);
          database
            .prepare(
              `INSERT OR IGNORE INTO spine_relations (from_id, to_id, type, created_at) VALUES (?, ?, 'supersedes', ?)`
            )
            .run(claimId, input.supersedes, now);
        }
      });
      tx();

      return { claim: spine.getClaim(claimId)!, conflicts };
    },

    lock(claimId) {
      const claim = spine.getClaim(claimId);
      if (!claim) throw new NotFoundError("Claim", claimId);
      database.prepare(`UPDATE spine_claims SET locked = 1 WHERE id = ?`).run(claimId);
      return spine.getClaim(claimId)!;
    },

    unlock(claimId) {
      const claim = spine.getClaim(claimId);
      if (!claim) throw new NotFoundError("Claim", claimId);
      database.prepare(`UPDATE spine_claims SET locked = 0 WHERE id = ?`).run(claimId);
      return spine.getClaim(claimId)!;
    },

    ask(input) {
      const qid = id("qst");
      const now = new Date().toISOString();
      database
        .prepare(`INSERT INTO spine_questions (id, statement, scope, opened_at, resolves_to) VALUES (?, ?, ?, ?, NULL)`)
        .run(qid, input.statement, input.scope, now);
      return { id: qid, statement: input.statement, scope: input.scope, opened_at: now, resolves_to: null };
    },

    resolve(questionId, claimId) {
      const q = database.prepare(`SELECT * FROM spine_questions WHERE id = ?`).get(questionId) as
        | Question
        | undefined;
      if (!q) throw new NotFoundError("Question", questionId);
      if (!spine.getClaim(claimId)) throw new NotFoundError("Claim", claimId);

      const now = new Date().toISOString();
      const tx = database.transaction(() => {
        database.prepare(`UPDATE spine_questions SET resolves_to = ? WHERE id = ?`).run(claimId, questionId);
        database
          .prepare(
            `INSERT OR IGNORE INTO spine_relations (from_id, to_id, type, created_at) VALUES (?, ?, 'answers', ?)`
          )
          .run(claimId, questionId, now);
      });
      tx();

      return { ...q, resolves_to: claimId };
    },

    history(claimId) {
      const claim = spine.getClaim(claimId);
      if (!claim) throw new NotFoundError("Claim", claimId);

      // Walk backwards to the oldest ancestor, then forward, so lineage reads
      // oldest -> newest with the requested claim somewhere in it.
      const lineage: Claim[] = [];
      const seen = new Set<string>();
      let cursor: Claim | null = claim;
      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        lineage.unshift(cursor);
        const predecessor = database
          .prepare(`${SELECT_CLAIM} WHERE c.superseded_by = ?`)
          .get(cursor.id) as ClaimRow | undefined;
        cursor = predecessor ? hydrate(predecessor) : null;
      }
      let forward: Claim | null = claim.superseded_by ? spine.getClaim(claim.superseded_by) : null;
      while (forward && !seen.has(forward.id)) {
        seen.add(forward.id);
        lineage.push(forward);
        forward = forward.superseded_by ? spine.getClaim(forward.superseded_by) : null;
      }

      const conflicts = database
        .prepare(`SELECT * FROM spine_conflicts WHERE claim_a = ? OR claim_b = ? ORDER BY detected_at`)
        .all(claimId, claimId) as Conflict[];
      const relations = database
        .prepare(`SELECT * FROM spine_relations WHERE from_id = ? OR to_id = ? ORDER BY created_at`)
        .all(claimId, claimId) as Relation[];
      const answers = database
        .prepare(`SELECT * FROM spine_questions WHERE resolves_to = ?`)
        .all(claimId) as Question[];

      return { claim, lineage, conflicts, relations, answers };
    },

    getClaim(claimId) {
      const row = database.prepare(`${SELECT_CLAIM} WHERE c.id = ?`).get(claimId) as ClaimRow | undefined;
      return row ? hydrate(row) : null;
    },

    listClaims(scope) {
      const rows = scope
        ? (database.prepare(`${SELECT_CLAIM} WHERE c.scope = ? ORDER BY c.created_at DESC`).all(scope) as ClaimRow[])
        : (database.prepare(`${SELECT_CLAIM} ORDER BY c.created_at DESC`).all() as ClaimRow[]);
      return rows.map(hydrate);
    },

    openQuestions(scope) {
      return (
        scope
          ? database
              .prepare(`SELECT * FROM spine_questions WHERE resolves_to IS NULL AND scope = ? ORDER BY opened_at`)
              .all(scope)
          : database.prepare(`SELECT * FROM spine_questions WHERE resolves_to IS NULL ORDER BY opened_at`).all()
      ) as Question[];
    },

    conflicts(scope) {
      return (
        scope
          ? database.prepare(`SELECT * FROM spine_conflicts WHERE scope = ? ORDER BY detected_at DESC`).all(scope)
          : database.prepare(`SELECT * FROM spine_conflicts ORDER BY detected_at DESC`).all()
      ) as Conflict[];
    },
  };

  return spine;
}

/**
 * The shared Trident database — the same file that holds the session replay.
 * core opens it lazily inside getDb(), so importing this module has no side
 * effect until a spine is actually created without an explicit database.
 */
function defaultDb(): Database.Database {
  return getDb();
}
