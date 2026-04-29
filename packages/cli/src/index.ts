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
import { sessionsList, sessionsGet } from "./commands/sessions.js";
import { routeDetect, routeList } from "./commands/route.js";
import { runWatcher } from "@trident/watcher";
import { scheduleList, scheduleRun, scheduleDaemon } from "@trident/scheduler";
import { googleLogin, googleStatus } from "./commands/google.js";
import { AIName } from "./lib/clients.js";
import { resolveMode } from "./lib/config.js";

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
  .option("-P, --project <project>", "Project namespace — auto-loads matching memory entries as context")
  .option("-O, --output <filepath>", "Write full results to a markdown file (in addition to stdout)")
  .option("--diff", "After responses, run a Claude synthesis identifying agreement, disagreement, and factual conflicts")
  .option("--score", "After responses, run a Claude confidence-scoring pass and print a Confidence Report")
  .action(async (prompt: string, opts) => {
    const ais = opts.ais.split(",").map((a: string) => a.trim()) as AIName[];
    await runParallel(prompt, {
      ais,
      system: opts.system,
      project: opts.project,
      output: opts.output,
      diff: opts.diff,
      score: opts.score,
    });
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
  .option("-P, --project <project>", "Project namespace — auto-loads matching memory entries as context")
  .option("-O, --output <filepath>", "Write full results to a markdown file (in addition to stdout)")
  .option("-m, --mode <mode>", "Routing mode from trident.config.json (e.g. research, code, summarize)")
  .action(async (prompt: string, opts) => {
    if (opts.listPresets) {
      listPresets();
      return;
    }

    if (opts.mode && opts.order) {
      console.error(chalk.red("  Cannot use --mode and --order together. Pick one."));
      process.exitCode = 1;
      return;
    }

    let order: AIName[] | undefined;
    if (opts.mode) {
      try {
        order = resolveMode(opts.mode);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`  ${message}`));
        process.exitCode = 1;
        return;
      }
    } else if (opts.order) {
      order = opts.order.split(",").map((a: string) => a.trim()) as AIName[];
    }

    await runChain(prompt, {
      order,
      preset: opts.preset,
      system: opts.system,
      showIntermediate: opts.showIntermediate,
      project: opts.project,
      output: opts.output,
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

// ─── sessions ────────────────────────────────────────────────────────────────

const sessionsCmd = program
  .command("sessions")
  .alias("s")
  .description("Browse past parallel and chain runs (replay session history)");

sessionsCmd
  .command("list", { isDefault: true })
  .alias("ls")
  .description("List recent session runs")
  .option("-l, --limit <n>", "Max number of sessions to show (default: 50)", (v) => parseInt(v, 10))
  .option("-m, --mode <mode>", "Filter by mode: parallel or chain")
  .option("-p, --project <project>", "Filter by project namespace")
  .action((opts) => {
    const mode = opts.mode as "parallel" | "chain" | undefined;
    if (mode && mode !== "parallel" && mode !== "chain") {
      console.error(`Invalid mode: ${mode}. Use 'parallel' or 'chain'.`);
      process.exitCode = 1;
      return;
    }
    sessionsList({ limit: opts.limit, mode, project: opts.project });
  });

sessionsCmd
  .command("get <id>")
  .description("Reprint the full output of a past session by ID")
  .action((id: string) => {
    sessionsGet(id);
  });

// ─── watch ───────────────────────────────────────────────────────────────────

program
  .command("watch")
  .description("Watch data/docs/ — extract key facts from new/changed files into project memory")
  .option("--once", "Index all files in a single pass and exit (don't keep watching)")
  .action(async (opts) => {
    await runWatcher({ once: !!opts.once });
  });

// ─── ui ──────────────────────────────────────────────────────────────────────

program
  .command("ui")
  .description("Start the Trident web UI server (http://localhost:4242)")
  .option("-p, --port <port>", "Port to bind (default: 4242)")
  .action(async (opts) => {
    if (opts.port) process.env.TRIDENT_UI_PORT = String(opts.port);
    // Dynamic import avoids loading express into every CLI invocation.
    await import("@trident/ui-server");
  });

// ─── google ──────────────────────────────────────────────────────────────────

const googleCmd = program
  .command("google")
  .description("Manage Google Workspace OAuth (Gmail / Drive / Calendar MCP tools)");

googleCmd
  .command("login")
  .description("One-time OAuth setup — opens a browser, saves tokens to data/google-token.json")
  .action(async () => {
    await googleLogin();
  });

googleCmd
  .command("status", { isDefault: true })
  .description("Show whether credentials and token are present, with token expiry")
  .action(() => {
    googleStatus();
  });

// ─── schedule ────────────────────────────────────────────────────────────────

const scheduleCmd = program
  .command("schedule")
  .description("Manage and run scheduled chains defined in schedules.json");

scheduleCmd
  .command("list", { isDefault: true })
  .alias("ls")
  .description("List all schedules and their last run status")
  .action(() => {
    scheduleList();
  });

scheduleCmd
  .command("run <id>")
  .description("Run a schedule immediately by id (does not wait for cron)")
  .action(async (id: string) => {
    await scheduleRun(id);
  });

scheduleCmd
  .command("daemon")
  .description("Start the cron daemon — keeps running and fires schedules at their cron times")
  .action(async () => {
    await scheduleDaemon();
  });

// ─── route ───────────────────────────────────────────────────────────────────

const routeCmd = program
  .command("route")
  .alias("r")
  .description("Inspect and detect routing modes from trident.config.json");

routeCmd
  .command("list", { isDefault: true })
  .alias("ls")
  .description("List all routing modes defined in trident.config.json")
  .action(() => {
    routeList();
  });

routeCmd
  .command("detect <prompt>")
  .description("Use Claude to classify a prompt and suggest the best routing mode")
  .action(async (prompt: string) => {
    await routeDetect(prompt);
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
