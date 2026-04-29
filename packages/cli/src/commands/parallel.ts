import chalk from "chalk";
import ora from "ora";
import { AI_MAP, AIMessage, AIName, DEFAULT_ORDER } from "../lib/clients.js";

const AI_COLORS: Record<AIName, chalk.Chalk> = {
  claude: chalk.hex("#D4A017"),
  gpt: chalk.hex("#10A37F"),
  perplexity: chalk.hex("#6C63FF"),
};

const AI_LABELS: Record<AIName, string> = {
  claude: "Claude",
  gpt: "ChatGPT",
  perplexity: "Perplexity",
};

export async function runParallel(
  prompt: string,
  options: {
    ais?: AIName[];
    system?: string;
    history?: AIMessage[];
    quiet?: boolean;
  } = {}
) {
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

  const spinner = options.quiet
    ? null
    : ora({
        text: `Querying ${ais.map((a) => AI_LABELS[a]).join(", ")} in parallel…`,
        color: "white",
      }).start();

  const results = await Promise.all(
    ais.map((ai) => AI_MAP[ai](messages, options.system))
  );

  spinner?.stop();

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

  return results;
}
