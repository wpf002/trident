#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { runParallel } from "./commands/parallel.js";
import { runChain, listPresets } from "./commands/chain.js";
import { sessionsList, sessionsGet } from "./commands/sessions.js";
import { routeDetect, routeList } from "./commands/route.js";
import { configShow } from "./commands/config.js";
import { scheduleList, scheduleRun, scheduleDaemon } from "@trident/scheduler";
import { googleLogin, googleStatus } from "./commands/google.js";
import {
  buildRun,
  buildList,
  buildStatusCmd,
  buildResumeCmd,
  buildAbortCmd,
  buildPauseCmd,
} from "./commands/build.js";
import { AIName } from "./lib/clients.js";
import { resolveMode } from "./lib/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

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
  .option("-O, --output <filepath>", "Write full results to a markdown file (in addition to stdout)")
  .option("--diff", "After responses, run a Claude synthesis identifying agreement, disagreement, and factual conflicts")
  .option("--score", "After responses, run a Claude confidence-scoring pass and print a Confidence Report")
  .option("--premium", "Use the premium model tier (Opus 4.7 / GPT-4o / sonar-reasoning) — slower, ~10× the cost")
  .option("--fast", "Use the utility model tier (Haiku 4.5 / GPT-4o-mini / sonar) — fastest, cheapest")
  .action(async (prompt: string, opts) => {
    const ais = opts.ais.split(",").map((a: string) => a.trim()) as AIName[];
    if (opts.premium && opts.fast) {
      console.error(chalk.red("  Cannot use --premium and --fast together. Pick one."));
      process.exitCode = 1;
      return;
    }
    const tier = opts.premium ? "premium" : opts.fast ? "utility" : "main";
    await runParallel(prompt, {
      ais,
      system: opts.system,
      output: opts.output,
      diff: opts.diff,
      score: opts.score,
      tier,
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
  .option("-O, --output <filepath>", "Write full results to a markdown file (in addition to stdout)")
  .option("-m, --mode <mode>", "Routing mode from trident.config.json (e.g. research, code, summarize)")
  .option("--premium", "Use the premium model tier (Opus 4.7 / GPT-4o / sonar-reasoning) — slower, ~10× the cost")
  .option("--fast", "Use the utility model tier (Haiku 4.5 / GPT-4o-mini / sonar) — fastest, cheapest")
  .action(async (prompt: string, opts) => {
    if (opts.listPresets) {
      listPresets();
      return;
    }

    const orderSources = [opts.mode, opts.order, opts.preset].filter(Boolean).length;
    if (orderSources > 1) {
      console.error(chalk.red("  --mode, --order, and --preset are mutually exclusive. Pick one."));
      process.exitCode = 1;
      return;
    }
    if (opts.premium && opts.fast) {
      console.error(chalk.red("  Cannot use --premium and --fast together. Pick one."));
      process.exitCode = 1;
      return;
    }
    const tier = opts.premium ? "premium" : opts.fast ? "utility" : "main";

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
      output: opts.output,
      tier,
    });
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
  .action((opts) => {
    const mode = opts.mode as "parallel" | "chain" | undefined;
    if (mode && mode !== "parallel" && mode !== "chain") {
      console.error(`Invalid mode: ${mode}. Use 'parallel' or 'chain'.`);
      process.exitCode = 1;
      return;
    }
    sessionsList({ limit: opts.limit, mode });
  });

sessionsCmd
  .command("get <id>")
  .description("Reprint the full output of a past session by ID")
  .action((id: string) => {
    sessionsGet(id);
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

// ─── build ───────────────────────────────────────────────────────────────────

const buildCmd = program
  .command("build")
  .description("Autonomous coding agent — plan, write, test, commit from a spec");

buildCmd
  .command("run <spec>", { isDefault: true })
  .description("Start a new build from a spec markdown file")
  .option("-r, --repo <path>", "Source repo to build inside (default: cwd)")
  .option("-b, --base <branch>", "Base branch to fork from (default: main)")
  .option("--tier <tier>", "Tier preset: main (default) | premium | fast")
  .option("--cost-max <usd>", "Override max cost ceiling for this build (USD)", (v) => parseFloat(v))
  .option("-f, --follow", "Stream events to stdout until the build terminates")
  .action(async (spec: string, opts) => {
    if (opts.tier && !["main", "premium", "fast"].includes(opts.tier)) {
      console.error(chalk.red(`  invalid --tier: ${opts.tier}`));
      process.exitCode = 1;
      return;
    }
    await buildRun(spec, {
      repo: opts.repo,
      base: opts.base,
      tier: opts.tier,
      costMax: opts.costMax,
      follow: opts.follow,
    });
  });

buildCmd
  .command("list")
  .alias("ls")
  .description("List builds")
  .action(() => {
    buildList();
  });

buildCmd
  .command("status <id>")
  .description("Show a build's status, plan, and progress")
  .option("-f, --follow", "Stream events after printing the snapshot")
  .action((id: string, opts) => {
    buildStatusCmd(id, { follow: opts.follow });
  });

buildCmd
  .command("resume <id>")
  .description("Resume a paused build")
  .action((id: string) => {
    buildResumeCmd(id);
  });

buildCmd
  .command("pause <id>")
  .description("Pause a running build (stops at next step boundary)")
  .action((id: string) => {
    buildPauseCmd(id);
  });

buildCmd
  .command("abort <id>")
  .description("Abort a running or paused build")
  .action((id: string) => {
    buildAbortCmd(id);
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

// ─── config ──────────────────────────────────────────────────────────────────

program
  .command("config")
  .description("Show resolved configuration: models per tier, routing modes, files, API keys")
  .action(() => {
    configShow();
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
