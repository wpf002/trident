import { createHash } from "node:crypto";
import type { AnswerType, ExclusionReason } from "./types.js";

// The §3 methodological rules, as executable code rather than prose.
//
// Everything here is a DECLARED policy: fixed up front, versioned with the
// repo, and never tuned after seeing results. If a rule changes, it changes by
// commit — visible in history — not by a runtime knob.

export const STUDY_POLICY = {
  /**
   * Below this, a query is excluded. Divergence is mathematically defined at
   * 2, but with 2 models a BOOLEAN metric is pure binary (agree/disagree) and
   * carries almost no information. 3 is the floor.
   */
  MIN_PARTICIPANTS: 3,
  /**
   * Preferred participant count. With 3 models, normalized Shannon entropy on
   * a BOOLEAN question takes exactly two values (3-0 → 0.0, 2-1 → 0.918) — an
   * effectively binary signal that caps achievable AUC. A 4th model gives
   * three levels (4-0, 3-1, 2-2). Trident has four providers, so 4-model runs
   * are free resolution and the study set should prefer them.
   */
  PREFERRED_PARTICIPANTS: 4,
  /**
   * OPEN divergence needs embeddings, which are a paid API call. §9 requires
   * zero added inference cost, so OPEN is opt-in and off by default. When off,
   * OPEN queries are captured but get no divergence metric.
   */
  OPEN_DIVERGENCE_ENABLED: process.env.RIFT_ENABLE_OPEN_DIVERGENCE === "1",
} as const;

// ─── Held-fixed conditions (§3) ──────────────────────────────────────────────

/** Stable hash of a condition string, for cross-model comparison. */
export function hashCondition(text: string | null | undefined): string {
  return createHash("sha256").update(text ?? "").digest("hex").slice(0, 32);
}

/**
 * Deterministic JSON — sorted keys, so two params objects that differ only in
 * insertion order compare equal. Without this, held-fixed checks produce false
 * exclusions depending on how an object happened to be built.
 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(walk);
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, walk(val)])
    );
  };
  return JSON.stringify(walk(value));
}

export interface ConditionRecord {
  model: string;
  promptHash: string;
  systemPromptHash: string;
  samplingParams: Record<string, unknown>;
}

/**
 * §3 held-fixed: every model must have received the same prompt, the same
 * system prompt, and the same sampling params.
 *
 * The rule is EQUALITY ACROSS MODELS WITHIN A QUERY — not equality to some
 * global constant. That matters because Trident sets no sampling params at all
 * today (and Claude Opus 5 rejects `temperature` outright, so a uniform
 * non-empty policy is impossible across providers). All-unset trivially
 * satisfies the rule, and this check still catches the future case where one
 * provider starts sending something the others don't.
 */
export function verifyHeldFixed(responses: ConditionRecord[]): {
  ok: boolean;
  reason?: ExclusionReason;
  detail?: string;
} {
  if (responses.length === 0) return { ok: false, reason: "INSUFFICIENT_PARTICIPANTS", detail: "no responses" };

  const first = responses[0];
  const firstParams = canonicalJson(first.samplingParams ?? {});

  for (const r of responses.slice(1)) {
    if (r.promptHash !== first.promptHash) {
      return { ok: false, reason: "CONDITIONS_VARIED", detail: `prompt differs: ${first.model} vs ${r.model}` };
    }
    if (r.systemPromptHash !== first.systemPromptHash) {
      return { ok: false, reason: "CONDITIONS_VARIED", detail: `system prompt differs: ${first.model} vs ${r.model}` };
    }
    if (canonicalJson(r.samplingParams ?? {}) !== firstParams) {
      return {
        ok: false,
        reason: "CONDITIONS_VARIED",
        detail: `sampling params differ: ${first.model}=${firstParams} vs ${r.model}=${canonicalJson(r.samplingParams ?? {})}`,
      };
    }
  }
  return { ok: true };
}

// ─── Leakage guard (§3) ──────────────────────────────────────────────────────

export class LeakageError extends Error {
  constructor(askedAt: string, eventAt: string) {
    super(
      `Leakage: the truth-determining event (${eventAt}) predates askedAt (${askedAt}). ` +
        `The models could have known the outcome when asked. Resolution rejected.`
    );
    this.name = "LeakageError";
  }
}

/**
 * Whether a query is a forecast or a static fact.
 *
 * This distinction is NOT in the original spec and it matters: §3 says reject
 * any resolution whose event predates askedAt, but §5 explicitly wants
 * "verifiable facts — questions with a checkable answer at ask time" for early
 * volume. For those the event ALWAYS predates the ask (the capital of France
 * was settled long before we asked), so a blanket guard would exclude the
 * entire category §5 asks for.
 *
 * Resolution: the guard applies to PREDICTIVE queries only. A query is
 * predictive iff it declares `resolvesAfter`. Static queries are still
 * captured and studied, but they test recall, not prediction, and must be
 * stratified separately in the evaluation — never pooled with forecasts.
 */
export type TemporalClass = "PREDICTIVE" | "STATIC";

export function temporalClass(query: { resolvesAfter: string | null }): TemporalClass {
  return query.resolvesAfter ? "PREDICTIVE" : "STATIC";
}

/**
 * Enforce the leakage guard. Throws on violation — a rejected resolution must
 * not be silently downgraded, because a silently-accepted backdated truth is
 * exactly how a beautiful meaningless result gets produced.
 */
export function assertNoLeakage(
  query: { askedAt: string; resolvesAfter: string | null },
  resolution: { eventAt: string }
): void {
  if (temporalClass(query) === "STATIC") return; // §5 verifiable facts — guard N/A
  if (new Date(resolution.eventAt).getTime() <= new Date(query.askedAt).getTime()) {
    throw new LeakageError(query.askedAt, resolution.eventAt);
  }
}

// ─── Study-set eligibility (§3 + §5) ─────────────────────────────────────────

export interface EligibilityInput {
  /** Trident run mode. Only parallel runs are independent (§3). */
  mode: "parallel" | "chain";
  answerType: AnswerType;
  /** One record per model that responded WITHOUT error. */
  responses: ConditionRecord[];
  /** Models that errored — an incomplete distribution isn't a disagreement. */
  erroredModels?: string[];
  /** Whether the question has an objectively verifiable outcome (§5). */
  studyable?: boolean;
}

/**
 * Single decision point for "is this query in the study set?".
 * Returns the exclusion reason, or null if it qualifies.
 *
 * Order matters: the most fundamental disqualifier wins, so the recorded
 * reason is the real one rather than whichever check ran first.
 */
export function assessEligibility(input: EligibilityInput): ExclusionReason | null {
  if (input.studyable === false) return "UNSTUDYABLE";
  // Independence is structural — a chained query has contaminated disagreement
  // by construction and no amount of other conditions rescues it.
  if (input.mode !== "parallel") return "CHAINED";
  if (input.erroredModels && input.erroredModels.length > 0) return "RESPONSE_ERROR";
  if (input.responses.length < STUDY_POLICY.MIN_PARTICIPANTS) return "INSUFFICIENT_PARTICIPANTS";

  const heldFixed = verifyHeldFixed(input.responses);
  if (!heldFixed.ok) return heldFixed.reason ?? "CONDITIONS_VARIED";

  return null;
}

/** True when a divergence metric can be computed at all for this query. */
export function canComputeDivergence(answerType: AnswerType, nParticipants: number): boolean {
  if (nParticipants < 2) return false;
  if (answerType === "OPEN" && !STUDY_POLICY.OPEN_DIVERGENCE_ENABLED) return false;
  return true;
}
