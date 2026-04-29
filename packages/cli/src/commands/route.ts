import chalk from "chalk";
import ora from "ora";
import { callClaude } from "../lib/clients.js";
import { listModes, loadConfig } from "../lib/config.js";

const AI_LABELS: Record<string, string> = {
  claude: "Claude",
  gpt: "ChatGPT",
  perplexity: "Perplexity",
};

function aiLabel(ai: string): string {
  return AI_LABELS[ai] ?? ai.toUpperCase();
}

export function routeList() {
  const modes = listModes();
  console.log("\n" + chalk.bold.white("  Trident routing modes\n"));
  for (const { mode, order } of modes) {
    console.log(`  ${chalk.hex("#D4A017").bold(mode)}`);
    console.log(chalk.gray(`    Order: ${order.map(aiLabel).join(" → ")}\n`));
  }
}

interface DetectionResult {
  mode: string;
  confidence: "low" | "medium" | "high";
  reasoning: string;
}

const PROMPT_INSTRUCTIONS = (modes: string[]) =>
  `You are a routing classifier for a multi-AI system called Trident. Given a user prompt, choose which routing mode best fits the work the prompt asks for.

Available modes: ${modes.map((m) => `"${m}"`).join(", ")}.

Respond with a single JSON object and nothing else. The JSON object must have exactly these keys:
- "mode": one of the available modes (string)
- "confidence": "low" | "medium" | "high"
- "reasoning": one short sentence explaining the choice

Do not wrap the JSON in markdown fences. Do not add any text before or after the JSON.`;

function parseDetection(raw: string, validModes: string[]): DetectionResult {
  let text = raw.trim();
  // Strip markdown fences if Claude added them despite instructions.
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) text = fenceMatch[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Could not parse classifier response as JSON. Got:\n${raw}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Classifier response is not an object");
  }
  const obj = parsed as Record<string, unknown>;
  const mode = obj.mode;
  const confidence = obj.confidence;
  const reasoning = obj.reasoning;
  if (typeof mode !== "string" || !validModes.includes(mode)) {
    throw new Error(
      `Classifier returned invalid mode "${String(mode)}". Valid modes: ${validModes.join(", ")}`
    );
  }
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
    throw new Error(`Classifier returned invalid confidence "${String(confidence)}"`);
  }
  if (typeof reasoning !== "string") {
    throw new Error("Classifier response missing reasoning string");
  }
  return { mode, confidence, reasoning };
}

export async function routeDetect(prompt: string) {
  const config = loadConfig();
  const modes = Object.keys(config.routing);

  const spinner = ora({
    text: "Classifying prompt with Claude…",
    color: "white",
  }).start();

  const response = await callClaude(
    [{ role: "user", content: prompt }],
    PROMPT_INSTRUCTIONS(modes),
    { tier: "utility" }
  );

  spinner.stop();

  if (response.error) {
    console.log(chalk.red(`  Error: ${response.error}`));
    process.exitCode = 1;
    return;
  }

  let detection: DetectionResult;
  try {
    detection = parseDetection(response.content, modes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`  ${message}`));
    process.exitCode = 1;
    return;
  }

  const order = config.routing[detection.mode];
  const confidenceColor =
    detection.confidence === "high"
      ? chalk.green
      : detection.confidence === "medium"
      ? chalk.yellow
      : chalk.red;

  console.log("\n" + chalk.bold.white("━".repeat(60)));
  console.log(chalk.bold.white("  TRIDENT — ROUTE DETECTION"));
  console.log(chalk.bold.white("━".repeat(60)));
  console.log(`  ${chalk.gray("Suggested mode:")} ${chalk.bold.hex("#D4A017")(detection.mode)}`);
  console.log(`  ${chalk.gray("Order:         ")} ${order.map(aiLabel).join(" → ")}`);
  console.log(`  ${chalk.gray("Confidence:    ")} ${confidenceColor(detection.confidence)}`);
  console.log(`  ${chalk.gray("Reasoning:     ")} ${detection.reasoning}`);
  console.log(chalk.bold.white("━".repeat(60)));
  console.log(
    chalk.gray(`\n  Run it: trident chain "${prompt.replace(/"/g, '\\"')}" --mode ${detection.mode}\n`)
  );
}
