import chokidar from "chokidar";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import chalk from "chalk";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import { callClaude } from "@trident/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const DOCS_DIR = path.join(REPO_ROOT, "data", "docs");
const DB_PATH = path.join(REPO_ROOT, "data", "trident.db");
const STATE_PATH = path.join(REPO_ROOT, "data", "watcher-state.json");

dotenv.config({ path: path.join(REPO_ROOT, ".env") });

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".csv",
  ".yaml", ".yml", ".xml", ".html",
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java",
]);

const MAX_FILE_BYTES = 200 * 1024;

interface WatcherState {
  files: Record<string, { mtime_ms: number; size: number; indexed_at: string }>;
}

function loadState(): WatcherState {
  if (!fs.existsSync(STATE_PATH)) return { files: {} };
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as WatcherState;
  } catch {
    return { files: {} };
  }
}

function saveState(state: WatcherState) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

function deriveProject(relPath: string): string {
  const segments = relPath.split(path.sep).filter(Boolean);
  if (segments.length <= 1) return "global";
  return segments[0];
}

function memoryKeyForFile(relPath: string): string {
  return `doc_facts:${relPath.replace(/\\/g, "/")}`;
}

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
  `);
  return db;
}

function writeMemory(db: Database.Database, project: string, key: string, value: string) {
  db.prepare(`
    INSERT INTO memory (project, key, value, source, updated_at)
    VALUES (?, ?, ?, 'watcher', datetime('now'))
    ON CONFLICT(project, key) DO UPDATE SET
      value = excluded.value,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(project, key, value);
}

const EXTRACTION_SYSTEM_PROMPT = `You read source documents and extract the most important factual claims for an AI memory store.

Given the file contents below, return a JSON object with this exact shape and NOTHING else (no markdown fences, no preamble):

{
  "summary": "<1-2 sentence summary of the document>",
  "facts": ["fact 1", "fact 2", "..."]
}

Rules:
- Provide between 5 and 10 facts.
- Each fact must be a single self-contained sentence that stands on its own without referring to "the document" or "this file".
- Prefer concrete, durable facts (definitions, decisions, names, dates, numbers, requirements) over commentary.
- If the document is too short or contains no factual content, return fewer facts but never less than 1, and explain why in the summary.`;

interface ExtractionResult {
  summary: string;
  facts: string[];
}

function parseExtraction(raw: string): ExtractionResult {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  const parsed = JSON.parse(text) as Partial<ExtractionResult>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Extraction is not an object");
  }
  if (typeof parsed.summary !== "string") throw new Error("Missing summary");
  if (!Array.isArray(parsed.facts) || parsed.facts.some((f) => typeof f !== "string")) {
    throw new Error("Missing or invalid facts array");
  }
  return { summary: parsed.summary, facts: parsed.facts as string[] };
}

async function extractFacts(
  relPath: string,
  contents: string
): Promise<ExtractionResult> {
  const userMessage = [
    `File path (relative to data/docs): ${relPath}`,
    "",
    "File contents:",
    "```",
    contents.length > 60000 ? contents.slice(0, 60000) + "\n…[truncated]" : contents,
    "```",
  ].join("\n");

  const result = await callClaude(
    [{ role: "user", content: userMessage }],
    EXTRACTION_SYSTEM_PROMPT,
    { tier: "utility", maxTokens: 1500 }
  );

  if (result.error) {
    throw new Error(result.error);
  }
  return parseExtraction(result.content);
}

