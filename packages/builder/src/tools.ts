// Builder-internal tool layer. These are the tools the LLM sees via the
// Anthropic SDK's `tools` parameter — schema is in Anthropic shape (uses
// `input_schema`, not MCP's). The dispatcher executes them by calling the
// in-process Sandbox directly, bypassing the MCP stdio transport.
//
// Conceptually the same operations as packages/mcp-server/src/tools/* — but
// without the `workspace` arg (sandbox is implicit) and emitted as the
// shapes the Anthropic Tool Use API expects.

import path from "path";
import type { Sandbox, ExecResult } from "@trident/builder-runtime";

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const BUILDER_TOOLS: ToolDefinition[] = [
  {
    name: "shell_exec",
    description:
      "Run a shell command inside the build workspace. Has access to workspace files only; no host secrets are forwarded. Output is capped. Destructive commands (rm -rf /, git push -f, sudo, etc.) are refused. Returns exit_code, stdout, stderr.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        cwd: { type: "string", description: "Working directory relative to workspace root" },
        timeout_ms: { type: "number", description: "Wall-clock timeout (default 30000, max 300000)" },
      },
      required: ["command"],
    },
  },
  {
    name: "project_list",
    description:
      "List files in the workspace. Recursive; skips node_modules, .git, dist, etc.",
    input_schema: {
      type: "object",
      properties: {
        subdirectory: { type: "string", description: "Subdir relative to workspace root" },
        max_results: { type: "number", description: "Cap on results (default 1000)" },
      },
    },
  },
  {
    name: "project_read",
    description: "Read a file from the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to workspace root" },
        max_chars: { type: "number", description: "Truncate after N chars (default 50000)" },
      },
      required: ["path"],
    },
  },
  {
    name: "project_write",
    description:
      "Write a file in the workspace. Creates parent dirs. Overwrites — use project_edit for surgical changes.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to workspace root" },
        content: { type: "string", description: "File content (UTF-8)" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "project_edit",
    description:
      "Replace an exact string in a workspace file. Fails if old_string is missing or appears more than once unless replace_all is true.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "project_search",
    description:
      "Regex search across workspace files. Returns matches with file, line number, line content.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JS regex source" },
        case_insensitive: { type: "boolean" },
        include_ext: { type: "string", description: "Extension filter like '.ts' or '{ts,tsx}'" },
        max_results: { type: "number" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "git_status",
    description: "Show `git status --porcelain=v1 -b` in the workspace.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "git_diff",
    description: "Show the workspace diff. With staged:true, show the staged diff.",
    input_schema: {
      type: "object",
      properties: {
        staged: { type: "boolean" },
        path: { type: "string" },
      },
    },
  },
  {
    name: "test_run",
    description:
      "Run the test suite (auto-detects vitest/jest/pytest/cargo). Returns exit code + pass/fail counts when parseable.",
    input_schema: {
      type: "object",
      properties: {
        framework: { type: "string", enum: ["auto", "vitest", "jest", "pytest", "cargo", "mocha"] },
        pattern: { type: "string" },
        timeout_ms: { type: "number" },
      },
    },
  },
  {
    name: "typecheck",
    description: "Run the project's type-checker (tsc/mypy/cargo check). Returns exit code + error count when parseable.",
    input_schema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Optional tsconfig path" },
      },
    },
  },
  {
    name: "build_workspace_root",
    description:
      "Return metadata about the workspace: branch, source repo, detected language and package manager. Call once per step.",
    input_schema: { type: "object", properties: {} },
  },
];

