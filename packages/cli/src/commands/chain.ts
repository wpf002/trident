import chalk, { ChalkInstance } from "chalk";
import { nanoid } from "nanoid";
import { AI_MAP, AIMessage, AIName, AIResponse, DEFAULT_ORDER } from "../lib/clients.js";
import { CHAIN_PRESETS } from "@trident/core";
import type { ModelTier } from "@trident/core";
import { logSessionRun, SessionRunResponse } from "../lib/db.js";
import { buildProjectContextBlock } from "../lib/context.js";
import { formatRunMarkdown, writeRunOutput } from "../lib/output.js";

export { CHAIN_PRESETS };

const AI_COLORS: Record<AIName, ChalkInstance> = {
  claude: chalk.hex("#D4A017"),
  gpt: chalk.hex("#10A37F"),
  perplexity: chalk.hex("#6C63FF"),
};

const AI_LABELS: Record<AIName, string> = {
  claude: "Claude",
  gpt: "ChatGPT",
  perplexity: "Perplexity",
};

export interface ChainRunResult {
  id: string;
  prompt: string;
  order: AIName[];
  results: AIResponse[];
  responses: SessionRunResponse[];
  started_at: string;
  finished_at: string;
  duration_ms: number;
  preset: string | undefined;
  system_prompt: string | undefined;
  project: string | undefined;
}

