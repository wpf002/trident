import chalk, { ChalkInstance } from "chalk";
import ora from "ora";
import { nanoid } from "nanoid";
import { AI_MAP, AIMessage, AIName, AIResponse, DEFAULT_ORDER } from "../lib/clients.js";
import type { ModelTier } from "@trident/core";
import { logSessionRun, SessionRunResponse } from "../lib/db.js";
import { formatRunMarkdown, writeRunOutput } from "../lib/output.js";
import { runDiffSynthesis, runConfidenceScoring, ConfidenceReport } from "../lib/synthesis.js";

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

function aiDisplayName(ai: string): string {
  return (AI_LABELS as Record<string, string>)[ai] ?? ai.toUpperCase();
}

function printConfidenceReport(scoring: {
  report?: ConfidenceReport;
  error?: string;
  raw?: string;
}) {
  console.log(chalk.bold.hex("#6C63FF")("┌─ Confidence Report " + "─".repeat(40)));
  if (scoring.error || !scoring.report) {
    console.log(chalk.red(`  ${scoring.error ?? "No report produced."}`));
    if (scoring.raw) {
      console.log(chalk.gray(`  Raw: ${scoring.raw.slice(0, 200)}${scoring.raw.length > 200 ? "…" : ""}`));
    }
    console.log(chalk.bold.hex("#6C63FF")("└" + "─".repeat(50)) + "\n");
    return;
  }
  const r = scoring.report;
  for (const s of r.scores) {
    const bar = "█".repeat(Math.round(s.confidence / 5)) + "░".repeat(20 - Math.round(s.confidence / 5));
    const color =
      s.confidence >= 75 ? chalk.green : s.confidence >= 50 ? chalk.yellow : chalk.red;
    console.log(
      `  ${chalk.bold(aiDisplayName(s.ai).padEnd(12))} ${color(bar)} ${color(String(s.confidence).padStart(3))}/100`
    );
    console.log(chalk.gray(`    ${s.rationale}`));
  }
  const agreementColor =
    r.agreement === "high" ? chalk.green : r.agreement === "medium" ? chalk.yellow : chalk.red;
  console.log(`\n  ${chalk.gray("Agreement:")} ${agreementColor(r.agreement)}`);
  if (r.consensus.length) {
    console.log(chalk.gray("  Consensus:"));
    for (const c of r.consensus) console.log(`    • ${c}`);
  }
  if (r.disagreement.length) {
    console.log(chalk.gray("  Disagreement:"));
    for (const d of r.disagreement) console.log(`    • ${d}`);
  }
  console.log(chalk.bold.hex("#6C63FF")("└" + "─".repeat(50)) + "\n");
}

