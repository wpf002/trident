import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createSpine, type Spine } from "./spine.js";
import { InvariantViolationError } from "./errors.js";
import type { Provenance } from "./types.js";

// The conflict check is the only part of spine that really matters, so it gets
// tested first and hardest. Every test runs against its own in-memory DB.

const prov = (over: Partial<Provenance> = {}): Provenance => ({
  session_id: "sesn_test",
  models_consulted: ["claude", "gpt"],
  verdict: "agreed",
  confidence: 80,
  raw_response_ref: "session_runs:sesn_test#0",
  ...over,
});

let spine: Spine;

beforeEach(() => {
  spine = createSpine(new Database(":memory:"));
});

describe("conflict detection", () => {
  it("fires when two claims share a canonical_form but assert different things", () => {
    spine.assert({
      statement: "Auth tokens expire after 24h",
      canonical_form: "auth.token.expiry",
      scope: "trident",
      provenance: prov(),
    });

    const res = spine.assert({
      statement: "Auth tokens expire after 1h",
      canonical_form: "auth.token.expiry",
      scope: "trident",
      provenance: prov(),
    });

    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0].reason).toContain("auth.token.expiry");
    expect(res.conflicts[0].reason).toContain("24h");
    expect(res.conflicts[0].reason).toContain("1h");
  });

  it("does NOT fire for the same statement restated — that is corroboration", () => {
    spine.assert({
      statement: "Auth tokens expire after 24h",
      canonical_form: "auth.token.expiry",
      scope: "trident",
      provenance: prov({ session_id: "sesn_a" }),
    });

    const res = spine.assert({
      statement: "  auth tokens expire after 24H.  ", // whitespace/case/punctuation only
      canonical_form: "auth.token.expiry",
      scope: "trident",
      provenance: prov({ session_id: "sesn_b" }),
    });

    expect(res.conflicts).toHaveLength(0);
    expect(spine.listClaims("trident")).toHaveLength(2); // both kept, both cited
  });

  it("does NOT fire across different scopes — no cross-contamination", () => {
    spine.assert({
      statement: "Auth tokens expire after 24h",
      canonical_form: "auth.token.expiry",
      scope: "project-a",
      provenance: prov(),
    });

    const res = spine.assert({
      statement: "Auth tokens expire after 1h",
      canonical_form: "auth.token.expiry",
      scope: "project-b",
      provenance: prov(),
    });

    expect(res.conflicts).toHaveLength(0);
    expect(spine.conflicts()).toHaveLength(0);
  });

  it("does NOT fire against superseded or refuted claims", () => {
    const first = spine.assert({
      statement: "Auth tokens expire after 24h",
      canonical_form: "auth.token.expiry",
      scope: "trident",
      provenance: prov(),
    });

    // Explicitly supersede it.
    spine.assert({
      statement: "Auth tokens expire after 12h",
      canonical_form: "auth.token.expiry",
      scope: "trident",
      provenance: prov(),
      supersedes: first.claim.id,
    });

    // A third claim should only conflict with the LIVE one (12h), not the dead 24h.
    const third = spine.assert({
      statement: "Auth tokens expire after 1h",
      canonical_form: "auth.token.expiry",
      scope: "trident",
      provenance: prov(),
    });

    expect(third.conflicts).toHaveLength(1);
    expect(third.conflicts[0].reason).toContain("12h");
    expect(third.conflicts[0].reason).not.toContain("24h");
  });

  it("records a conflict with both claims, the scope, and why it fired", () => {
    const a = spine.assert({
      statement: "Retries are capped at 3",
      canonical_form: "http.retry.cap",
      scope: "trident",
      provenance: prov(),
    });
    const b = spine.assert({
      statement: "Retries are capped at 5",
      canonical_form: "http.retry.cap",
      scope: "trident",
      provenance: prov(),
    });

    const [conflict] = spine.conflicts("trident");
    expect(conflict.claim_a).toBe(a.claim.id); // existing
    expect(conflict.claim_b).toBe(b.claim.id); // incoming
    expect(conflict.scope).toBe("trident");
    expect(conflict.reason).toBeTruthy();
    expect(conflict.detected_at).toBeTruthy();
  });

  it("never auto-resolves — both claims stay live after a conflict", () => {
    const a = spine.assert({
      statement: "Retries are capped at 3",
      canonical_form: "http.retry.cap",
      scope: "trident",
      provenance: prov(),
    });
    const b = spine.assert({
      statement: "Retries are capped at 5",
      canonical_form: "http.retry.cap",
      scope: "trident",
      provenance: prov(),
    });

    expect(spine.getClaim(a.claim.id)!.status).toBe("open");
    expect(spine.getClaim(b.claim.id)!.status).toBe("open");
    expect(spine.getClaim(a.claim.id)!.superseded_by).toBeNull();
  });

  it("reports every conflicting claim, not just the first", () => {
    spine.assert({
      statement: "Cap is 3",
      canonical_form: "http.retry.cap",
      scope: "trident",
      provenance: prov(),
    });
    spine.assert({
      statement: "Cap is 5",
      canonical_form: "http.retry.cap",
      scope: "trident",
      provenance: prov(),
    });

    const third = spine.assert({
      statement: "Cap is 10",
      canonical_form: "http.retry.cap",
      scope: "trident",
      provenance: prov(),
    });

    expect(third.conflicts).toHaveLength(2);
  });

  it("falls back to normalized statement when no canonical_form is given", () => {
    spine.assert({ statement: "The sky is blue", scope: "trident", provenance: prov() });

    // Different statement -> different derived key -> NOT detected. Documented
    // limitation: without a shared key there is nothing to compare on.
    const res = spine.assert({ statement: "The sky is red", scope: "trident", provenance: prov() });
    expect(res.conflicts).toHaveLength(0);

    // Same statement -> same derived key -> corroboration, still no conflict.
    const same = spine.assert({ statement: "the sky is blue", scope: "trident", provenance: prov() });
    expect(same.conflicts).toHaveLength(0);
  });
});