export async function runChain(
  prompt: string,
  options: {
    order?: AIName[];
    preset?: string;
    system?: string;
    showIntermediate?: boolean;
    project?: string;
    persist?: boolean;
    quiet?: boolean;
    metadata?: Record<string, unknown>;
    output?: string;
    tier?: ModelTier;
  } = {}
): Promise<ChainRunResult> {
  let order: AIName[];
  let systemPrompts: Partial<Record<AIName, string>> = {};

  if (options.preset && CHAIN_PRESETS[options.preset]) {
    const preset = CHAIN_PRESETS[options.preset];
    order = preset.order;
    systemPrompts = preset.systemPrompts ?? {};
    if (!options.quiet) {
      console.log(chalk.gray(`\n  Using preset: ${options.preset} — ${preset.description}\n`));
    }
  } else {
    order = options.order ?? DEFAULT_ORDER;
  }

  const projectBlock = options.project ? buildProjectContextBlock(options.project) : null;

  if (!options.quiet) {
    console.log("\n" + chalk.bold.white("━".repeat(60)));
    console.log(chalk.bold.white("  TRIDENT — CHAIN MODE"));
    console.log(chalk.bold.white("━".repeat(60)));
    console.log(chalk.gray(`  Order: ${order.map((a) => AI_LABELS[a]).join(" → ")}`));
    console.log(chalk.gray(`  Prompt: ${prompt.slice(0, 80)}${prompt.length > 80 ? "…" : ""}`));
    if (options.project) {
      console.log(chalk.gray(`  Project: ${options.project}${projectBlock ? " (context injected)" : " (no entries)"}`));
    }
    console.log(chalk.bold.white("━".repeat(60)) + "\n");
  }

  const runId = nanoid(12);
  const startedAt = new Date().toISOString();
  const runStart = Date.now();

  const allResults: AIResponse[] = [];
  const responses: SessionRunResponse[] = [];
  const conversationHistory: AIMessage[] = [{ role: "user", content: prompt }];

  for (let i = 0; i < order.length; i++) {
    const ai = order[i];
    const color = AI_COLORS[ai] ?? chalk.white;
    const label = AI_LABELS[ai] ?? ai;
    const isLast = i === order.length - 1;

    const contextMessages: AIMessage[] = [...conversationHistory];

    if (i > 0) {
      const prevLabel = AI_LABELS[order[i - 1]];
      contextMessages.push({
        role: "user",
        content: `The above was ${prevLabel}'s response. Now it's your turn in the chain.`,
      });
    }

    const baseSystemPrompt =
      systemPrompts[ai] ??
      options.system ??
      (i === 0
        ? "You are the first AI in a chain. Provide a thorough initial response."
        : i === order.length - 1
        ? "You are the final AI in a chain. Synthesize all previous responses into a definitive answer."
        : "You are in the middle of a chain. Build on the previous response.");

    const systemPrompt = projectBlock
      ? `${projectBlock}\n\n---\n\n${baseSystemPrompt}`
      : baseSystemPrompt;

    const showLive = !options.quiet && (options.showIntermediate || isLast);
    if (showLive) {
      console.log(color.bold(`┌─ ${label} (streaming) — Step ${i + 1}/${order.length} ${"─".repeat(25 - label.length)}`));
      process.stdout.write("  ");
    } else if (!options.quiet) {
      process.stdout.write(chalk.gray(`  ${label} thinking…`));
    }

    const aiStart = Date.now();
    const aiStartedAt = new Date().toISOString();
    // Already wrote the leading 2-space indent above for showLive; treat
    // first character as continuation of an in-progress line.
    let lineEndedWithNewline = false;
    const result = await AI_MAP[ai](contextMessages, systemPrompt, {
      tier: options.tier ?? "main",
      tokens: showLive
        ? (chunk) => {
            // Indent continuation lines so streamed output stays inside the box.
            for (const ch of chunk) {
              if (lineEndedWithNewline && ch !== "\n") {
                process.stdout.write("  ");
                lineEndedWithNewline = false;
              }
              process.stdout.write(ch);
              if (ch === "\n") lineEndedWithNewline = true;
            }
          }
        : undefined,
    });
    const aiFinishedAt = new Date().toISOString();

    if (!options.quiet && !showLive) {
      // Wipe the "thinking…" line.
      process.stdout.write("\r" + " ".repeat(60) + "\r");
    }

    allResults.push(result);
    responses.push({
      ai,
      content: result.content,
      error: result.error,
      duration_ms: Date.now() - aiStart,
      started_at: aiStartedAt,
      finished_at: aiFinishedAt,
      model: result.model,
      usage: result.usage,
    });

    if (!options.quiet) {
      if (showLive) {
        if (!lineEndedWithNewline) process.stdout.write("\n");
        if (result.error) {
          console.log(chalk.red(`  Error: ${result.error}`));
        }
        console.log(color.bold("└" + "─".repeat(50)) + ` ${chalk.gray(result.duration_ms + "ms")}\n`);
      } else {
        console.log(color.bold(`┌─ ${label} (${result.duration_ms}ms) — Step ${i + 1}/${order.length} ${"─".repeat(25 - label.length)}`));
        if (result.error) {
          console.log(chalk.red(`  Error: ${result.error}`));
        } else {
          console.log(chalk.gray("  [output passed to next AI — use --show-intermediate to display]"));
        }
        console.log(color.bold("└" + "─".repeat(50)) + "\n");
      }
    }

    if (result.error) {
      continue;
    }

    conversationHistory.push({ role: "assistant", content: result.content });
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - runStart;

  if (options.persist !== false) {
    try {
      logSessionRun({
        id: runId,
        mode: "chain",
        prompt,
        project: options.project ?? null,
        ais: order,
        responses,
        duration_ms: durationMs,
        preset: options.preset ?? null,
        system_prompt: options.system ?? null,
        metadata: options.metadata ?? null,
        started_at: startedAt,
        finished_at: finishedAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!options.quiet) {
        console.log(chalk.gray(`  (session not logged: ${message})`));
      }
    }
  }

  if (options.output) {
    try {
      const md = formatRunMarkdown({
        mode: "chain",
        id: runId,
        prompt,
        order,
        responses,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: durationMs,
        project: options.project,
        preset: options.preset,
        system_prompt: options.system,
      });
      const written = writeRunOutput(options.output, md);
      if (!options.quiet) {
        console.log(chalk.gray(`  Output written: ${written}`));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`  Failed to write output: ${message}`));
    }
  }

  if (!options.quiet) {
    console.log(chalk.gray(`  Session ID: ${runId}  •  ${durationMs}ms total\n`));
  }

  return {
    id: runId,
    prompt,
    order,
    results: allResults,
    responses,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
    preset: options.preset,
    system_prompt: options.system,
    project: options.project,
  };
}

export function listPresets() {
  console.log("\n" + chalk.bold.white("Available chain presets:\n"));
  for (const [key, preset] of Object.entries(CHAIN_PRESETS)) {
    console.log(chalk.hex("#D4A017").bold(`  ${key}`));
    console.log(chalk.gray(`    ${preset.description}`));
    console.log(chalk.gray(`    Order: ${preset.order.map((a) => AI_LABELS[a]).join(" → ")}\n`));
  }
}
