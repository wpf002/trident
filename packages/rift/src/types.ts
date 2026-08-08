// Rift data model. Phase 0 defines the shape; capture lands in Phase 1.
//
// Three fields here are NOT in the original spec. They are flagged in the
// Phase 0 writeup and marked ADDED below. Each exists because a §3
// methodological rule is unenforceable without it.

export type Domain = "RACING" | "SPORTS" | "FINANCE" | "GENERAL";

export type AnswerType = "BOOLEAN" | "CATEGORICAL" | "NUMERIC" | "ORDINAL" | "OPEN";

export type DivergenceMethod =
  | "SHANNON_ENTROPY" // BOOLEAN / CATEGORICAL
  | "MAD_OVER_MEDIAN" // NUMERIC
  | "KENDALL_W_INV" // ORDINAL
  | "EMBEDDING_DISPERSION" // OPEN
  | "JUDGE_SECONDARY"; // OPEN, secondary only, never primary (§4)

export type ResolvedBy = "AUTOMATED" | "MANUAL";

/**
 * Why a query is not in the study set. Null means it is.
 * Every exclusion reason maps to a rule in §3.
 */
export type ExclusionReason =
  | "CHAINED" // §3 independence — models saw each other's output
  | "CONDITIONS_VARIED" // §3 held-fixed — prompt/system/sampling differed across models
  | "UNSTUDYABLE" // §5 — no objectively verifiable outcome
  | "INSUFFICIENT_PARTICIPANTS" // fewer than 2 responses; divergence undefined
  | "RESPONSE_ERROR"; // one or more models errored; distribution incomplete

export interface Query {
  id: string;
  /** Points at the existing session_runs.id. Rift never modifies that table. */
  sessionId: string;
  domain: Domain;
  answerType: AnswerType;
  prompt: string;
  askedAt: string;
  /** When ground truth becomes knowable. Null = unknown/immediate. */
  resolvesAfter: string | null;
  /** §3 independence: true only for parallel-mode runs. */
  isolationVerified: boolean;
  /** Null = in the study set. Non-null = logged but excluded. */
  exclusionReason: ExclusionReason | null;
}

export interface ModelResponse {
  id: string;
  queryId: string;
  model: string;
  rawAnswer: string;
  /** Normalized per answerType. Null until parsed. */
  parsedAnswer: unknown | null;
  /**
   * Each model's OWN reported confidence. Null when not elicited.
   * NOTE: this is NOT Trident's existing confidence score, which is a
   * separate Claude judge pass over all responses. See the Phase 0 writeup —
   * this field is null until that is resolved.
   */
  statedConfidence: number | null;
  latencyMs: number;
  tokenCost: number;
  /** OPEN answers only. */
  embedding: Float32Array | null;

  // ─── ADDED (not in spec) — §3 "held-fixed conditions" says to log all
  // three per response, but the spec's ModelResponse had nowhere to put them,
  // making the exclusion rule unenforceable. ───────────────────────────────
  /** Hash of the exact prompt text this model received. */
  promptHash: string;
  /** Hash of the system prompt this model received. */
  systemPromptHash: string;
  /**
   * Sampling params actually sent, as JSON. Trident sets none today, and
   * Claude Opus 5 rejects `temperature` outright — so the held-fixed policy
   * is "provider defaults, unset", recorded rather than compared.
   */
  samplingParams: Record<string, unknown>;
}

export interface Divergence {
  queryId: string;
  /** 0-1, normalized per answerType. Never compare across answer types. */
  metric: number;
  method: DivergenceMethod;
  /** Report alongside metric — with n=3 the metric is coarse (§4). */
  nParticipants: number;
  computedAt: string;
}

export interface Resolution {
  queryId: string;
  truth: unknown;
  /** URL, feed, or system that provided truth. */
  source: string;
  resolvedBy: ResolvedBy;
  resolvedAt: string;

  // ─── ADDED (not in spec) — §3 leakage guard: "reject any Resolution whose
  // underlying event predates askedAt". The spec's Resolution had only
  // resolvedAt (when WE recorded it), so the guard could not be implemented.
  /** When the truth-determining event actually occurred. */
  eventAt: string;
}

export interface Scoring {
  queryId: string;
  model: string;
  correct: boolean;
  /** NUMERIC/ORDINAL only. */
  error: number | null;
}
