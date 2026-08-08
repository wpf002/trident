// @trident/spine — cross-session claim persistence and conflict checking.
//
// See README.md for the data model and the explicit non-goals (no simulation,
// no memory tiers, no governance, no auto-resolution).

export { createSpine, normalize } from "./spine.js";
export type { Spine } from "./spine.js";
export { migrate, appliedMigrations, SPINE_MIGRATIONS } from "./schema.js";
export type { Migration } from "./schema.js";
export { InvariantViolationError, NotFoundError } from "./errors.js";
export type {
  AssertInput,
  AssertResult,
  CheckInput,
  CheckResult,
  Claim,
  ClaimHistory,
  ClaimStatus,
  Conflict,
  Provenance,
  Question,
  Relation,
  RelationType,
} from "./types.js";
