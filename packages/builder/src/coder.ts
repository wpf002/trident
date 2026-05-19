// Coder phase. The main-tier LLM (Sonnet by default) runs a native tool-use
// loop against the BUILDER_TOOLS schemas. Each tool invocation is executed
// in-process via executeTool(), the result fed back as a tool_result block,
// and the loop continues until stop_reason is "end_turn" or a per-step cap
// is reached.

import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { modelFor } from "@trident/core";
import type { Sandbox } from "@trident/builder-runtime";
import type { BuilderConfig, PlanNode } from "./types.js";
import { BUILDER_TOOLS, executeTool } from "./tools.js";
import { logBuilderSessionRun } from "./db.js";
import { computeCost } from "./pricing.js";

const CODER_SYSTEM = `You are an autonomous coding agent operating inside a sandboxed git worktree.

You can call tools to read, write, and edit files; run shell commands; and check tests/types. Operate only via tools — do not narrate.

For the current step:
1. Call build_workspace_root once to orient.
2. Read any relevant existing files before editing.
3. Make the minimal change required by the step's intent.
4. Run the step's verification if provided (test_run / shell_exec / typecheck).
5. When the verification passes (or you've made the requested change with no verification available), stop. Do NOT commit — the loop handles that.

Hard rules:
- Never delete files outside the step's intent.
- Never push to remotes; never use git push at all.
- Never call sudo or any destructive root-level command.`;

const MAX_TOOL_ITERATIONS = 30;
const MAX_OUTPUT_TOKENS_DEFAULT = 4096;

export interface ToolTraceEntry {
  name: string;
  input: unknown;
  output: string;
}

export interface CoderResult {
  iterations: number;
  stop_reason: string | null;
  cost: number;
  model: string;
  session_id: string;
  tool_trace: ToolTraceEntry[];
  final_text: string;
}

export async function runCoder(opts: {
  buildId: string;
  step: PlanNode;
  attempt: number;
  config: BuilderConfig;
  sandbox: Sandbox;
  refineContext?: string;
  maxIterations?: number;
}): Promise<CoderResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const client = new Anthropic({ apiKey });
  const model = modelFor("claude", opts.config.tier_coder);
  const maxIterations = opts.maxIterations ?? MAX_TOOL_ITERATIONS;
  const start = new Date().toISOString();
  const t0 = Date.now();
  const sessionId = nanoid();
  const trace: ToolTraceEntry[] = [];

  const userPrompt = composeUserPrompt(opts.step, opts.attempt, opts.refineContext);
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userPrompt },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastResponse: Anthropic.Message | undefined;
  let stopReason: string | null = null;
  let iter = 0;
  let finalText = "";

  while (iter < maxIterations) {
    iter++;
    const response = await client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS_DEFAULT,
      system: CODER_SYSTEM,
      tools: BUILDER_TOOLS as unknown as Anthropic.Tool[],
      messages,
    });
    lastResponse = response;
    stopReason = response.stop_reason ?? null;
    if (response.usage) {
      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    const texts = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );
    if (texts.length) finalText = texts.map((t) => t.text).join("\n");

    if (toolUses.length === 0 || stopReason !== "tool_use") {
      break;
    }

    // Append assistant response, then run tools and append tool_result.
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const output = await executeTool(
        tu.name,
        (tu.input as Record<string, unknown>) ?? {},
        opts.sandbox
      );
      trace.push({ name: tu.name, input: tu.input, output });
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: truncateForTool(output),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  const finished = new Date().toISOString();
  const usage = { input_tokens: totalInputTokens, output_tokens: totalOutputTokens };
  const cost = computeCost(model, usage);

  logBuilderSessionRun({
    id: sessionId,
    build_id: opts.buildId,
    step_id: opts.step.id,
    phase: `code:attempt-${opts.attempt}`,
    ai: "claude",
    model,
    prompt: userPrompt,
    response:
      finalText ||
      JSON.stringify(lastResponse?.content ?? []).slice(0, 2000),
    duration_ms: Date.now() - t0,
    started_at: start,
    finished_at: finished,
    usage,
  });

  return {
    iterations: iter,
    stop_reason: stopReason,
    cost,
    model,
    session_id: sessionId,
    tool_trace: trace,
    final_text: finalText,
  };
}

function composeUserPrompt(
  step: PlanNode,
  attempt: number,
  refineContext: string | undefined
): string {
  const lines: string[] = [];
  lines.push(`STEP (attempt ${attempt}):`);
  lines.push(step.intent);
  if (step.expected_files.length) {
    lines.push(``);
    lines.push(`EXPECTED FILES: ${step.expected_files.join(", ")}`);
  }
  if (step.verification) {
    lines.push(``);
    lines.push(`VERIFICATION: ${JSON.stringify(step.verification)}`);
  }
  if (refineContext) {
    lines.push(``);
    lines.push(`PRIOR ATTEMPT FAILED:`);
    lines.push(refineContext);
    lines.push(``);
    lines.push(`Address that failure on this attempt.`);
  }
  return lines.join("\n");
}

function truncateForTool(s: string, max = 16_000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}
