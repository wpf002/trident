import type { Claim } from "./types.js";

/**
 * Thrown when a write conflicts with a locked invariant.
 *
 * This is the whole point of locking: the write does not merge, does not win
 * silently, and does not modify the invariant. It raises and the caller deals
 * with it.
 */
export class InvariantViolationError extends Error {
  readonly invariant: Claim;
  readonly incoming: { statement: string; canonical_form: string; scope: string };
  readonly reason: string;

  constructor(
    invariant: Claim,
    incoming: { statement: string; canonical_form: string; scope: string },
    reason: string
  ) {
    super(
      `Locked invariant ${invariant.id} in scope "${invariant.scope}" cannot be overwritten: ${reason}. ` +
        `Existing: "${invariant.statement}" — incoming: "${incoming.statement}". ` +
        `Unlock it explicitly if this change is intended.`
    );
    this.name = "InvariantViolationError";
    this.invariant = invariant;
    this.incoming = incoming;
    this.reason = reason;
  }
}

/** Thrown when an id doesn't resolve. */
export class NotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} not found: ${id}`);
    this.name = "NotFoundError";
  }
}
