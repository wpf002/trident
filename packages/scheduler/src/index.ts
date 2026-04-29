import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import cron from "node-cron";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { AI_MAP, AI_LABELS, AIMessage, AIName, CHAIN_PRESETS, VALID_AIS } from "@trident/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCHEDULES_PATH = path.join(REPO_ROOT, "schedules.json");
const STATE_PATH = path.join(REPO_ROOT, "data", "scheduler-state.json");
const DB_PATH = path.join(REPO_ROOT, "data", "trident.db");

dotenv.config({ path: path.join(REPO_ROOT, ".env") });

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Schedule {
  id: string;
  cron: string;
  prompt: string;
  preset?: string;
  order?: AIName[];
  output?: string;
  memory_key?: string;
  project?: string;
  system?: string;
}

interface SchedulerState {
  runs: Record<string, { last_run_at: string; last_run_id: string; last_status: "ok" | "error"; last_error?: string }>;
}


// ─── Schedules I/O ───────────────────────────────────────────────────────────

export function loadSchedules(): Schedule[] {
  if (!fs.existsSync(SCHEDULES_PATH)) return [];
  const raw = fs.readFileSync(SCHEDULES_PATH, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse schedules.json: ${message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("schedules.json must contain a JSON array of schedule objects");
  }
  return parsed.map((entry, i) => validateSchedule(entry, i));
}

function validateSchedule(entry: unknown, index: number): Schedule {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`schedules[${index}] must be an object`);
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== "string" || !e.id.trim()) {
    throw new Error(`schedules[${index}].id is required and must be a non-empty string`);
  }
  if (typeof e.cron !== "string" || !cron.validate(e.cron)) {
    throw new Error(`schedules[${index}].cron is invalid: ${String(e.cron)}`);
  }
  if (typeof e.prompt !== "string" || !e.prompt.trim()) {
    throw new Error(`schedules[${index}].prompt is required`);
  }
  if (e.preset !== undefined && typeof e.preset !== "string") {
    throw new Error(`schedules[${index}].preset must be a string`);
  }
  if (e.preset && !CHAIN_PRESETS[e.preset as string]) {
    throw new Error(`schedules[${index}].preset "${e.preset}" is unknown. Valid: ${Object.keys(CHAIN_PRESETS).join(", ")}`);
  }
  if (e.order !== undefined) {
    if (!Array.isArray(e.order) || e.order.length === 0) {
      throw new Error(`schedules[${index}].order must be a non-empty array`);
    }
    for (const ai of e.order) {
      if (typeof ai !== "string" || !VALID_AIS.has(ai as AIName)) {
        throw new Error(`schedules[${index}].order has invalid AI "${String(ai)}"`);
      }
    }
  }
  if (e.output !== undefined && typeof e.output !== "string") {
    throw new Error(`schedules[${index}].output must be a string path`);
  }
  if (e.memory_key !== undefined && typeof e.memory_key !== "string") {
    throw new Error(`schedules[${index}].memory_key must be a string`);
  }
  if (e.project !== undefined && typeof e.project !== "string") {
    throw new Error(`schedules[${index}].project must be a string`);
  }
  if (e.system !== undefined && typeof e.system !== "string") {
    throw new Error(`schedules[${index}].system must be a string`);
  }
  if (!e.preset && !e.order) {
    throw new Error(`schedules[${index}] must specify either "preset" or "order"`);
  }
  return {
    id: e.id,
    cron: e.cron,
    prompt: e.prompt,
    preset: e.preset as string | undefined,
    order: e.order as AIName[] | undefined,
    output: e.output as string | undefined,
    memory_key: e.memory_key as string | undefined,
    project: e.project as string | undefined,
    system: e.system as string | undefined,
  };
}

function loadState(): SchedulerState {
  if (!fs.existsSync(STATE_PATH)) return { runs: {} };
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as SchedulerState;
  } catch {
    return { runs: {} };
  }
}

function saveState(state: SchedulerState) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

// ─── DB ──────────────────────────────────────────────────────────────────────

