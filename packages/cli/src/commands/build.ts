import chalk from "chalk";
import path from "path";
import {
  abortBuild,
  createAndRunBuild,
  DEFAULT_CONFIG,
  getBuild,
  globalBus,
  listBuilds,
  listTasksForBuild,
  pauseBuild,
  resumeBuild,
  summarizeBuild,
  type BuildEvent,
  type BuilderTier,
  type CreateBuildOptions,
} from "@trident/builder";

interface BuildRunOpts {
  repo?: string;
  base?: string;
  tier?: "main" | "premium" | "fast";
  costMax?: number;
  follow?: boolean;
}

export async function buildRun(specPath: string, opts: BuildRunOpts): Promise<void> {
  const sourceRepo = path.resolve(opts.repo ?? process.cwd());
  const absSpec = path.resolve(specPath);
  const tier = mapTier(opts.tier);
  const config: CreateBuildOptions["config"] = {
    tier_planner: tier === "fast" ? "utility" : tier === "premium" ? "premium" : DEFAULT_CONFIG.tier_planner,
    tier_coder: tier === "fast" ? "utility" : tier === "premium" ? "premium" : DEFAULT_CONFIG.tier_coder,
    tier_evaluator: tier === "fast" ? "utility" : tier === "premium" ? "main" : DEFAULT_CONFIG.tier_evaluator,
  };
  if (opts.costMax !== undefined) {
    config.ceilings = { ...DEFAULT_CONFIG.ceilings, cost_usd_max: opts.costMax };
  }

  console.log(chalk.white(`\n  Trident Builder`));
  console.log(chalk.gray(`  spec:    ${absSpec}`));
  console.log(chalk.gray(`  repo:    ${sourceRepo}`));
  console.log(chalk.gray(`  base:    ${opts.base ?? "main"}`));
  console.log(chalk.gray(`  tier:    ${tier}\n`));

  const buildId = await createAndRunBuild({
    specPath: absSpec,
    sourceRepo,
    baseBranch: opts.base ?? "main",
    config,
  });
  console.log(chalk.green(`  ✓ build ${buildId} started`));
  console.log(chalk.gray(`    Stream:   trident build status ${buildId} --follow`));
  console.log(chalk.gray(`    Dashboard http://localhost:4242/#/builds/${buildId}\n`));

  if (opts.follow) {
    await followBuild(buildId);
  }
}

export function buildList(): void {
  const builds = listBuilds(50);
  if (builds.length === 0) {
    console.log(chalk.gray("\n  No builds yet.\n"));
    return;
  }
  console.log(chalk.white(`\n  Builds (${builds.length})\n`));
  for (const b of builds) {
    const tasks = listTasksForBuild(b.id);
    const done = tasks.filter((t) => t.status === "done").length;
    const total = tasks.filter((t) => t.kind === "step" || t.parent_id !== null).length || tasks.length;
    console.log(
      `  ${statusChip(b.status)} ${chalk.white(b.id)}  ${chalk.gray(b.spec_path)}`
    );
    console.log(
      `    progress: ${done}/${total}   cost: $${b.cost_usd.toFixed(2)}   started: ${b.started_at}`
    );
  }
  console.log();
}

export function buildStatusCmd(id: string, opts: { follow?: boolean }): void {
  const s = summarizeBuild(id);
  if (!s) {
    console.error(chalk.red(`  build not found: ${id}`));
    process.exitCode = 1;
    return;
  }
  console.log(chalk.white(`\n  Build ${s.id}`));
  console.log(`  status:    ${statusChip(s.status)}`);
  console.log(`  spec:      ${s.spec_path}`);
  console.log(`  repo:      ${s.source_repo}`);
  console.log(`  progress:  ${s.tasks_done}/${s.tasks_total}`);
  console.log(`  cost:      $${s.cost_usd.toFixed(4)}`);
  console.log(`  started:   ${s.started_at}`);
  if (s.finished_at) console.log(`  finished:  ${s.finished_at}`);
  console.log();

  const tasks = listTasksForBuild(id);
  if (tasks.length > 0) {
    console.log(chalk.gray("  Tasks:"));
    for (const t of tasks) {
      const indent = t.parent_id ? "    " : "  ";
      console.log(`${indent}${taskChip(t.status)} ${t.intent}`);
    }
    console.log();
  }

  if (opts.follow) {
    void followBuild(id);
  }
}