function formatMemoryValue(relPath: string, ext: ExtractionResult): string {
  const lines: string[] = [];
  lines.push(`Source: data/docs/${relPath}`);
  lines.push(`Indexed: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`Summary: ${ext.summary}`);
  lines.push("");
  lines.push("Key facts:");
  for (const f of ext.facts) lines.push(`- ${f}`);
  return lines.join("\n");
}

async function indexFile(
  db: Database.Database,
  state: WatcherState,
  absPath: string
) {
  if (!fs.existsSync(absPath)) return;
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) return;

  const ext = path.extname(absPath).toLowerCase();
  if (ext && !TEXT_EXTENSIONS.has(ext)) {
    return;
  }
  if (stat.size > MAX_FILE_BYTES) {
    console.log(chalk.gray(`  skip ${path.relative(DOCS_DIR, absPath)} (too large: ${stat.size} bytes)`));
    return;
  }

  const relPath = path.relative(DOCS_DIR, absPath);
  const prior = state.files[relPath];
  if (prior && prior.mtime_ms === stat.mtimeMs && prior.size === stat.size) {
    return;
  }

  let contents: string;
  try {
    contents = fs.readFileSync(absPath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`  read failed ${relPath}: ${message}`));
    return;
  }

  if (contents.trim().length === 0) {
    console.log(chalk.gray(`  skip ${relPath} (empty)`));
    return;
  }

  const project = deriveProject(relPath);
  console.log(chalk.gray(`  → indexing ${relPath} (project=${project})`));

  let extResult: ExtractionResult;
  try {
    extResult = await extractFacts(relPath, contents);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`  extract failed ${relPath}: ${message}`));
    return;
  }

  const key = memoryKeyForFile(relPath);
  const value = formatMemoryValue(relPath, extResult);
  try {
    writeMemory(db, project, key, value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`  write failed ${relPath}: ${message}`));
    return;
  }

  state.files[relPath] = {
    mtime_ms: stat.mtimeMs,
    size: stat.size,
    indexed_at: new Date().toISOString(),
  };
  saveState(state);

  console.log(
    chalk.green(`  ✓ ${relPath}`) +
      chalk.gray(`  [${project}] ${extResult.facts.length} facts → memory key "${key}"`)
  );
}

function deindexFile(
  db: Database.Database,
  state: WatcherState,
  absPath: string
) {
  const relPath = path.relative(DOCS_DIR, absPath);
  if (!state.files[relPath]) return;
  const project = deriveProject(relPath);
  const key = memoryKeyForFile(relPath);
  try {
    db.prepare("DELETE FROM memory WHERE project = ? AND key = ?").run(project, key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`  delete failed ${relPath}: ${message}`));
    return;
  }
  delete state.files[relPath];
  saveState(state);
  console.log(chalk.yellow(`  − removed ${relPath} from memory`));
}

export interface WatcherOptions {
  once?: boolean;
}

export async function runWatcher(options: WatcherOptions = {}): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(chalk.red("ANTHROPIC_API_KEY not set. Add it to your .env."));
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(DOCS_DIR)) {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
  }

  const db = ensureDb();
  const state = loadState();

  console.log("\n" + chalk.bold.white("━".repeat(60)));
  console.log(chalk.bold.white("  TRIDENT — File Watcher"));
  console.log(chalk.bold.white("━".repeat(60)));
  console.log(chalk.gray(`  Watching: ${DOCS_DIR}`));
  console.log(chalk.gray(`  State:    ${STATE_PATH}`));
  console.log(chalk.gray(`  Mode:     ${options.once ? "single-pass" : "continuous"}`));
  console.log(chalk.bold.white("━".repeat(60)) + "\n");

  if (options.once) {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else out.push(full);
      }
      return out;
    };
    const files = walk(DOCS_DIR);
    for (const f of files) {
      await indexFile(db, state, f);
    }
    console.log(chalk.green(`\n  ✓ Single-pass scan complete (${files.length} files examined)\n`));
    return;
  }

  const watcher = chokidar.watch(DOCS_DIR, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 200 },
    ignored: (p) => path.basename(p).startsWith("."),
  });

  // Serialize index operations so we never run two extractions for the same
  // file concurrently and never have two SQLite writers fighting over the WAL.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>) => {
    queue = queue.then(fn).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`  queue error: ${message}`));
    });
    return queue;
  };

  watcher
    .on("add", (p) => enqueue(() => indexFile(db, state, p)))
    .on("change", (p) => enqueue(() => indexFile(db, state, p)))
    .on("unlink", (p) => enqueue(async () => deindexFile(db, state, p)))
    .on("error", (err) => console.log(chalk.red(`  watcher error: ${err}`)));

  console.log(chalk.gray("  Watching for changes — Ctrl+C to stop."));

  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      console.log(chalk.gray("\n  Shutting down watcher…"));
      await watcher.close();
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

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
  const once = process.argv.includes("--once");
  runWatcher({ once }).catch((err) => {
    console.error(chalk.red(`Fatal: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  });
}
