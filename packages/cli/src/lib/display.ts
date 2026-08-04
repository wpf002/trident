import chalk, { ChalkInstance } from "chalk";
import { AIName } from "@trident/core";

// Single CLI-side source for AI presentation. Labels live in @trident/core
// (pure data); the chalk colors are CLI-only and live here.
export { AI_LABELS, aiLabel } from "@trident/core";

export const AI_COLORS: Record<AIName, ChalkInstance> = {
  claude: chalk.hex("#D4A017"),
  gpt: chalk.hex("#10A37F"),
  perplexity: chalk.hex("#6C63FF"),
  gemini: chalk.hex("#5B9BFF"),
};

export function aiColor(ai: string): ChalkInstance {
  return (AI_COLORS as Record<string, ChalkInstance>)[ai] ?? chalk.white;
}