export function buildResumeCmd(id: string): void {
  const ok = resumeBuild(id);
  if (!ok) {
    console.error(chalk.red(`  cannot resume ${id} (must be paused)`));
    process.exitCode = 1;
    return;
  }
  console.log(chalk.green(`  ✓ build ${id} resumed`));
}

export function buildAbortCmd(id: string): void {
  const ok = abortBuild(id);
  if (!ok) {
    console.error(chalk.red(`  cannot abort ${id}`));
    process.exitCode = 1;
    return;
  }
  console.log(chalk.yellow(`  ✓ build ${id} aborted`));
}

export function buildPauseCmd(id: string): void {
  const ok = pauseBuild(id);
  if (!ok) {
    console.error(chalk.red(`  cannot pause ${id}`));
    process.exitCode = 1;
    return;
  }
  console.log(chalk.yellow(`  ✓ build ${id} paused`));
}

// ─── helpers ──────────────────────────────────────────────────────────────

function mapTier(t: BuildRunOpts["tier"]): "main" | "premium" | "fast" {
  return t ?? "main";
}

function statusChip(s: string): string {
  switch (s) {
    case "done":
      return chalk.green(s.padEnd(10));
    case "failed":
      return chalk.red(s.padEnd(10));
    case "aborted":
    case "paused":
      return chalk.yellow(s.padEnd(10));
    case "escalated":
      return chalk.magenta(s.padEnd(10));
    case "running":
    case "planning":
      return chalk.cyan(s.padEnd(10));
    default:
      return chalk.gray(s.padEnd(10));
  }
}

function taskChip(s: string): string {
  switch (s) {
    case "done":
      return chalk.green("✓");
    case "failed":
      return chalk.red("✗");
    case "skipped":
      return chalk.gray("·");
    case "running":
      return chalk.cyan("▶");
    case "ready":
      return chalk.gray("○");
    default:
      return chalk.gray("○");
  }
}

async function followBuild(buildId: string): Promise<void> {
  return new Promise((resolve) => {
    const unsub = globalBus.subscribe(buildId, (e: BuildEvent) => {
      const t = new Date(e.created_at).toLocaleTimeString();
      switch (e.kind) {
        case "plan_generated":
          console.log(chalk.cyan(`  ${t}  plan_generated  steps=${e.payload.steps}`));
          break;
        case "task_started":
          console.log(chalk.white(`  ${t}  task_started   ${e.payload.intent}`));
          break;
        case "tool_called":
          console.log(chalk.gray(`  ${t}  tool          ${e.payload.name}`));
          break;
        case "step_evaluated":
          {
            const v = e.payload.verdict as string;
            const color = v === "pass" ? chalk.green : v === "partial" ? chalk.yellow : chalk.red;
            console.log(
              `  ${t}  ${color(`evaluated:${v}`)}    attempt=${e.payload.attempt}  ${e.payload.reason}`
            );
          }
          break;
        case "escalation_triggered":
          console.log(chalk.magenta(`  ${t}  escalation     ${JSON.stringify(e.payload)}`));
          break;
        case "intervention_requested":
          console.log(chalk.yellow(`  ${t}  intervention   ${JSON.stringify(e.payload)}`));
          break;
        case "build_terminated":
          console.log(chalk.white(`  ${t}  build_terminated  ${JSON.stringify(e.payload)}`));
          unsub();
          resolve();
          break;
      }
    });

    // Bail out if build is already in a terminal state.
    const b = getBuild(buildId);
    if (b && ["done", "failed", "aborted"].includes(b.status)) {
      unsub();
      resolve();
    }
  });
}
