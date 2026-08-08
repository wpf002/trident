// Data model for the spine. Deliberately small — see README for the
// explicit non-goals (no memory tiers, no governance, no hypotheses).

export type ClaimStatus = "open" | "held" | "superseded" | "refuted";

/** The only relations that exist. Not extensible by design. */
export type RelationType = "supersedes" | "conflicts_with" | "answers";

export interface Provenance {
  /** Session that produced this claim — points at session_runs.id. */
  session_id: string;
  models_consulted: string[];
  verdict: string | null;
  confidence: number | null;
  /** Pointer into the existing session replay payload. */
  raw_response_ref: string | null;
}

export interface Claim {
  id: string;
  statement: string;
  /** The KEY being claimed about — what conflicts are detected on. */
  canonical_form: string;
  scope: string;
  status: ClaimStatus;
  locked: boolean;
  created_at: string;
  superseded_by: string | null;
  provenance: Provenance;
}

export interface Question {
  id: string;
  statement: string;
  scope: string;
  opened_at: string;
  /** Claim that answers this, or null while still open. */
  resolves_to: string | null;
}

/** A recorded disagreement. Spine never resolves these. */
export interface Conflict {
  id: string;
  /** The claim already stored. */
  claim_a: string;
  /** The incoming claim. */
  claim_b: string;
  scope: string;
  /** Why the check fired, in plain language. */
  reason: string;
  detected_at: string;
}

export interface Relation {
  /** Claim id. */
  from_id: string;
  /** Claim id, or question id when type is "answers". */
  to_id: string;
  type: RelationType;
  created_at: string;
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface AssertInput {
  statement: string;
  /**
   * The key this claim is about. Omit and it defaults to a normalization of
   * `statement` — which means competing claims will NOT be detected. Supply it
   * when you want the conflict check to actually work.
   */
  canonical_form?: string;
  scope: string;
  provenance: Provenance;
  /** Claim id this explicitly replaces. Marks the old one superseded. */
  supersedes?: string;
  status?: ClaimStatus;
}

export interface CheckInput {
  statement: string;
  canonical_form?: string;
  scope: string;
}

/** What a conflict check found, without writing anything. */
export interface CheckResult {
  conflicts: Array<{
    claim: Claim;
    reason: string;
    /** True when the existing claim is a locked invariant. */
    locked: boolean;
  }>;
}

export interface AssertResult {
  claim: Claim;
  /** Conflicts recorded against this write. Never auto-resolved. */
  conflicts: Conflict[];
}

export interface ClaimHistory {
  claim: Claim;
  /** Supersede chain, oldest first. */
  lineage: Claim[];
  conflicts: Conflict[];
  relations: Relation[];
  /** Questions this claim answers. */
  answers: Question[];
}
