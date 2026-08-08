// Rift — Trident's disagreement tracking.
//
// Records how much the models disagreed on each parallel run, so that
// disagreement can later be tested as an error signal. Capture only for now:
// no metrics, no scoring, and no effect on how Trident answers anything.
//
// See docs/rift-hypothesis.md for what's being measured and why.

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
export { captureSessionRun, captureBacklog, captureEnabled } from "./capture.js";
export type { CaptureResult, RiftTag } from "./capture.js";
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
