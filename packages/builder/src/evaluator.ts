// Step evaluator. Utility-tier LLM produces a {verdict, confidence, reason}
// for each completed step. Signals from the verification command (exit code,
// pass/fail counts, etc.) are included in the prompt so the LLM doesn't have
// to re-derive them from raw stdout.

import { callClaude, type AIMessage } from "@trident/core";
import { nanoid } from "nanoid";
import {
  StepEvaluationSchema,
  type BuilderConfig,
  type PlanNode,
  type StepEvaluation,
  type Verification,
} from "./types.js";
import { logBuilderSessionRun } from "./db.js";
import { computeCost } from "./pricing.js";

const EVAL_SYSTEM = `You evaluate whether a coding-agent step achieved its intent.

Output STRICT JSON:
{
  "verdict": "pass" | "fail" | "partial",
  "confidence": number between 0 and 1,
  "reason": "one-sentence justification",
  "signals": { (optional) }
}

Rules:
- If a verification command was run and exited non-zero, verdict is "fail" unless the failure is unrelated to the step's intent.
- If tests passed but the code clearly doesn't match the intent, verdict is "partial".
- Confidence reflects evidence quality, not certainty of the verdict.

No prose outside the JSON object.`;

export interface EvaluatorSignals {
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  tests_passed?: number | null;
  tests_failed?: number | null;
}

export interface EvaluatorResult {
  evaluation: StepEvaluation;
  cost: number;
  model: string;
  session_id: string;
}

export async function evaluateStep(opts: {
  buildId: string;
  step: PlanNode;
  config: BuilderConfig;
  diff: string;
  toolTrace: Array<{ name: string; input: unknown; output: string }>;
  verification: Verification | null;
  signals: EvaluatorSignals;
}): Promise<EvaluatorResult> {
  const start = new Date().toISOString();
  const t0 = Date.now();

  const userPrompt = `STEP INTENT:
${opts.step.intent}

EXPECTED FILES: ${opts.step.expected_files.join(", ") || "(none specified)"}

VERIFICATION: ${opts.verification ? JSON.stringify(opts.verification) : "(none)"}

VERIFICATION SIGNALS:
${JSON.stringify(opts.signals, null, 2)}

DIFF FROM WORKSPACE (truncated to 4000 chars):
${opts.diff.slice(0, 4000) || "(empty)"}

TOOL CALL TRACE (last 10, truncated):
${opts.toolTrace
  .slice(-10)
  .map(
    (t, i) =>
      `[${i + 1}] ${t.name}(${truncate(JSON.stringify(t.input), 200)}) -> ${truncate(t.output, 200)}`
  )
  .join("\n")}

Return your evaluation as JSON.`;

  const messages: AIMessage[] = [{ role: "user", content: userPrompt }];
  const response = await callClaude(messages, EVAL_SYSTEM, {
    tier: opts.config.tier_evaluator,
  });
  const finished = new Date().toISOString();
  const sessionId = nanoid();
  const model = response.model ?? `claude-${opts.config.tier_evaluator}`;
  const cost = computeCost(model, response.usage);

  logBuilderSessionRun({
    id: sessionId,
    build_id: opts.buildId,
    step_id: opts.step.id,
    phase: "evaluate",
    ai: "claude",
    model,
    prompt: userPrompt,
    response: response.content,
    duration_ms: Date.now() - t0,
    started_at: start,
    finished_at: finished,
    usage: response.usage,
    error: response.error,
  });

  if (response.error) {
    return {
      evaluation: {
        verdict: "fail",
        confidence: 0.0,
        reason: `evaluator call failed: ${response.error}`,
        signals: {},
      },
      cost,
      model,
      session_id: sessionId,
    };
  }

  let parsed: StepEvaluation;
  try {
    const fence = response.content.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    const candidate = fence ? fence[1] : response.content;
    parsed = StepEvaluationSchema.parse(JSON.parse(candidate));
  } catch (err) {
    parsed = {
      verdict: "fail",
      confidence: 0.0,
      reason: `evaluator returned unparseable output: ${(err as Error).message}`,
      signals: {},
    };
  }

  // Hard override: if verification exit code is non-zero, force fail.
  if (
    opts.signals.exit_code !== undefined &&
    opts.signals.exit_code !== 0 &&
    parsed.verdict === "pass"
  ) {
    parsed = {
      ...parsed,
      verdict: "fail",
      reason: `verification command exited ${opts.signals.exit_code}; evaluator said pass but signals say fail`,
    };
  }

  return { evaluation: parsed, cost, model, session_id: sessionId };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
