#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { runParallel } from "./commands/parallel.js";
import { runChain, listPresets } from "./commands/chain.js";
import {
  memoryList,
  memoryGet,
  memorySet,
  memoryRemove,
  memoryProjects,
} from "./commands/memory.js";
import { AIName } from "./lib/clients.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const program = new Command();

program
  .name("trident")
  .description("Multi-AI orchestration: Claude + ChatGPT + Perplexity")
  .version("1.0.0");

// ─── parallel ────────────────────────────────────────────────────────────────

program
  .command("parallel <prompt>")
  .alias("p")
  .description("Fire a prompt at all three AIs simultaneously and compare outputs")
  .option("-a, --ais <ais>", "Comma-separated list of AIs to use (claude,gpt,perplexity)", "claude,gpt,perplexity")
  .option("-s, --system <system>", "System prompt to use for all AIs")
  .action(async (prompt: string, opts) => {
    const ais = opts.ais.split(",").map((a: string) => a.trim()) as AIName[];
    await runParallel(prompt, { ais, system: opts.system });
  });

// ─── chain ───────────────────────────────────────────────────────────────────

program
  .command("chain <prompt>")
  .alias("c")
  .description("Chain AI responses: output of each becomes input to the next")
  .option("-o, --order <order>", "Comma-separated AI order (e.g. claude,gpt,perplexity)")
  .option("-p, --preset <preset>", "Use a named chain preset (run 'trident chain --list-presets')")
  .option("--list-presets", "List available chain presets")
  .option("-s, --system <system>", "Global system prompt (overrides preset)")
  .option("-i, --show-intermediate", "Show intermediate AI outputs (not just final)")
  .action(async (prompt: string, opts) => {
    if (opts.listPresets) {
      listPresets();
      return;
    }

    const order = opts.order
      ? (opts.order.split(",").map((a: string) => a.trim()) as AIName[])
      : undefined;

    await runChain(prompt, {
      order,
      preset: opts.preset,
      system: opts.system,
      showIntermediate: opts.showIntermediate,
    });
  });

// ─── memory ──────────────────────────────────────────────────────────────────

const memCmd = program
  .command("memory")
  .alias("m")
  .description("Manage the shared Trident memory store");

memCmd
  .command("list")
  .alias("ls")
  .description("List all memory entries")
  .option("-p, --project <project>", "Filter by project namespace")
  .action((opts) => {
    memoryList(opts.project);
  });

memCmd
  .command("get <key>")
  .description("Get a memory value by key")
  .option("-p, --project <project>", "Project namespace (default: global)")
  .action((key: string, opts) => {
    memoryGet(key, opts.project);
  });

memCmd
  .command("set <key> <value>")
  .description("Write a value to memory")
  .option("-p, --project <project>", "Project namespace (default: global)")
  .action((key: string, value: string, opts) => {
    memorySet(key, value, opts.project ?? "global");
  });

memCmd
  .command("delete <key>")
  .alias("rm")
  .description("Delete a memory entry")
  .option("-p, --project <project>", "Project namespace (default: global)")
  .action((key: string, opts) => {
    memoryRemove(key, opts.project ?? "global");
  });

memCmd
  .command("projects")
  .description("List all project namespaces")
  .action(() => {
    memoryProjects();
  });

// ─── presets ─────────────────────────────────────────────────────────────────

program
  .command("presets")
  .description("List available chain presets")
  .action(() => {
    listPresets();
  });

// ─── status ──────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Check which API keys are configured")
  .action(() => {
    const keys = {
      ANTHROPIC_API_KEY: "Claude",
      OPENAI_API_KEY: "ChatGPT",
      PERPLEXITY_API_KEY: "Perplexity",
      TAVILY_API_KEY: "Web Search (Tavily)",
    };

    console.log("\n" + chalk.bold.white("  Trident — API Key Status\n"));
    for (const [envKey, label] of Object.entries(keys)) {
      const set = !!process.env[envKey];
      const icon = set ? chalk.green("  ✓") : chalk.red("  ✗");
      const status = set ? chalk.green("configured") : chalk.red("missing");
      console.log(`${icon}  ${chalk.white(label.padEnd(28))} ${status}`);
    }
    console.log();
  });

program.parseAsync(process.argv);
