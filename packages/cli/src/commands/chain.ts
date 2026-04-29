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

// Preset chain configs for common workflows
export const CHAIN_PRESETS: Record<string, { order: AIName[]; description: string; systemPrompts?: Partial<Record<AIName, string>> }> = {
  "draft-refine-verify": {
    order: ["claude", "gpt", "perplexity"],
    description: "Claude drafts → GPT refines → Perplexity fact-checks with live search",
    systemPrompts: {
      claude: "You are drafting an initial response. Be thorough and well-structured.",
      gpt: "You are refining a draft. Improve clarity, flow, and completeness. The previous draft is provided as context.",
      perplexity: "You are fact-checking and enriching a refined response with current, accurate information. Flag anything outdated or incorrect.",
    },
  },
  "research-analyze-summarize": {
    order: ["perplexity", "claude", "gpt"],
    description: "Perplexity researches → Claude analyzes → GPT summarizes",
    systemPrompts: {
      perplexity: "Research this topic thoroughly using your web access. Provide sources.",
      claude: "Analyze the research provided. Extract key insights and identify patterns.",
      gpt: "Create a concise, actionable summary of the analysis. Bullet key takeaways.",
    },
  },
  "attack-defend-judge": {
    order: ["gpt", "claude", "perplexity"],
    description: "GPT argues for → Claude argues against → Perplexity judges",
    systemPrompts: {
      gpt: "Argue strongly in FAVOR of the proposition provided. Steel-man the position.",
      claude: "Argue strongly AGAINST the proposition provided. Steel-man the opposition.",
      perplexity: "Judge both arguments fairly using evidence and reasoning. Provide a balanced verdict.",
    },
  },
};

export async function runChain(
  prompt: string,
  options: {
    order?: AIName[];
    preset?: string;
    system?: string;
    showIntermediate?: boolean;
  } = {}
) {
  let order: AIName[];
  let systemPrompts: Partial<Record<AIName, string>> = {};

  if (options.preset && CHAIN_PRESETS[options.preset]) {
    const preset = CHAIN_PRESETS[options.preset];
    order = preset.order;
    systemPrompts = preset.systemPrompts ?? {};
    console.log(chalk.gray(`\n  Using preset: ${options.preset} — ${preset.description}\n`));
  } else {
    order = options.order ?? DEFAULT_ORDER;
  }

  console.log("\n" + chalk.bold.white("━".repeat(60)));
  console.log(chalk.bold.white("  TRIDENT — CHAIN MODE"));
  console.log(chalk.bold.white("━".repeat(60)));
  console.log(chalk.gray(`  Order: ${order.map((a) => AI_LABELS[a]).join(" → ")}`));
  console.log(chalk.gray(`  Prompt: ${prompt.slice(0, 80)}${prompt.length > 80 ? "…" : ""}`));
  console.log(chalk.bold.white("━".repeat(60)) + "\n");

  const allResults = [];
  const conversationHistory: AIMessage[] = [{ role: "user", content: prompt }];

  for (let i = 0; i < order.length; i++) {
    const ai = order[i];
    const color = AI_COLORS[ai] ?? chalk.white;
    const label = AI_LABELS[ai] ?? ai;
    const isLast = i === order.length - 1;

    const spinner = ora({
      text: `${label} thinking…`,
      color: "white",
    }).start();

    // Build context: include previous AI outputs as part of the conversation
    const contextMessages: AIMessage[] = [...conversationHistory];

    if (i > 0) {
      // Remind the AI of its role in the chain
      const prevLabel = AI_LABELS[order[i - 1]];
      contextMessages.push({
        role: "user",
        content: `The above was ${prevLabel}'s response. Now it's your turn in the chain.`,
      });
    }

    const systemPrompt =
      systemPrompts[ai] ??
      options.system ??
      (i === 0
        ? "You are the first AI in a chain. Provide a thorough initial response."
        : i === order.length - 1
        ? "You are the final AI in a chain. Synthesize all previous responses into a definitive answer."
        : "You are in the middle of a chain. Build on the previous response.");

    const result = await AI_MAP[ai](contextMessages, systemPrompt);
    spinner.stop();

    allResults.push(result);

    console.log(color.bold(`┌─ ${label} (${result.duration_ms}ms) — Step ${i + 1}/${order.length} ${"─".repeat(25 - label.length)}`));

    if (result.error) {
      console.log(chalk.red(`  Error: ${result.error}`));
      console.log(color.bold("└" + "─".repeat(50)) + "\n");
      // Skip this AI's output from history but continue chain
      continue;
    }

    if (options.showIntermediate || isLast) {
      const lines = result.content.split("\n");
      for (const line of lines) {
        console.log(`  ${line}`);
      }
    } else {
      console.log(chalk.gray("  [output passed to next AI — use --show-intermediate to display]"));
    }
    console.log(color.bold("└" + "─".repeat(50)) + "\n");

    // Add this AI's output to the conversation history for the next AI
    conversationHistory.push({ role: "assistant", content: result.content });
  }

  return allResults;
}

export function listPresets() {
  console.log("\n" + chalk.bold.white("Available chain presets:\n"));
  for (const [key, preset] of Object.entries(CHAIN_PRESETS)) {
    console.log(chalk.hex("#D4A017").bold(`  ${key}`));
    console.log(chalk.gray(`    ${preset.description}`));
    console.log(chalk.gray(`    Order: ${preset.order.map((a) => AI_LABELS[a]).join(" → ")}\n`));
  }
}