// ─── Executor ────────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  sandbox: Sandbox
): Promise<string> {
  try {
    switch (name) {
      case "shell_exec":
        return JSON.stringify(
          await sandbox.exec(String(input.command ?? ""), {
            cwd: input.cwd as string | undefined,
            timeoutMs: input.timeout_ms as number | undefined,
          })
        );

      case "project_list": {
        const files = await listFiles(
          sandbox,
          (input.subdirectory as string | undefined) ?? "",
          Math.min((input.max_results as number | undefined) ?? 1000, 10_000)
        );
        return JSON.stringify({ count: files.length, files });
      }

      case "project_read": {
        const rel = String(input.path ?? "");
        const maxChars = Math.min(
          (input.max_chars as number | undefined) ?? 50_000,
          500_000
        );
        const content = await sandbox.readFile(rel);
        const truncated = content.length > maxChars;
        return JSON.stringify({
          path: rel,
          size_chars: content.length,
          truncated,
          content: truncated ? content.slice(0, maxChars) : content,
        });
      }

      case "project_write": {
        const rel = String(input.path ?? "");
        const content = String(input.content ?? "");
        await sandbox.writeFile(rel, content);
        return JSON.stringify({ path: rel, bytes_written: content.length });
      }

      case "project_edit": {
        const rel = String(input.path ?? "");
        const oldStr = String(input.old_string ?? "");
        const newStr = String(input.new_string ?? "");
        const replaceAll = Boolean(input.replace_all ?? false);
        if (!oldStr) return JSON.stringify({ error: "old_string must be non-empty" });
        const original = await sandbox.readFile(rel);
        let count = 0;
        let idx = 0;
        while ((idx = original.indexOf(oldStr, idx)) !== -1) {
          count++;
          idx += oldStr.length;
        }
        if (count === 0) return JSON.stringify({ error: `old_string not found in ${rel}` });
        if (!replaceAll && count > 1) {
          return JSON.stringify({
            error: `old_string appears ${count} times; use replace_all or pick a more specific old_string`,
          });
        }
        const updated = replaceAll
          ? original.split(oldStr).join(newStr)
          : original.replace(oldStr, newStr);
        await sandbox.writeFile(rel, updated);
        return JSON.stringify({ path: rel, replacements: replaceAll ? count : 1 });
      }

      case "project_search": {
        const pattern = String(input.pattern ?? "");
        if (!pattern) return JSON.stringify({ error: "pattern required" });
        const ci = Boolean(input.case_insensitive ?? false);
        const extSpec = input.include_ext as string | undefined;
        const maxResults = Math.min(
          (input.max_results as number | undefined) ?? 200,
          2000
        );
        let re: RegExp;
        try {
          re = new RegExp(pattern, ci ? "i" : "");
        } catch (err) {
          return JSON.stringify({ error: `invalid regex: ${(err as Error).message}` });
        }
        const matches = await searchFiles(sandbox, re, parseExtFilter(extSpec), maxResults);
        return JSON.stringify({ count: matches.length, matches });
      }

      case "git_status":
        return JSON.stringify(await sandbox.exec("git status --porcelain=v1 -b"));

      case "git_diff": {
        const staged = Boolean(input.staged ?? false);
        const filePath = input.path as string | undefined;
        const parts = ["git", "diff"];
        if (staged) parts.push("--cached");
        if (filePath) parts.push("--", `'${filePath.replace(/'/g, "'\\''")}'`);
        const r = await sandbox.exec(parts.join(" "));
        return JSON.stringify(r);
      }

      case "test_run": {
        const framework = (input.framework as string | undefined) ?? "auto";
        const pattern = input.pattern as string | undefined;
        const timeoutMs = (input.timeout_ms as number | undefined) ?? 300_000;
        const cmd = await testCommand(sandbox, framework, pattern);
        if (!cmd) return JSON.stringify({ error: "no test framework detected" });
        const r = await sandbox.exec(cmd, { timeoutMs });
        return JSON.stringify({ command: cmd, ...r });
      }

      case "typecheck": {
        const project = input.project as string | undefined;
        let cmd = "";
        if (await sandbox.fileExists("tsconfig.json")) {
          cmd = project ? `npx tsc --noEmit -p '${project}'` : "npx tsc --noEmit";
        } else if (await sandbox.fileExists("Cargo.toml")) {
          cmd = "cargo check";
        } else if (await sandbox.fileExists("pyproject.toml")) {
          cmd = "python -m mypy .";
        } else {
          return JSON.stringify({ error: "no type-checker detected" });
        }
        const r = await sandbox.exec(cmd, { timeoutMs: 300_000 });
        return JSON.stringify({ command: cmd, ...r });
      }

      case "build_workspace_root": {
        const language = await detectLanguage(sandbox);
        const pkg = await detectPkgManager(sandbox);
        return JSON.stringify({
          build_id: sandbox.buildId,
          branch: sandbox.branch,
          base_branch: sandbox.baseBranch,
          source_repo: sandbox.sourceRepo,
          workspace_path: sandbox.workspacePath,
          language,
          package_manager: pkg,
        });
      }

      default:
        return JSON.stringify({ error: `unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

const IGNORE_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".cache", ".turbo",
  "coverage", "__pycache__", ".venv", "venv", "target", "out",
]);

async function listFiles(
  sandbox: Sandbox,
  subdir: string,
  maxResults: number
): Promise<string[]> {
  const fs = await import("fs/promises");
  const rootAbs = path.resolve(sandbox.workspacePath, subdir);
  if (!rootAbs.startsWith(sandbox.workspacePath)) return [];
  const out: string[] = [];
  const queue: string[] = [rootAbs];
  while (queue.length && out.length < maxResults) {
    const dir = queue.shift()!;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        queue.push(path.join(dir, e.name));
        continue;
      }
      out.push(path.relative(sandbox.workspacePath, path.join(dir, e.name)));
      if (out.length >= maxResults) break;
    }
  }
  return out;
}

function parseExtFilter(spec: string | undefined): Set<string> | null {
  if (!spec) return null;
  const m = spec.match(/^\.?\{([^}]+)\}$/);
  if (m) {
    return new Set(m[1].split(",").map((s) => "." + s.trim().replace(/^\./, "")));
  }
  return new Set([spec.startsWith(".") ? spec : "." + spec]);
}

interface SearchMatch {
  path: string;
  line: number;
  content: string;
}

async function searchFiles(
  sandbox: Sandbox,
  re: RegExp,
  extFilter: Set<string> | null,
  maxResults: number
): Promise<SearchMatch[]> {
  const fs = await import("fs/promises");
  const matches: SearchMatch[] = [];
  const queue: string[] = [sandbox.workspacePath];
  while (queue.length && matches.length < maxResults) {
    const dir = queue.shift()!;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (matches.length >= maxResults) break;
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        queue.push(abs);
        continue;
      }
      if (extFilter && !extFilter.has(path.extname(e.name))) continue;
      try {
        const stat = await fs.stat(abs);
        if (stat.size > 2 * 1024 * 1024) continue;
        const content = await fs.readFile(abs, "utf8");
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push({
              path: path.relative(sandbox.workspacePath, abs),
              line: i + 1,
              content: lines[i].slice(0, 500),
            });
            if (matches.length >= maxResults) break;
          }
        }
      } catch {
        // skip unreadable
      }
    }
  }
  return matches;
}

async function testCommand(
  sandbox: Sandbox,
  framework: string,
  pattern: string | undefined
): Promise<string | null> {
  let fw = framework;
  if (fw === "auto") {
    if (await sandbox.fileExists("Cargo.toml")) fw = "cargo";
    else if (
      (await sandbox.fileExists("pytest.ini")) ||
      (await sandbox.fileExists("pyproject.toml"))
    ) {
      fw = "pytest";
    } else if (await sandbox.fileExists("package.json")) {
      try {
        const pkg = JSON.parse(await sandbox.readFile("package.json")) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const all = { ...pkg.dependencies, ...pkg.devDependencies };
        if (all.vitest) fw = "vitest";
        else if (all.jest) fw = "jest";
        else if (all.mocha) fw = "mocha";
      } catch {
        // ignore
      }
    }
  }
  const pat = pattern ? ` '${pattern.replace(/'/g, "'\\''")}'` : "";
  switch (fw) {
    case "vitest":
      return `npx vitest run${pat}`;
    case "jest":
      return `npx jest${pat}`;
    case "mocha":
      return `npx mocha${pat}`;
    case "pytest":
      return `pytest${pat}`;
    case "cargo":
      return pattern ? `cargo test ${pat}` : "cargo test";
    default:
      return null;
  }
}

async function detectLanguage(sandbox: Sandbox): Promise<string> {
  if (await sandbox.fileExists("tsconfig.json")) return "typescript";
  if (await sandbox.fileExists("package.json")) return "javascript";
  if (await sandbox.fileExists("Cargo.toml")) return "rust";
  if (await sandbox.fileExists("go.mod")) return "go";
  if (await sandbox.fileExists("pyproject.toml")) return "python";
  if (await sandbox.fileExists("requirements.txt")) return "python";
  return "unknown";
}

async function detectPkgManager(sandbox: Sandbox): Promise<string> {
  if (await sandbox.fileExists("pnpm-lock.yaml")) return "pnpm";
  if (await sandbox.fileExists("yarn.lock")) return "yarn";
  if (await sandbox.fileExists("package-lock.json")) return "npm";
  if (await sandbox.fileExists("package.json")) return "npm";
  if (await sandbox.fileExists("Cargo.toml")) return "cargo";
  if (await sandbox.fileExists("poetry.lock")) return "poetry";
  return "unknown";
}

// Suppress unused-warning in case ExecResult isn't referenced inline:
export type _ExecResult = ExecResult;
