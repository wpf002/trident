// Ingest and Plan phases. Both use the core `callClaude` wrapper — no tool
// use here. Outputs are parsed JSON validated by the Zod schemas in types.ts.

import { callClaude, type AIMessage } from "@trident/core";
import { nanoid } from "nanoid";
import {
  PlannerOutputSchema,
  SpecDigestSchema,
  type BuilderConfig,
  type PlanNode,
  type PlanTree,
  type PlannerOutput,
  type SpecDigest,
} from "./types.js";
import { logBuilderSessionRun } from "./db.js";
import { computeCost } from "./pricing.js";

interface CallTrackingOpts {
  buildId: string;
  phase: string;
  stepId?: string | null;
}

interface PlannerResult<T> {
  data: T;
  cost: number;
  model: string;
  session_id: string;
  raw: string;
}

const INGEST_SYSTEM =
  "You extract structured intent from software specs. Output STRICT JSON matching the schema. No prose.";

const PLAN_SYSTEM = `You are a senior engineer building a step-by-step plan for an autonomous coding agent.

Decompose the spec into a tree:
- milestones (high-level outcomes)
- tasks (each producing a coherent change)
- steps (atomic, verifiable units the agent can complete in one pass)

Every leaf step MUST have:
- intent: one sentence the agent will execute
- expected_files: realistic predictions of files the step will touch
- verification: either {kind:"cmd", command:"..."} (preferred — a shell command that exits 0 iff the step succeeded), {kind:"test", framework?, pattern?}, {kind:"typecheck"}, or {kind:"none"} only when no verification is possible

Prefer 3-12 leaf steps for a typical change. Output STRICT JSON only.`;

export async function ingestSpec(
  specText: string,
  config: BuilderConfig,
  tracking: CallTrackingOpts
): Promise<PlannerResult<SpecDigest>> {
  const userPrompt = `SCHEMA:
{
  "goal": "string",
  "constraints": ["string"],
  "success_criteria": ["string"],
  "inferred_target_files": ["string"],
  "notes": "string"
}

SPEC:
${specText}

Return JSON only.`;
  const messages: AIMessage[] = [{ role: "user", content: userPrompt }];
  return runStructured(SpecDigestSchema, messages, INGEST_SYSTEM, config.tier_evaluator, tracking);
}

export async function generatePlan(
  digest: SpecDigest,
  workspaceMap: string,
  config: BuilderConfig,
  tracking: CallTrackingOpts
): Promise<PlannerResult<PlanTree>> {
  const userPrompt = `GOAL:
${digest.goal}

CONSTRAINTS:
${digest.constraints.map((c) => "- " + c).join("\n") || "(none)"}

SUCCESS CRITERIA:
${digest.success_criteria.map((c) => "- " + c).join("\n") || "(none)"}

WORKSPACE TREE (top-level, depth 2):
${workspaceMap || "(empty workspace)"}

NOTES:
${digest.notes}

SCHEMA:
{
  "root": [
    {
      "kind": "milestone" | "task" | "step",
      "intent": "string",
      "expected_files": ["string"],
      "verification": {"kind":"cmd","command":"..."} | {"kind":"test","framework":"...","pattern":"..."} | {"kind":"typecheck"} | {"kind":"none"} | null,
      "children": [ ... recursive ... ]
    }
  ]
}

Output STRICT JSON only.`;
  const messages: AIMessage[] = [{ role: "user", content: userPrompt }];
  const result = await runStructured(
    PlannerOutputSchema,
    messages,
    PLAN_SYSTEM,
    config.tier_planner,
    tracking
  );
  const tree = attachIds(result.data);
  return { ...result, data: tree };
}

export async function reviseSubPlan(
  digest: SpecDigest,
  failingNode: PlanNode,
  failureContext: string,
  config: BuilderConfig,
  tracking: CallTrackingOpts
): Promise<PlannerResult<PlanTree>> {
  const userPrompt = `The previous plan failed on the following node after ${failingNode.children.length} sub-steps.

NODE INTENT: ${failingNode.intent}
FAILURE CONTEXT:
${failureContext}

The plan was probably wrong, not the implementation. Produce a REVISED subtree that addresses the failure. Keep the same schema. Output strict JSON only.

ORIGINAL GOAL: ${digest.goal}`;
  const messages: AIMessage[] = [{ role: "user", content: userPrompt }];
  const result = await runStructured(
    PlannerOutputSchema,
    messages,
    PLAN_SYSTEM,
    "premium",
    tracking
  );
  return { ...result, data: attachIds(result.data) };
}

// ─── shared LLM-call wrapper ──────────────────────────────────────────────

async function runStructured<T>(
  schema: { parse(input: unknown): T },
  messages: AIMessage[],
  system: string,
  tier: BuilderConfig["tier_planner"],
  tracking: CallTrackingOpts
): Promise<PlannerResult<T>> {
  const start = new Date().toISOString();
  const t0 = Date.now();
  const response = await callClaude(messages, system, { tier });
  const finished = new Date().toISOString();
  const sessionId = nanoid();
  const model = response.model ?? `claude-${tier}`;
  const cost = computeCost(model, response.usage);
  logBuilderSessionRun({
    id: sessionId,
    build_id: tracking.buildId,
    step_id: tracking.stepId ?? null,
    phase: tracking.phase,
    ai: "claude",
    model,
    prompt: messages[messages.length - 1].content,
    response: response.content,
    duration_ms: Date.now() - t0,
    started_at: start,
    finished_at: finished,
    usage: response.usage,
    error: response.error,
  });
  if (response.error) {
    throw new Error(`${tracking.phase} call failed: ${response.error}`);
  }
  const json = extractJson(response.content);
  return {
    data: schema.parse(json),
    cost,
    model,
    session_id: sessionId,
    raw: response.content,
  };
}

function extractJson(text: string): unknown {
  // Strip markdown fences if the model wrapped output despite the
  // instruction.
  const fence = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const candidate = fence ? fence[1] : text;
  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new Error(
      `model output is not valid JSON: ${(err as Error).message}\n---\n${candidate.slice(0, 500)}`
    );
  }
}

function attachIds(out: PlannerOutput): PlanTree {
  let ordinal = 0;
  function visit(node: PlannerOutput["root"][number], parentId: string | null): PlanNode {
    const id = nanoid(10);
    const ord = ordinal++;
    return {
      id,
      kind: node.kind,
      ordinal: ord,
      parent_id: parentId,
      intent: node.intent,
      expected_files: node.expected_files,
      verification: node.verification,
      children: node.children.map((c) => visit(c, id)),
    };
  }
  return { root: out.root.map((n) => visit(n, null)) };
}