function ensureDb(): Database.Database {
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL DEFAULT 'global',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      source TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, key)
    );
    CREATE TABLE IF NOT EXISTS session_runs (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      prompt TEXT NOT NULL,
      project TEXT,
      ais TEXT NOT NULL,
      responses TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      preset TEXT,
      system_prompt TEXT,
      metadata TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function writeMemory(db: Database.Database, project: string, key: string, value: string) {
  db.prepare(`
    INSERT INTO memory (project, key, value, source, updated_at)
    VALUES (?, ?, ?, 'scheduler', datetime('now'))
    ON CONFLICT(project, key) DO UPDATE SET
      value = excluded.value,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(project, key, value);
}

interface PersistedRun {
  id: string;
  prompt: string;
  project: string | null;
  order: AIName[];
  responses: Array<{ ai: string; content: string; error?: string; duration_ms: number; started_at: string; finished_at: string }>;
  duration_ms: number;
  preset: string | null;
  system_prompt: string | null;
  metadata: Record<string, unknown> | null;
  started_at: string;
  finished_at: string;
}

function persistRun(db: Database.Database, run: PersistedRun) {
  db.prepare(`
    INSERT INTO session_runs
      (id, mode, prompt, project, ais, responses, duration_ms, preset, system_prompt, metadata, started_at, finished_at)
    VALUES (?, 'chain', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id,
    run.prompt,
    run.project,
    JSON.stringify(run.order),
    JSON.stringify(run.responses),
    run.duration_ms,
    run.preset,
    run.system_prompt,
    run.metadata ? JSON.stringify(run.metadata) : null,
    run.started_at,
    run.finished_at
  );
}

// ─── Chain runner ────────────────────────────────────────────────────────────

export interface ScheduleRunResult {
  id: string;
  schedule_id: string;
  prompt: string;
  order: AIName[];
  finalContent: string;
  responses: PersistedRun["responses"];
  duration_ms: number;
  started_at: string;
  finished_at: string;
}

export async function runScheduledJob(
  schedule: Schedule,
  options: { quiet?: boolean } = {}
): Promise<ScheduleRunResult> {
  const log = (msg: string) => {
    if (!options.quiet) console.log(msg);
  };

  const preset = schedule.preset ? CHAIN_PRESETS[schedule.preset] : undefined;
  const order: AIName[] = schedule.order ?? preset?.order ?? ["claude", "gpt", "perplexity"];
  const systemPrompts: Partial<Record<AIName, string>> = preset?.systemPrompts ?? {};

  log(chalk.gray(`  → running schedule "${schedule.id}" — order: ${order.map((a) => AI_LABELS[a]).join(" → ")}`));

  const runId = nanoid(12);
  const startedAt = new Date().toISOString();
  const runStart = Date.now();

  const responses: PersistedRun["responses"] = [];
  const conversation: AIMessage[] = [{ role: "user", content: schedule.prompt }];
  let finalContent = "";

  for (let i = 0; i < order.length; i++) {
    const ai = order[i];
    const baseSystem =
      systemPrompts[ai] ??
      schedule.system ??
      (i === 0
        ? "You are the first AI in a chain. Provide a thorough initial response."
        : i === order.length - 1
        ? "You are the final AI in a chain. Synthesize all previous responses into a definitive answer."
        : "You are in the middle of a chain. Build on the previous response.");

    const messages = [...conversation];
    if (i > 0) {
      messages.push({
        role: "user",
        content: `The above was ${AI_LABELS[order[i - 1]]}'s response. Now it's your turn in the chain.`,
      });
    }

    const aiStart = Date.now();
    const aiStartedAt = new Date().toISOString();
    const result = await AI_MAP[ai](messages, baseSystem);
    const aiFinishedAt = new Date().toISOString();

    responses.push({
      ai,
      content: result.content,
      error: result.error,
      duration_ms: Date.now() - aiStart,
      started_at: aiStartedAt,
      finished_at: aiFinishedAt,
    });

    if (result.error) {
      log(chalk.red(`    ✗ ${AI_LABELS[ai]}: ${result.error}`));
      continue;
    }
    log(chalk.gray(`    ✓ ${AI_LABELS[ai]} (${Date.now() - aiStart}ms)`));
    conversation.push({ role: "assistant", content: result.content });
    finalContent = result.content;
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - runStart;

  const db = ensureDb();

  if (schedule.output) {
    const absOutput = path.isAbsolute(schedule.output)
      ? schedule.output
      : path.join(REPO_ROOT, schedule.output);
    const dir = path.dirname(absOutput);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const md = formatRunMarkdown(schedule, runId, startedAt, finishedAt, durationMs, order, responses);
    fs.writeFileSync(absOutput, md, "utf-8");
    log(chalk.gray(`    → output: ${absOutput}`));
  }

  if (schedule.memory_key) {
    const project = schedule.project ?? "global";
    writeMemory(db, project, schedule.memory_key, finalContent);
    log(chalk.gray(`    → memory: [${project}] ${schedule.memory_key}`));
  }

  try {
    persistRun(db, {
      id: runId,
      prompt: schedule.prompt,
      project: schedule.project ?? null,
      order,
      responses,
      duration_ms: durationMs,
      preset: schedule.preset ?? null,
      system_prompt: schedule.system ?? null,
      metadata: { schedule_id: schedule.id, source: "scheduler" },
      started_at: startedAt,
      finished_at: finishedAt,
    });
  } catch (err) {
    log(chalk.red(`    (failed to persist session run: ${err instanceof Error ? err.message : String(err)})`));
  }

  return {
    id: runId,
    schedule_id: schedule.id,
    prompt: schedule.prompt,
    order,
    finalContent,
    responses,
    duration_ms: durationMs,
    started_at: startedAt,
    finished_at: finishedAt,
  };
}

function formatRunMarkdown(
  schedule: Schedule,
  runId: string,
  startedAt: string,
  finishedAt: string,
  durationMs: number,
  order: AIName[],
  responses: PersistedRun["responses"]
): string {
  const lines: string[] = [];
  lines.push(`# Trident — Scheduled Run: ${schedule.id}`);
  lines.push("");
  lines.push(`> **Session:** \`${runId}\``);
  lines.push(`> **Cron:** \`${schedule.cron}\``);
  lines.push(`> **Started:** ${startedAt}`);
  lines.push(`> **Finished:** ${finishedAt}`);
  lines.push(`> **Duration:** ${durationMs}ms`);
  lines.push(`> **Order:** ${order.map((a) => AI_LABELS[a]).join(" → ")}`);
  if (schedule.preset) lines.push(`> **Preset:** \`${schedule.preset}\``);
  if (schedule.project) lines.push(`> **Project:** \`${schedule.project}\``);
  lines.push("");
  lines.push("## Prompt");
  lines.push("");
  lines.push("```");
  lines.push(schedule.prompt);
  lines.push("```");
  lines.push("");
  for (let i = 0; i < responses.length; i++) {
    const r = responses[i];
    lines.push(`## ${AI_LABELS[r.ai as AIName] ?? r.ai} — Step ${i + 1}/${responses.length}`);
    lines.push("");
    lines.push(`*${r.duration_ms}ms*`);
    lines.push("");
    if (r.error) lines.push(`> **Error:** ${r.error}`);
    else lines.push(r.content);
    lines.push("");
  }
  return lines.join("\n");
}

// ─── CLI-facing helpers ──────────────────────────────────────────────────────

export function scheduleList() {
  let schedules: Schedule[];
  try {
    schedules = loadSchedules();
  } catch (err) {
    console.error(chalk.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exitCode = 1;
    return;
  }

  if (schedules.length === 0) {
    console.log(chalk.gray("\n  No schedules defined. Create schedules.json at the project root.\n"));
    return;
  }

  const state = loadState();

  console.log("\n" + chalk.bold.white(`  Trident schedules (${schedules.length})\n`));
  for (const s of schedules) {
    const order = s.order ?? CHAIN_PRESETS[s.preset ?? ""]?.order ?? ["claude", "gpt", "perplexity"];
    console.log(`  ${chalk.bold.hex("#D4A017")(s.id)}  ${chalk.gray(s.cron)}`);
    console.log(`    ${chalk.gray("Prompt:")} ${s.prompt.slice(0, 80)}${s.prompt.length > 80 ? "…" : ""}`);
    console.log(`    ${chalk.gray("Order: ")} ${order.map((a) => AI_LABELS[a]).join(" → ")}${s.preset ? chalk.gray(`  (preset: ${s.preset})`) : ""}`);
    if (s.output) console.log(`    ${chalk.gray("Output:")} ${s.output}`);
    if (s.memory_key) console.log(`    ${chalk.gray("Memory:")} [${s.project ?? "global"}] ${s.memory_key}`);
    const last = state.runs[s.id];
    if (last) {
      const statusColor = last.last_status === "ok" ? chalk.green : chalk.red;
      console.log(`    ${chalk.gray("Last:  ")} ${last.last_run_at}  ${statusColor(last.last_status)}${last.last_error ? chalk.red(` — ${last.last_error}`) : ""}`);
    } else {
      console.log(`    ${chalk.gray("Last:  ")} (never)`);
    }
    console.log();
  }
}

export async function scheduleRun(id: string) {
  let schedules: Schedule[];
  try {
    schedules = loadSchedules();
  } catch (err) {
    console.error(chalk.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exitCode = 1;
    return;
  }
  const target = schedules.find((s) => s.id === id);
  if (!target) {
    console.error(chalk.red(`  No schedule with id "${id}". Run 'trident schedule list' to see options.`));
    process.exitCode = 1;
    return;
  }

  console.log("\n" + chalk.bold.white("━".repeat(60)));
  console.log(chalk.bold.white(`  Running schedule: ${target.id}`));
  console.log(chalk.bold.white("━".repeat(60)));

  const state = loadState();
  try {
    const result = await runScheduledJob(target);
    state.runs[target.id] = {
      last_run_at: result.finished_at,
      last_run_id: result.id,
      last_status: "ok",
    };
    saveState(state);
    console.log(chalk.green(`\n  ✓ Done in ${result.duration_ms}ms (session ${result.id})\n`));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.runs[target.id] = {
      last_run_at: new Date().toISOString(),
      last_run_id: "",
      last_status: "error",
      last_error: message,
    };
    saveState(state);
    console.error(chalk.red(`\n  ✗ ${message}\n`));
    process.exitCode = 1;
  }
}

// ─── Daemon (cron loop) ──────────────────────────────────────────────────────

export async function scheduleDaemon() {
  let schedules: Schedule[];
  try {
    schedules = loadSchedules();
  } catch (err) {
    console.error(chalk.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exitCode = 1;
    return;
  }

  if (schedules.length === 0) {
    console.log(chalk.gray("  No schedules defined — nothing to run."));
    return;
  }

  console.log("\n" + chalk.bold.white("━".repeat(60)));
  console.log(chalk.bold.white("  TRIDENT — Schedule Daemon"));
  console.log(chalk.bold.white("━".repeat(60)));

  const state = loadState();
  const tasks: cron.ScheduledTask[] = [];

  for (const s of schedules) {
    console.log(chalk.gray(`  Registering ${s.id}  (${s.cron})`));
    const task = cron.schedule(s.cron, async () => {
      const ts = new Date().toISOString();
      console.log(chalk.gray(`\n  [${ts}] firing schedule "${s.id}"`));
      try {
        const result = await runScheduledJob(s);
        state.runs[s.id] = {
          last_run_at: result.finished_at,
          last_run_id: result.id,
          last_status: "ok",
        };
        saveState(state);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state.runs[s.id] = {
          last_run_at: new Date().toISOString(),
          last_run_id: "",
          last_status: "error",
          last_error: message,
        };
        saveState(state);
        console.error(chalk.red(`  schedule "${s.id}" failed: ${message}`));
      }
    });
    tasks.push(task);
  }

  console.log(chalk.gray(`\n  ${tasks.length} schedules active. Ctrl+C to stop.\n`));

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.log(chalk.gray("\n  Shutting down scheduler…"));
      for (const t of tasks) t.stop();
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

// ─── Main entry (when run directly) ──────────────────────────────────────────

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const sub = process.argv[2];
  if (sub === "list") scheduleList();
  else if (sub === "run" && process.argv[3]) scheduleRun(process.argv[3]);
  else if (sub === "daemon") scheduleDaemon();
  else {
    console.log("Usage: trident-scheduler [list|run <id>|daemon]");
    process.exit(1);
  }
}
