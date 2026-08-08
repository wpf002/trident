import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { SessionRunInput } from "../db.js";
import { modelFor } from "../models.js";
import { migrate } from "./schema.js";
import { assessEligibility, hashCondition, type ConditionRecord } from "./policy.js";
import type { AnswerType, Domain, ExclusionReason } from "./types.js";

// Records each Trident run for disagreement tracking.
//
// Hard rule: this never blocks, delays, or fails a Trident query. Capture is
// deferred and every failure is swallowed, so the worst case is a missing
// row — never a broken run.

/** Deterministic ids — capture is naturally idempotent, even under a race. */
const queryId = (sessionId: string) =>
  `qry_${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`;
const responseId = (sessionId: string, model: string) =>
  `rsp_${createHash("sha256").update(`${sessionId}::${model}`).digest("hex").slice(0, 16)}`;

/**
 * Optional classification a caller can attach at query time via
 * `metadata.rift`. Rift does NOT infer domain or answer type — inferring them
 * would mean running a model, which costs inference (§9) and would make the
 * study's own classification model-dependent. Untagged runs are captured with
 * safe defaults and can be classified later.
 */
export interface RiftTag {
  domain?: Domain;
  answerType?: AnswerType;
  /** ISO timestamp when ground truth becomes knowable. Presence => predictive. */
  resolvesAfter?: string;
  /** Whether the question has an objectively verifiable outcome (§5). */
  studyable?: boolean;
}

function readTag(metadata: unknown): RiftTag {
  if (!metadata || typeof metadata !== "object") return {};
  const tag = (metadata as Record<string, unknown>).rift;
  return tag && typeof tag === "object" ? (tag as RiftTag) : {};
}

const DOMAINS: Domain[] = ["RACING", "SPORTS", "FINANCE", "GENERAL"];
const ANSWER_TYPES: AnswerType[] = ["BOOLEAN", "CATEGORICAL", "NUMERIC", "ORDINAL", "OPEN"];

interface SessionResponseLike {
  ai: string;
  content: string;
  error?: string;
  duration_ms?: number;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

/** Trident's judge pass runs at the utility tier — record exactly which model. */
function judgeModelName(): string {
  try {
    return modelFor("claude", "utility");
  } catch {
    return "claude";
  }
}

/** Pull per-model judge confidence out of metadata.confidence, if scoring ran. */
function judgeScores(metadata: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!metadata || typeof metadata !== "object") return out;
  const conf = (metadata as Record<string, unknown>).confidence;
  if (!conf || typeof conf !== "object") return out;
  const scores = (conf as Record<string, unknown>).scores;
  if (!Array.isArray(scores)) return out;
  for (const s of scores) {
    if (s && typeof s === "object") {
      const ai = (s as Record<string, unknown>).ai;
      const c = (s as Record<string, unknown>).confidence;
      if (typeof ai === "string" && typeof c === "number") out.set(ai, c);
    }
  }
  return out;
}

/**
 * Databases this process has already migrated. Capture is called on every
 * session write, so the schema check has to be effectively free after the
 * first one — but it must still happen, because nothing else installs the
 * schema now that capture is invoked directly by core's logSessionRun.
 */
const migrated = new WeakSet<Database.Database>();

function ensureSchema(db: Database.Database): void {
  if (migrated.has(db)) return;
  migrate(db);
  migrated.add(db);
}

export interface CaptureResult {
  captured: boolean;
  queryId: string;
  exclusionReason: ExclusionReason | null;
  nResponses: number;
  /** Set when capture was skipped rather than performed. */
  skipped?: "ALREADY_CAPTURED";
}

/**
 * Capture one Trident session as a Rift Query + ModelResponse rows.
 *
 * Idempotent: deterministic ids plus INSERT OR IGNORE plus a unique index on
 * session_id mean re-running is a no-op, and the live observer racing the
 * backlog sweep is harmless.
 *
 * Captures EVERY session, including chained ones — they're recorded with
 * `exclusion_reason = 'CHAINED'` rather than dropped, so the excluded
 * population is auditable instead of invisible.
 */