describe("check() dry run", () => {
  it("finds the same conflicts as assert() but writes nothing", () => {
    spine.assert({
      statement: "Auth tokens expire after 24h",
      canonical_form: "auth.token.expiry",
      scope: "trident",
      provenance: prov(),
    });

    const before = spine.listClaims().length;
    const result = spine.check({
      statement: "Auth tokens expire after 1h",
      canonical_form: "auth.token.expiry",
      scope: "trident",
    });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].claim.statement).toBe("Auth tokens expire after 24h");
    expect(spine.listClaims().length).toBe(before); // nothing written
    expect(spine.conflicts()).toHaveLength(0); // no conflict record either
  });

  it("flags when the conflicting claim is a locked invariant", () => {
    const inv = spine.assert({
      statement: "Auth tokens expire after 24h",
      canonical_form: "auth.token.expiry",
      scope: "trident",
      provenance: prov(),
    });
    spine.lock(inv.claim.id);

    const result = spine.check({
      statement: "Auth tokens expire after 1h",
      canonical_form: "auth.token.expiry",
      scope: "trident",
    });
    expect(result.conflicts[0].locked).toBe(true);
  });
});

describe("locked invariants", () => {
  it("raises on a conflicting write instead of merging", () => {
    const inv = spine.assert({
      statement: "Money is never rounded up",
      canonical_form: "billing.rounding",
      scope: "trident",
      provenance: prov(),
    });
    spine.lock(inv.claim.id);

    expect(() =>
      spine.assert({
        statement: "Money rounds up at .5",
        canonical_form: "billing.rounding",
        scope: "trident",
        provenance: prov(),
      })
    ).toThrow(InvariantViolationError);
  });

  it("leaves the invariant untouched and writes nothing when it raises", () => {
    const inv = spine.assert({
      statement: "Money is never rounded up",
      canonical_form: "billing.rounding",
      scope: "trident",
      provenance: prov(),
    });
    spine.lock(inv.claim.id);
    const before = spine.listClaims().length;

    try {
      spine.assert({
        statement: "Money rounds up at .5",
        canonical_form: "billing.rounding",
        scope: "trident",
        provenance: prov(),
      });
    } catch {
      /* expected */
    }

    const after = spine.getClaim(inv.claim.id)!;
    expect(after.statement).toBe("Money is never rounded up");
    expect(after.locked).toBe(true);
    expect(after.status).toBe("open");
    expect(spine.listClaims().length).toBe(before); // incoming claim not written
    expect(spine.conflicts()).toHaveLength(0);
  });

  it("carries both claims and the reason on the raised error", () => {
    const inv = spine.assert({
      statement: "Money is never rounded up",
      canonical_form: "billing.rounding",
      scope: "trident",
      provenance: prov(),
    });
    spine.lock(inv.claim.id);

    try {
      spine.assert({
        statement: "Money rounds up at .5",
        canonical_form: "billing.rounding",
        scope: "trident",
        provenance: prov(),
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as InvariantViolationError;
      expect(e.invariant.id).toBe(inv.claim.id);
      expect(e.incoming.statement).toBe("Money rounds up at .5");
      expect(e.incoming.scope).toBe("trident");
      expect(e.reason).toContain("billing.rounding");
    }
  });

  it("allows a corroborating write against a locked invariant", () => {
    const inv = spine.assert({
      statement: "Money is never rounded up",
      canonical_form: "billing.rounding",
      scope: "trident",
      provenance: prov(),
    });
    spine.lock(inv.claim.id);

    expect(() =>
      spine.assert({
        statement: "Money is never rounded up",
        canonical_form: "billing.rounding",
        scope: "trident",
        provenance: prov({ session_id: "sesn_other" }),
      })
    ).not.toThrow();
  });

  it("refuses to supersede a locked invariant", () => {
    const inv = spine.assert({
      statement: "Money is never rounded up",
      canonical_form: "billing.rounding",
      scope: "trident",
      provenance: prov(),
    });
    spine.lock(inv.claim.id);

    expect(() =>
      spine.assert({
        statement: "Rounding policy replaced",
        canonical_form: "billing.rounding.v2",
        scope: "trident",
        provenance: prov(),
        supersedes: inv.claim.id,
      })
    ).toThrow(InvariantViolationError);
  });

  it("permits the write again once explicitly unlocked", () => {
    const inv = spine.assert({
      statement: "Money is never rounded up",
      canonical_form: "billing.rounding",
      scope: "trident",
      provenance: prov(),
    });
    spine.lock(inv.claim.id);
    spine.unlock(inv.claim.id);

    const res = spine.assert({
      statement: "Money rounds up at .5",
      canonical_form: "billing.rounding",
      scope: "trident",
      provenance: prov(),
    });
    expect(res.conflicts).toHaveLength(1); // recorded, still not auto-resolved
  });
});
