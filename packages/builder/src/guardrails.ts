// Cost ceilings, loop detection, escalation triggers.

import type { BuildRow, BuilderConfig, StepEvaluation } from "./types.js";

export type CeilingDecision =
  | { action: "continue" }
  | { action: "warn"; level: "cost_warn" | "step_warn"; current: number; limit: number }
  | { action: "pause"; reason: "cost_max" | "wall_clock_max"; current: number; limit: number };

export function checkCeilings(
  build: BuildRow,
  stepCostUsd: number,
  config: BuilderConfig
): CeilingDecision {
  const { ceilings } = config;
  if (build.cost_usd >= ceilings.cost_usd_max) {
    return {
      action: "pause",
      reason: "cost_max",
      current: build.cost_usd,
      limit: ceilings.cost_usd_max,
    };
  }
  const elapsedMin = (Date.now() - new Date(build.started_at).getTime()) / 60_000;
  if (elapsedMin >= ceilings.wall_clock_max_min) {
    return {
      action: "pause",
      reason: "wall_clock_max",
      current: elapsedMin,
      limit: ceilings.wall_clock_max_min,
    };
  }
  if (stepCostUsd >= ceilings.cost_per_step_warn) {
    return {
      action: "warn",
      level: "step_warn",
      current: stepCostUsd,
      limit: ceilings.cost_per_step_warn,
    };
  }
  if (build.cost_usd >= ceilings.cost_usd_warn) {
    return {
      action: "warn",
      level: "cost_warn",
      current: build.cost_usd,
      limit: ceilings.cost_usd_warn,
    };
  }
  return { action: "continue" };
}

// ─── Loop detection ──────────────────────────────────────────────────────

// Jaccard similarity on shingled tokens — cheap, robust against minor
// rewording in failure reasons.
function shingles(s: string, k = 3): Set<string> {
  const tokens = s.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + k <= tokens.length; i++) {
    out.add(tokens.slice(i, i + k).join(" "));
  }
  if (out.size === 0 && tokens.length) out.add(tokens.join(" "));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const x of a) if (b.has(x)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export interface LoopVerdict {
  looping: boolean;
  kind?: "stuck_on_same_error";
  similarity?: number;
}

export function detectLoop(
  recentEvaluations: StepEvaluation[],
  threshold: number
): LoopVerdict {
  if (recentEvaluations.length < 3) return { looping: false };
  const fails = recentEvaluations.filter((e) => e.verdict === "fail");
  if (fails.length < 3) return { looping: false };

  const shingleSets = fails.slice(-3).map((e) => shingles(e.reason));
  const s1 = jaccard(shingleSets[0], shingleSets[1]);
  const s2 = jaccard(shingleSets[1], shingleSets[2]);
  const s3 = jaccard(shingleSets[0], shingleSets[2]);
  const avg = (s1 + s2 + s3) / 3;
  if (avg >= threshold) {
    return { looping: true, kind: "stuck_on_same_error", similarity: avg };
  }
  return { looping: false, similarity: avg };
}
