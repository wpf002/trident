import chalk, { ChalkInstance } from "chalk";
import { listSessionRuns, getSessionRun, SessionRunRecord } from "../lib/db.js";

const AI_COLORS: Record<string, ChalkInstance> = {
  claude: chalk.hex("#D4A017"),
  gpt: chalk.hex("#10A37F"),
  perplexity: chalk.hex("#6C63FF"),
};

const AI_LABELS: Record<string, string> = {
  claude: "Claude",
  gpt: "ChatGPT",
  perplexity: "Perplexity",
};

function aiLabel(ai: string): string {
  return AI_LABELS[ai] ?? ai.toUpperCase();
}

function aiColor(ai: string): ChalkInstance {
  return AI_COLORS[ai] ?? chalk.white;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function sessionsList(opts: {
  limit?: number;
  mode?: "parallel" | "chain";
  project?: string;
}) {
  const runs = listSessionRuns({
    limit: opts.limit,
    mode: opts.mode,
    project: opts.project,
  });

  if (runs.length === 0) {
    console.log(chalk.gray("\n  No sessions found.\n"));
    return;
  }

  console.log("\n" + chalk.bold.white("  Trident Sessions"));
  if (opts.mode || opts.project) {
    const filters: string[] = [];
    if (opts.mode) filters.push(`mode=${opts.mode}`);
    if (opts.project) filters.push(`project=${opts.project}`);
    console.log(chalk.gray(`  Filters: ${filters.join(", ")}`));
  }
  console.log(chalk.gray(`  Showing ${runs.length} most recent\n`));

  for (const run of runs) {
    const ais = run.ais.map(aiLabel).join(", ");
    const projectLabel = run.project ? chalk.gray(` [${run.project}]`) : "";
    const presetLabel = run.preset ? chalk.gray(` <${run.preset}>`) : "";
    const modeColor = run.mode === "parallel" ? chalk.hex("#6C63FF") : chalk.hex("#D4A017");
    let tokIn = 0;
    let tokOut = 0;
    for (const r of run.responses) {
      if (r.usage) {
        tokIn += r.usage.input_tokens;
        tokOut += r.usage.output_tokens;
      }
    }
    const tokSummary = tokIn + tokOut > 0 ? chalk.gray(` • ${tokIn}↑/${tokOut}↓ tok`) : "";
    console.log(
      `  ${chalk.bold.white(run.id)}  ${modeColor(run.mode.padEnd(8))} ${chalk.gray(run.created_at)}${projectLabel}${presetLabel}`
    );
    console.log(`    ${chalk.gray("AIs:")} ${ais}  ${chalk.gray("•")} ${chalk.gray(run.duration_ms + "ms")}${tokSummary}`);
    console.log(`    ${chalk.gray("→")} ${truncate(run.prompt.replace(/\s+/g, " "), 100)}\n`);
  }
}

export function sessionsGet(id: string) {
  const run = getSessionRun(id);
  if (!run) {
    console.log(chalk.red(`\n  Session not found: ${id}\n`));
    process.exitCode = 1;
    return;
  }

  printSession(run);
}

function printSession(run: SessionRunRecord) {
  console.log("\n" + chalk.bold.white("━".repeat(60)));
  console.log(chalk.bold.white(`  Session ${run.id}`));
  console.log(chalk.bold.white("━".repeat(60)));
  console.log(chalk.gray(`  Mode:      ${run.mode}`));
  if (run.preset) console.log(chalk.gray(`  Preset:    ${run.preset}`));
  if (run.project) console.log(chalk.gray(`  Project:   ${run.project}`));
  console.log(chalk.gray(`  AIs:       ${run.ais.map(aiLabel).join(", ")}`));
  console.log(chalk.gray(`  Started:   ${run.started_at}`));
  console.log(chalk.gray(`  Finished:  ${run.finished_at}`));
  console.log(chalk.gray(`  Duration:  ${run.duration_ms}ms`));
  if (run.system_prompt) {
    console.log(chalk.gray(`  System:    ${truncate(run.system_prompt, 80)}`));
  }
  console.log(chalk.bold.white("━".repeat(60)));
  console.log("\n" + chalk.bold.white("  Prompt:"));
  console.log("  " + run.prompt.split("\n").join("\n  "));
  console.log();

  for (const r of run.responses) {
    const color = aiColor(r.ai);
    const label = aiLabel(r.ai);
    const usage = r.usage ? ` ${r.usage.input_tokens}↑/${r.usage.output_tokens}↓ tok` : "";
    const model = r.model ? ` ${r.model}` : "";
    const meta = chalk.gray(`${r.duration_ms}ms${usage}${model}`);
    console.log(color.bold(`┌─ ${label} ${"─".repeat(40 - label.length)}`) + ` ${meta}`);
    if (r.error) {
      console.log(chalk.red(`  Error: ${r.error}`));
    } else {
      const lines = r.content.split("\n");
      for (const line of lines) console.log(`  ${line}`);
    }
    console.log(color.bold("└" + "─".repeat(50)) + "\n");
  }

  if (run.metadata && Object.keys(run.metadata).length > 0) {
    console.log(chalk.bold.white("  Metadata:"));
    console.log("  " + JSON.stringify(run.metadata, null, 2).split("\n").join("\n  "));
    console.log();
  }
}