export function captureSessionRun(db: Database.Database, run: SessionRunInput): CaptureResult {
  ensureSchema(db);
  const qid = queryId(run.id);

  const existing = db.prepare("SELECT id FROM rift_queries WHERE session_id = ?").get(run.id) as
    | { id: string }
    | undefined;
  if (existing) {
    return { captured: false, queryId: existing.id, exclusionReason: null, nResponses: 0, skipped: "ALREADY_CAPTURED" };
  }

  const tag = readTag(run.metadata);
  const domain: Domain = tag.domain && DOMAINS.includes(tag.domain) ? tag.domain : "GENERAL";
  const answerType: AnswerType =
    tag.answerType && ANSWER_TYPES.includes(tag.answerType) ? tag.answerType : "OPEN";

  const responses = (run.responses ?? []) as SessionResponseLike[];
  const ok = responses.filter((r) => !r.error && (r.content ?? "").trim().length > 0);
  const errored = responses.filter((r) => r.error || !(r.content ?? "").trim().length).map((r) => r.ai);

  // §3 held-fixed: in a parallel run Trident fans ONE prompt and ONE system
  // prompt to every model, so these are identical by construction. Recording
  // them per response is what makes that checkable rather than assumed.
  const promptHash = hashCondition(run.prompt);
  const systemPromptHash = hashCondition(run.system_prompt ?? null);
  const conditions: ConditionRecord[] = ok.map((r) => ({
    model: r.model ?? r.ai,
    promptHash,
    systemPromptHash,
    samplingParams: {}, // Trident sets none; Claude Opus 5 rejects `temperature`
  }));

  const exclusionReason = assessEligibility({
    mode: run.mode,
    answerType,
    responses: conditions,
    erroredModels: errored,
    studyable: tag.studyable,
  });

  const judge = judgeScores(run.metadata);
  const judgeModel = judge.size > 0 ? judgeModelName() : null;

  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO rift_queries
         (id, session_id, domain, answer_type, prompt, asked_at, resolves_after, isolation_verified, exclusion_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      qid,
      run.id,
      domain,
      answerType,
      run.prompt,
      run.started_at,
      tag.resolvesAfter ?? null,
      run.mode === "parallel" ? 1 : 0, // §3 independence, verified from mode
      exclusionReason
    );

    const insertResponse = db.prepare(
      `INSERT OR IGNORE INTO rift_model_responses
         (id, query_id, model, raw_answer, stated_confidence, judge_confidence, judge_model,
          latency_ms, token_cost, prompt_hash, system_prompt_hash, sampling_params)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, '{}')`
    );

    for (const r of responses) {
      const model = r.model ?? r.ai;
      const tokens = r.usage ? r.usage.input_tokens + r.usage.output_tokens : 0;
      insertResponse.run(
        responseId(run.id, model),
        qid,
        model,
        r.error ? "" : r.content ?? "",
        judge.get(r.ai) ?? null,
        judge.has(r.ai) ? judgeModel : null,
        r.duration_ms ?? 0,
        tokens,
        promptHash,
        systemPromptHash
      );
    }
  })();

  return { captured: true, queryId: qid, exclusionReason, nResponses: responses.length };
}

/**
 * Sweep session_runs for anything not yet captured.
 *
 * This is the safety net that makes the Phase 1 exit criterion actually true:
 * live capture is deliberately silent on failure (§9), so without a sweep a
 * dropped capture would be lost forever. It also backfills sessions recorded
 * before Rift existed.
 */
export function captureBacklog(db: Database.Database, limit = 1000): {
  scanned: number;
  captured: number;
  alreadyCaptured: number;
} {
  ensureSchema(db);

  const rows = db
    .prepare(
      `SELECT s.id, s.mode, s.prompt, s.project, s.ais, s.responses, s.duration_ms,
              s.preset, s.system_prompt, s.metadata, s.started_at, s.finished_at
       FROM session_runs s
       LEFT JOIN rift_queries q ON q.session_id = s.id
       WHERE q.id IS NULL
       ORDER BY s.created_at ASC
       LIMIT ?`
    )
    .all(limit) as Array<Record<string, unknown>>;

  let captured = 0;
  let already = 0;
  for (const row of rows) {
    try {
      const run: SessionRunInput = {
        id: row.id as string,
        mode: row.mode as "parallel" | "chain",
        prompt: row.prompt as string,
        project: (row.project as string) ?? null,
        ais: row.ais ? (JSON.parse(row.ais as string) as string[]) : [],
        responses: row.responses ? JSON.parse(row.responses as string) : [],
        duration_ms: (row.duration_ms as number) ?? 0,
        preset: (row.preset as string) ?? null,
        system_prompt: (row.system_prompt as string) ?? null,
        metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
        started_at: row.started_at as string,
        finished_at: row.finished_at as string,
      };
      const res = captureSessionRun(db, run);
      if (res.captured) captured++;
      else already++;
    } catch {
      // One malformed historical row must not stop the sweep.
    }
  }
  return { scanned: rows.length, captured, alreadyCaptured: already };
}

/**
 * Whether automatic capture is enabled. On by default — the study's binding
 * constraint is sample size (§5), so opt-out beats opt-in.
 *
 * Set `RIFT_CAPTURE=0` (also accepts `false`/`off`/`no`) to disable. This is
 * the kill switch: Rift is an experiment that may be rejected in Phase 6, and
 * an experiment shipped to production needs a way to be switched off without a
 * code change.
 *
 * Read at call time, not module load, so it can be toggled per process.
 *
 * Scope: this gates the AUTOMATIC path only. `captureSessionRun()` and
 * `captureBacklog()` are explicit operator actions (`trident rift backfill`)
 * and still run when disabled — if you deliberately invoke them, you mean it.
 */
export function captureEnabled(): boolean {
  const v = (process.env.RIFT_CAPTURE ?? "").trim().toLowerCase();
  if (v === "") return true; // default ON
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}