function formatConfidenceReportMarkdown(report: ConfidenceReport): string {
  const lines: string[] = [];
  lines.push("| AI | Confidence | Rationale |");
  lines.push("|---|---|---|");
  for (const s of report.scores) {
    const safeRationale = s.rationale.replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${aiDisplayName(s.ai)} | ${s.confidence}/100 | ${safeRationale} |`);
  }
  lines.push("");
  lines.push(`**Overall agreement:** ${report.agreement}`);
  if (report.consensus.length) {
    lines.push("");
    lines.push("**Consensus:**");
    for (const c of report.consensus) lines.push(`- ${c}`);
  }
  if (report.disagreement.length) {
    lines.push("");
    lines.push("**Disagreement:**");
    for (const d of report.disagreement) lines.push(`- ${d}`);
  }
  return lines.join("\n");
}

export interface ParallelRunResult {
  id: string;
  prompt: string;
  ais: AIName[];
  results: AIResponse[];
  responses: SessionRunResponse[];
  started_at: string;
  finished_at: string;
  duration_ms: number;
  system_prompt: string | undefined;
}

export async function runParallel(
  prompt: string,
  options: {
    ais?: AIName[];
    system?: string;
    history?: AIMessage[];
    quiet?: boolean;
    persist?: boolean;
    metadata?: Record<string, unknown>;
    output?: string;
    diff?: boolean;
    score?: boolean;
    tier?: ModelTier;
  } = {}
): Promise<ParallelRunResult> {
  const ais = options.ais ?? DEFAULT_ORDER;
  const messages: AIMessage[] = [
    ...(options.history ?? []),
    { role: "user", content: prompt },
  ];

  if (!options.quiet) {
    console.log("\n" + chalk.bold.white("━".repeat(60)));
    console.log(chalk.bold.white("  TRIDENT — PARALLEL MODE"));
    console.log(chalk.bold.white("━".repeat(60)));
    console.log(chalk.gray(`  Prompt: ${prompt.slice(0, 80)}${prompt.length > 80 ? "…" : ""}`));
    console.log(chalk.bold.white("━".repeat(60)) + "\n");
  }

  const runId = nanoid(12);
  const startedAt = new Date().toISOString();
  const runStart = Date.now();

  const responses: SessionRunResponse[] = [];

  // Per-AI live character counters shown on a single rewrite line. Cleaner
  // than interleaving each AI's tokens to stdout when 3 calls are in flight.
  const liveChars: Record<string, number> = {};
  for (const ai of ais) liveChars[ai] = 0;
  let liveActive = ais.length;
  const renderLive = () => {
    if (options.quiet) return;
    const parts = ais.map((ai) => {
      const color = AI_COLORS[ai] ?? chalk.white;
      const label = AI_LABELS[ai] ?? ai;
      const status = responses.find((r) => r.ai === ai)
        ? "✓"
        : liveChars[ai] > 0
        ? `${liveChars[ai]}c`
        : "…";
      return color(`${label} ${status}`);
    });
    process.stdout.write(`\r  ${parts.join("  ")}  ${chalk.gray(`(${liveActive} active)`)}     `);
  };
  renderLive();
  const results = await Promise.all(
    ais.map(async (ai) => {
      const aiStart = Date.now();
      const aiStartedAt = new Date().toISOString();
      const result = await AI_MAP[ai](messages, options.system, {
        tier: options.tier ?? "main",
        tokens: options.quiet
          ? undefined
          : (chunk) => {
              liveChars[ai] += chunk.length;
              renderLive();
            },
      });
      const aiFinishedAt = new Date().toISOString();
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
      liveActive -= 1;
      renderLive();
      return result;
    })
  );

  if (!options.quiet) {
    process.stdout.write("\r" + " ".repeat(100) + "\r");
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - runStart;

  for (const result of results) {
    const ai = result.ai as AIName;
    const color = AI_COLORS[ai] ?? chalk.white;
    const label = AI_LABELS[ai] ?? result.ai.toUpperCase();

    if (!options.quiet) {
      console.log(color.bold(`┌─ ${label} (${result.duration_ms}ms) ${"─".repeat(40 - label.length)}`));
    }

    if (result.error) {
      console.log(chalk.red(`  Error: ${result.error}`));
    } else {
      const lines = result.content.split("\n");
      for (const line of lines) {
        console.log(options.quiet ? line : `  ${line}`);
      }
    }

    if (!options.quiet) {
      console.log(color.bold("└" + "─".repeat(50)) + "\n");
    }
  }

  const extraSections: { title: string; body: string }[] = [];
  const metadata: Record<string, unknown> = { ...(options.metadata ?? {}) };

  if (options.diff) {
    const spin = options.quiet
      ? null
      : ora({ text: "Synthesizing diff with Claude…", color: "white" }).start();
    const diff = await runDiffSynthesis(prompt, responses);
    spin?.stop();
    if (!options.quiet) {
      console.log(chalk.bold.hex("#D4A017")("┌─ Synthesis " + "─".repeat(48)));
      if (diff.error) {
        console.log(chalk.red(`  ${diff.error}`));
      } else {
        const lines = diff.content.split("\n");
        for (const line of lines) console.log(`  ${line}`);
      }
      console.log(chalk.bold.hex("#D4A017")("└" + "─".repeat(50)) + "\n");
    }
    if (!diff.error) {
      extraSections.push({ title: "Synthesis", body: diff.content });
      metadata.synthesis = { content: diff.content, duration_ms: diff.duration_ms };
    } else {
      metadata.synthesis_error = diff.error;
    }
  }

  if (options.score) {
    const spin = options.quiet
      ? null
      : ora({ text: "Scoring confidence with Claude…", color: "white" }).start();
    const scoring = await runConfidenceScoring(prompt, responses);
    spin?.stop();
    if (!options.quiet) {
      printConfidenceReport(scoring);
    }
    if (scoring.report) {
      extraSections.push({
        title: "Confidence Report",
        body: formatConfidenceReportMarkdown(scoring.report),
      });
      metadata.confidence = scoring.report;
    } else if (scoring.error) {
      metadata.confidence_error = scoring.error;
      if (scoring.raw) metadata.confidence_raw = scoring.raw;
    }
  }

  if (options.persist !== false) {
    try {
      logSessionRun({
        id: runId,
        mode: "parallel",
        prompt,
        project: null,
        ais,
        responses,
        duration_ms: durationMs,
        preset: null,
        system_prompt: options.system ?? null,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
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
      const md = formatRunMarkdown(
        {
          mode: "parallel",
          id: runId,
          prompt,
          ais,
          responses,
          started_at: startedAt,
          finished_at: finishedAt,
          duration_ms: durationMs,
          system_prompt: options.system,
        },
        extraSections
      );
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
    ais,
    results,
    responses,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
    system_prompt: options.system,
  };
}
