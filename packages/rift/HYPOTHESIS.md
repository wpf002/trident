# Rift — Preregistration v1

**Status: SEALED.** Committed before any data was scored.

This document fixes the claim, the metric, the baselines, the sample size, and
the rejection threshold **in advance**. It is not revised after seeing results.
If the design must change, a new preregistration (`HYPOTHESIS-v2.md`) is written
and this file is kept unchanged alongside it, with the reason for superseding
stated in the new file.

- **Sealed at:** 2026-08-07
- **Sealed by commit:** the commit that adds this file
- **Supersedes:** nothing
- **Superseded by:** nothing

---

## 1. Hypothesis

> **H1.** Disagreement across independently-queried models predicts whether an
> answer is wrong better than model-reported confidence does.

**H0 (null).** Divergence is no better than the confidence baseline at
discriminating correct from incorrect answers.

## 2. The outcome variable

For each resolved query, the binary outcome is:

> **`plurality_wrong`** — the answer Trident would have shipped is incorrect.

The shipped answer is the **plurality** of the models' parsed answers
(ties broken by lowest model index in a fixed, preregistered model order:
`claude, gpt, perplexity, gemini`). This is the outcome that matters: routing
and gating act on the answer that would otherwise have gone out, so that is what
the predictor must predict.

Secondary outcome, reported but not primary: **`any_wrong`** — at least one
model incorrect.

For `NUMERIC`/`ORDINAL`, "incorrect" means outside the per-domain tolerance
declared in §6 before scoring.

## 3. Primary metric

> **AUROC of divergence predicting `plurality_wrong`.**

Reported pooled and per stratum. Confidence intervals by DeLong; paired
comparisons between predictors by DeLong's test for correlated ROC curves.

Secondary metrics, reported for every predictor: **Brier score**, **log loss**,
and a **reliability diagram** (10 equal-count bins).

## 4. Baselines — what divergence must beat

| # | Predictor | Note |
|---|---|---|
| B0 | Constant (always predicts the base rate) | AUROC 0.5 by construction |
| B1 | **Judge confidence, mean across models** | ⚠️ Circular — see below |
| B2 | **Judge confidence of the plurality-answer model** | ⚠️ Circular |
| B3 | Self-reported confidence, mean across models | Only if elicited; `NULL` by default |

**B1/B2 carry a disclosure that must appear in every report:** Trident's
confidence number is produced by a *separate Claude pass that scores all
responses* — a third-party judge, and the judge (`claude-haiku-4-5`) is from the
same family as one of the models under measurement. It is **not** self-reported
confidence. It is used because it is free and already computed, and its
circularity is a known limitation of the comparison, not a hidden one.

B3 is the clean comparator but costs output tokens and changes the prompt
(violating §9 zero-added-cost and §3 held-fixed against existing runs). It stays
`NULL` unless a future preregistration turns it on.

**If only B0 and B1/B2 are available, the strongest claim available is
"divergence beats a circular judge baseline and a constant" — and it must be
worded that way.**

## 5. Minimum sample sizes

No claim is made below these thresholds. They are counts of **resolved queries
in the study set** (isolation verified, no exclusion reason, resolution passing
the leakage guard).

| Scope | Minimum n | Rationale |
|---|---|---|
| Pooled (any claim at all) | **500** | At an expected 25–35% error rate this yields ≈125–175 positives, enough to separate AUROC 0.65 from 0.50 at 80% power |
| Per-domain claim | **150** | Below this, per-domain AUROC CIs are too wide to act on |
| Per-answer-type claim | **150** | Same |

Divergence values are **never compared across answer types** (§4). Strata are
reported separately; a pooled number never substitutes for a stratum.

## 6. Numeric tolerance

Declared before scoring, not tuned after:

| Domain | `NUMERIC` correct iff |
|---|---|
| RACING / SPORTS | Exact match on discrete outcomes; within 1 place for finishing position |
| FINANCE | Within ±5% of the resolved value |
| GENERAL | Within ±5% of the resolved value |

`ORDINAL` is correct iff the full predicted ordering matches; partial credit is
reported as Kendall's tau but is not the correctness criterion.

## 7. Rejection threshold — how H1 dies

**H1 is rejected unless ALL of the following hold on the pooled study set at
n ≥ 500:**

1. **Beats chance:** divergence AUROC ≥ **0.65**, with the 95% CI lower bound
   strictly above 0.50.
2. **Beats the confidence baseline:** divergence AUROC exceeds the best
   available confidence baseline (B1/B2, or B3 if elicited) by ≥ **0.05**, with
   a paired DeLong test at **p < 0.05**.
3. **Calibratable:** the reliability diagram is monotone across bins — higher
   divergence must correspond to a higher observed error rate. A non-monotone
   curve means no threshold can be derived, which makes the signal unusable for
   routing even if AUROC looks good.

**Any of these failing ⇒ H1 is rejected and Rift is killed in writing**
(`VERDICT.md`, stating which criterion failed and the observed numbers).

## 8. The kill switch that overrides everything

> **Correlated-error veto.** Among queries in the **lowest divergence tercile**,
> if the `plurality_wrong` rate exceeds **20%**, the signal is declared
> **unusable for gating regardless of AUROC**.

This is the failure mode that matters most and the one a headline AUROC hides:
these models share training data, so they can agree confidently and all be
wrong. A gate that waves through confident-and-wrong answers is worse than no
gate, because it launders error as consensus.

This rate is reported as a **first-class result on the first page of every
report**, never as a footnote. If the veto fires, the report says so in its
first paragraph.

## 9. What is out of scope for this preregistration

- No routing, gating, or threshold selection is derived here. Those are Phase 7
  and are gated on the Phase 6 verdict.
- Thresholds, if H1 survives, are derived from the calibration curve per domain —
  never hand-picked.
- A model-as-judge for `OPEN` semantic equivalence is **not** a primary method.
  If used at all it is secondary, and only after validating ≥90% agreement on
  ≥200 hand-labeled pairs; below that it is discarded (§4).

## 10. Analysis integrity

- Scoring is computed by code committed **before** the resolutions it scores.
- Every report artifact records: the preregistration file hash, the code commit,
  the study-set query ids, and the exclusion counts by reason.
- Excluded queries are reported with their reasons. An exclusion rate that
  changes materially between runs is itself a finding and must be explained.
- No predictor is added, no metric swapped, and no stratum dropped after seeing
  results. Post-hoc analyses are permitted but must be labeled **exploratory**
  and cannot support a confirmatory claim.
