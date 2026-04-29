import chalk from "chalk";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { listModels, AI_LABELS } from "@trident/core";
import { listModes } from "../lib/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

export function configShow() {
  console.log("\n" + chalk.bold.white("  Trident — resolved configuration"));
  console.log(chalk.gray("  Run with overrides via env vars or trident.config.json\n"));

  console.log(chalk.bold.white("  Models per tier"));
  console.log(chalk.gray("  ─────────────────────────────────────────────"));
  const rows = listModels();
  const labels = { premium: "premium", main: "main   ", utility: "utility" };
  const tiers = ["premium", "main", "utility"] as const;
  for (const tier of tiers) {
    console.log(`  ${chalk.bold.white(labels[tier])}`);
    for (const row of rows.filter((r) => r.tier === tier)) {
      const envKey = `TRIDENT_${row.ai.toUpperCase()}_${tier.toUpperCase()}_MODEL`;
      const overridden = process.env[envKey] ? chalk.hex("#D4A017")(" (override)") : "";
      console.log(`    ${chalk.gray((AI_LABELS[row.ai] + ":").padEnd(12))} ${row.model}${overridden}`);
    }
    console.log();
  }

  console.log(chalk.bold.white("  Routing modes (trident.config.json)"));
  console.log(chalk.gray("  ─────────────────────────────────────────────"));
  try {
    const modes = listModes();
    for (const { mode, order } of modes) {
      console.log(`  ${chalk.bold.hex("#D4A017")(mode.padEnd(36))} ${order.map((a) => AI_LABELS[a]).join(" → ")}`);
    }
  } catch (err) {
    console.log(chalk.red(`  ${err instanceof Error ? err.message : String(err)}`));
  }
  console.log();

  console.log(chalk.bold.white("  Files"));
  console.log(chalk.gray("  ─────────────────────────────────────────────"));
  const files: Array<{ label: string; path: string; description: string }> = [
    { label: ".env", path: path.join(REPO_ROOT, ".env"), description: "API keys + model overrides" },
    { label: "trident.config.json", path: path.join(REPO_ROOT, "trident.config.json"), description: "Routing modes" },
    { label: "schedules.json", path: path.join(REPO_ROOT, "schedules.json"), description: "Scheduled chains" },
    { label: "credentials.json", path: path.join(REPO_ROOT, "credentials.json"), description: "Google OAuth client" },
    { label: "data/trident.db", path: path.join(REPO_ROOT, "data", "trident.db"), description: "SQLite store (memory + sessions)" },
    { label: "data/google-token.json", path: path.join(REPO_ROOT, "data", "google-token.json"), description: "Google OAuth token" },
  ];
  for (const f of files) {
    const exists = fs.existsSync(f.path);
    const mark = exists ? chalk.green("✓") : chalk.gray("·");
    console.log(`  ${mark}  ${chalk.bold.white(f.label.padEnd(24))} ${chalk.gray(f.description)}`);
  }
  console.log();

  console.log(chalk.bold.white("  API keys"));
  console.log(chalk.gray("  ─────────────────────────────────────────────"));
  const keys: Array<{ env: string; label: string }> = [
    { env: "ANTHROPIC_API_KEY", label: "Claude" },
    { env: "OPENAI_API_KEY", label: "ChatGPT" },
    { env: "PERPLEXITY_API_KEY", label: "Perplexity" },
    { env: "TAVILY_API_KEY", label: "Tavily web search" },
  ];
  for (const k of keys) {
    const set = !!process.env[k.env];
    const mark = set ? chalk.green("✓") : chalk.red("✗");
    const status = set ? chalk.green("configured") : chalk.red("missing");
    console.log(`  ${mark}  ${chalk.bold.white(k.label.padEnd(24))} ${status}`);
  }
  console.log();
}
