import chalk from "chalk";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3"; // re-use the same DB

// Note: CLI connects to the same DB file the MCP server uses
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../../../../data/trident.db");

function getDb() {
  try {
    return new Database(DB_PATH);
  } catch {
    console.log(chalk.red("  DB not found. Start the MCP server at least once to initialize it."));
    process.exit(1);
  }
}

export function memoryList(project?: string) {
  const db = getDb();
  const stmt = project
    ? db.prepare(
        "SELECT project, key, value, source, updated_at FROM memory WHERE project = ? ORDER BY updated_at DESC"
      )
    : db.prepare(
        "SELECT project, key, value, source, updated_at FROM memory ORDER BY project, updated_at DESC"
      );

  const rows = (project ? stmt.all(project) : stmt.all()) as Array<{
    project: string;
    key: string;
    value: string;
    source?: string;
    updated_at: string;
  }>;

  if (rows.length === 0) {
    console.log(chalk.gray("  No entries found."));
    return;
  }

  let currentProject = "";
  for (const row of rows) {
    if (row.project !== currentProject) {
      currentProject = row.project;
      console.log("\n" + chalk.bold.hex("#D4A017")(`  [${currentProject}]`));
    }
    const source = row.source ? chalk.gray(` (by ${row.source})`) : "";
    const date = chalk.gray(` — ${row.updated_at}`);
    console.log(`    ${chalk.white(row.key)}${source}${date}`);
    const preview = row.value.slice(0, 120);
    console.log(chalk.gray(`      ${preview}${row.value.length > 120 ? "…" : ""}`));
  }
  console.log();
}

export function memoryGet(key: string, project = "global") {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM memory WHERE project = ? AND key = ?")
    .get(project, key) as
    | {
        project: string;
        key: string;
        value: string;
        source?: string;
        updated_at: string;
      }
    | undefined;

  if (!row) {
    console.log(chalk.red(`  Not found: [${project}] ${key}`));
    return;
  }

  console.log("\n" + chalk.bold.white(`  [${row.project}] ${row.key}`));
  if (row.source) console.log(chalk.gray(`  Written by: ${row.source}`));
  console.log(chalk.gray(`  Updated: ${row.updated_at}\n`));
  console.log(row.value);
  console.log();
}

export function memorySet(key: string, value: string, project = "global", source = "cli") {
  const db = getDb();
  db.prepare(`
    INSERT INTO memory (project, key, value, source, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project, key) DO UPDATE SET
      value = excluded.value,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(project, key, value, source);

  console.log(chalk.green(`  ✓ Written: [${project}] ${key}`));
}

export function memoryRemove(key: string, project = "global") {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM memory WHERE project = ? AND key = ?")
    .run(project, key);

  if (result.changes > 0) {
    console.log(chalk.green(`  ✓ Deleted: [${project}] ${key}`));
  } else {
    console.log(chalk.red(`  Not found: [${project}] ${key}`));
  }
}

export function memoryProjects() {
  const db = getDb();
  const rows = db
    .prepare("SELECT DISTINCT project, COUNT(*) as count FROM memory GROUP BY project")
    .all() as Array<{ project: string; count: number }>;

  if (rows.length === 0) {
    console.log(chalk.gray("  No projects found."));
    return;
  }

  console.log("\n" + chalk.bold.white("  Projects:\n"));
  for (const row of rows) {
    console.log(`    ${chalk.hex("#D4A017")(row.project)} — ${chalk.gray(row.count + " entries")}`);
  }
  console.log();
}
