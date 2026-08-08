// @trident/rift — a measurement instrument.
//
// Hypothesis under test: disagreement across independently-queried models
// predicts whether an answer is wrong better than any individual model's
// self-reported confidence.
//
// Phase 0 (this commit) is schema only. No capture, no metrics, no routing.
// Routing behavior is gated on Phase 6 — see README.

export { migrate, rollback, appliedMigrations, RIFT_MIGRATIONS } from "./schema.js";
export type { Migration } from "./schema.js";
export {
  STUDY_POLICY,
  LeakageError,
  assertNoLeakage,
  assessEligibility,
  canComputeDivergence,
  canonicalJson,
  hashCondition,
  temporalClass,
  verifyHeldFixed,
} from "./policy.js";
export type { ConditionRecord, EligibilityInput, TemporalClass } from "./policy.js";
export type {
  AnswerType,
  Divergence,
  DivergenceMethod,
  Domain,
  ExclusionReason,
  ModelResponse,
  Query,
  Resolution,
  ResolvedBy,
  Scoring,
} from "./types.js";
