import { describe, expect, it } from "vitest";
import {
  assertNoLeakage,
  assessEligibility,
  canComputeDivergence,
  canonicalJson,
  hashCondition,
  LeakageError,
  STUDY_POLICY,
  temporalClass,
  verifyHeldFixed,
  type ConditionRecord,
} from "./policy.js";

// These tests ARE the methodology. If one of them is wrong, the study's
// results are wrong in a way no amount of downstream analysis recovers.

const cond = (model: string, over: Partial<ConditionRecord> = {}): ConditionRecord => ({
  model,
  promptHash: hashCondition("who wins race 4"),
  systemPromptHash: hashCondition("you are terse"),
  samplingParams: {},
  ...over,
});

const four = () => [cond("claude"), cond("gpt"), cond("perplexity"), cond("gemini")];

describe("held-fixed conditions (§3)", () => {
  it("passes when every model saw identical conditions", () => {
    expect(verifyHeldFixed(four()).ok).toBe(true);
  });

  it("passes with all-unset sampling params — the only policy achievable today", () => {
    // Trident sets no sampling params, and Claude Opus 5 rejects `temperature`
    // outright, so a uniform non-empty policy is impossible across providers.
    const rs = four().map((r) => ({ ...r, samplingParams: {} }));
    expect(verifyHeldFixed(rs).ok).toBe(true);
  });

  it("excludes when one model got a different prompt", () => {
    const rs = four();
    rs[2] = cond("perplexity", { promptHash: hashCondition("who wins race 5") });
    const v = verifyHeldFixed(rs);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("CONDITIONS_VARIED");
    expect(v.detail).toContain("prompt differs");
  });

  it("excludes when one model got a different system prompt", () => {
    const rs = four();
    rs[1] = cond("gpt", { systemPromptHash: hashCondition("you are verbose") });
    expect(verifyHeldFixed(rs).detail).toContain("system prompt differs");
  });

  it("catches the future case where one provider starts sending sampling params", () => {
    const rs = four();
    rs[0] = cond("claude", { samplingParams: { temperature: 0.7 } });
    const v = verifyHeldFixed(rs);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("sampling params differ");
  });

  it("does not false-exclude on key ordering", () => {
    const rs = [
      cond("a", { samplingParams: { top_p: 1, temperature: 0 } }),
      cond("b", { samplingParams: { temperature: 0, top_p: 1 } }),
      cond("c", { samplingParams: { temperature: 0, top_p: 1 } }),
    ];
    expect(verifyHeldFixed(rs).ok).toBe(true);
  });

  it("canonicalJson sorts nested keys deterministically", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe("leakage guard (§3)", () => {
  const asked = "2026-03-01T12:00:00Z";

  it("rejects a resolution whose event predates the ask", () => {
    expect(() =>
      assertNoLeakage(
        { askedAt: asked, resolvesAfter: "2026-03-02T00:00:00Z" },
        { eventAt: "2026-02-28T09:00:00Z" }
      )
    ).toThrow(LeakageError);
  });

  it("rejects an event exactly at the ask time", () => {
    expect(() =>
      assertNoLeakage({ askedAt: asked, resolvesAfter: "2026-03-02T00:00:00Z" }, { eventAt: asked })
    ).toThrow(LeakageError);
  });

  it("accepts an event after the ask", () => {
    expect(() =>
      assertNoLeakage(
        { askedAt: asked, resolvesAfter: "2026-03-02T00:00:00Z" },
        { eventAt: "2026-03-02T15:00:00Z" }
      )
    ).not.toThrow();
  });

  it("does NOT apply the guard to static verifiable facts (§5 category 2)", () => {
    // "What is the capital of France" — the truth-determining event predates
    // every possible ask. A blanket guard would exclude the whole category §5
    // asks for to build early volume.
    expect(() =>
      assertNoLeakage({ askedAt: asked, resolvesAfter: null }, { eventAt: "1792-09-22T00:00:00Z" })
    ).not.toThrow();
  });

  it("classifies predictive vs static from resolvesAfter", () => {
    expect(temporalClass({ resolvesAfter: "2026-03-02T00:00:00Z" })).toBe("PREDICTIVE");
    expect(temporalClass({ resolvesAfter: null })).toBe("STATIC");
  });
});

describe("study-set eligibility (§3 + §5)", () => {
  it("admits a clean 4-model parallel run", () => {
    expect(assessEligibility({ mode: "parallel", answerType: "BOOLEAN", responses: four() })).toBeNull();
  });

  it("excludes chained runs — contaminated by construction", () => {
    expect(assessEligibility({ mode: "chain", answerType: "BOOLEAN", responses: four() })).toBe("CHAINED");
  });

  it("excludes chained runs even when everything else is perfect", () => {
    // Independence is structural; no other condition rescues it.
    expect(
      assessEligibility({ mode: "chain", answerType: "NUMERIC", responses: four(), studyable: true })
    ).toBe("CHAINED");
  });

  it("excludes when a model errored — an incomplete distribution is not disagreement", () => {
    expect(
      assessEligibility({
        mode: "parallel",
        answerType: "BOOLEAN",
        responses: four().slice(0, 3),
        erroredModels: ["gemini"],
      })
    ).toBe("RESPONSE_ERROR");
  });

  it("excludes below the participant floor", () => {
    expect(
      assessEligibility({ mode: "parallel", answerType: "BOOLEAN", responses: [cond("claude"), cond("gpt")] })
    ).toBe("INSUFFICIENT_PARTICIPANTS");
  });

  it("admits at exactly the floor", () => {
    expect(
      assessEligibility({
        mode: "parallel",
        answerType: "BOOLEAN",
        responses: four().slice(0, STUDY_POLICY.MIN_PARTICIPANTS),
      })
    ).toBeNull();
  });

  it("excludes unstudyable questions (§5)", () => {
    expect(
      assessEligibility({ mode: "parallel", answerType: "OPEN", responses: four(), studyable: false })
    ).toBe("UNSTUDYABLE");
  });

  it("excludes varied conditions", () => {
    const rs = four();
    rs[0] = cond("claude", { promptHash: hashCondition("different") });
    expect(assessEligibility({ mode: "parallel", answerType: "BOOLEAN", responses: rs })).toBe(
      "CONDITIONS_VARIED"
    );
  });

  it("prefers 4 participants over the 3-model floor", () => {
    // Not an exclusion — a documented preference. With 3 models a BOOLEAN
    // metric is effectively binary; the 4th adds a third level.
    expect(STUDY_POLICY.PREFERRED_PARTICIPANTS).toBe(4);
    expect(STUDY_POLICY.MIN_PARTICIPANTS).toBeLessThan(STUDY_POLICY.PREFERRED_PARTICIPANTS);
  });
});

describe("divergence computability", () => {
  it("is undefined below 2 participants", () => {
    expect(canComputeDivergence("BOOLEAN", 1)).toBe(false);
    expect(canComputeDivergence("BOOLEAN", 2)).toBe(true);
  });

  it("gates OPEN behind the opt-in flag — embeddings cost money (§9)", () => {
    expect(canComputeDivergence("OPEN", 4)).toBe(STUDY_POLICY.OPEN_DIVERGENCE_ENABLED);
    expect(canComputeDivergence("NUMERIC", 4)).toBe(true); // never gated
  });
});
