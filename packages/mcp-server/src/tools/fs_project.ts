// Project-scoped filesystem tools. All operations are confined to the
// workspace resolved from the `workspace` token — the agent cannot read or
// write outside it. Distinct from `file_*` (which is locked to data/docs/).

import path from "path";
import fs from "fs/promises";
import type { ToolContext } from "../lib/builder-ctx.js";

const DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".pytest_cache",
  "target",      // rust
  "out",
]);

const DEFAULT_LIST_MAX = 1000;
const DEFAULT_READ_MAX_CHARS = 50_000;
const DEFAULT_SEARCH_MAX_RESULTS = 200;
const SEARCH_FILE_SIZE_CEILING = 2 * 1024 * 1024;

export const fsProjectTools = [
  {
    name: "project_list",
    description:
      "List files inside the active build workspace. Recursive by default; common build artefact directories (node_modules, .git, dist, etc.) are skipped. Returns a JSON array of paths relative to the workspace root.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Build workspace token" },
        subdirectory: {
          type: "string",
          description: "Optional subdirectory relative to workspace root",
        },
        max_results: {
          type: "number",
          description: `Cap on number of paths returned (default ${DEFAULT_LIST_MAX})`,
        },
      },
      required: ["workspace"],
    },
  },
  {
    name: "project_read",
    description:
      "Read a file from the active build workspace. Returns content plus size and truncated flag.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Build workspace token" },
        path: { type: "string", description: "Path relative to workspace root" },
        max_chars: {
          type: "number",
          description: `Truncate after this many characters (default ${DEFAULT_READ_MAX_CHARS})`,
        },
      },
      required: ["workspace", "path"],
    },
  },
  {
    name: "project_write",
    description:
      "Write a file in the active build workspace. Creates parent directories as needed. Overwrites existing content — use project_edit for surgical changes.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Build workspace token" },
        path: { type: "string", description: "Path relative to workspace root" },
        content: { type: "string", description: "File content (UTF-8)" },
      },
      required: ["workspace", "path", "content"],
    },
  },
  {
    name: "project_edit",
    description:
      "Replace an exact string in a workspace file. Fails if old_string is not present or appears more than once unless replace_all is true.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Build workspace token" },
        path: { type: "string", description: "Path relative to workspace root" },
        old_string: { type: "string", description: "The string to replace" },
        new_string: { type: "string", description: "Replacement string" },
        replace_all: {
          type: "boolean",
          description: "Replace every occurrence (default: false)",
        },
      },
      required: ["workspace", "path", "old_string", "new_string"],
    },
  },
  {
    name: "project_search",
    description:
      "Search for a regex pattern across files in the active build workspace. Returns matches with file path, line number, and matched line. Common artefact directories are skipped.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Build workspace token" },
        pattern: { type: "string", description: "JS regex source (no flags)" },
        case_insensitive: { type: "boolean", description: "Default: false" },
        include_glob: {
          type: "string",
          description:
            "Optional file-name extension filter, e.g. '.ts' or '.{ts,tsx}'",
        },
        max_results: {
          type: "number",
          description: `Max matches (default ${DEFAULT_SEARCH_MAX_RESULTS})`,
        },
      },
      required: ["workspace", "pattern"],
    },
  },
];

export async function handleFsProjectTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const workspace = String(args.workspace ?? "");
  const sandbox = await ctx.resolveSandbox(workspace);

  switch (name) {
    case "project_list": {
      const subdir = (args.subdirectory as string | undefined) ?? "";
      const maxResults = Math.min(
        (args.max_results as number | undefined) ?? DEFAULT_LIST_MAX,
        10_000
      );
      const rootAbs = path.resolve(sandbox.workspacePath, subdir);
      if (!rootAbs.startsWith(sandbox.workspacePath)) {
        return JSON.stringify({ error: "path escapes workspace" });
      }
      const files = await walkDir(rootAbs, sandbox.workspacePath, maxResults);
      return JSON.stringify({
        workspace,
        root: subdir || ".",
        count: files.length,
        truncated: files.length >= maxResults,
        files,
      });
    }

    case "project_read": {
      const rel = String(args.path ?? "");
      const maxChars = Math.min(
        (args.max_chars as number | undefined) ?? DEFAULT_READ_MAX_CHARS,
        500_000
      );
      try {
        const content = await sandbox.readFile(rel);
        const truncated = content.length > maxChars;
        return JSON.stringify({
          path: rel,
          size_chars: content.length,
          truncated,
          content: truncated ? content.slice(0, maxChars) : content,
        });
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
    }

    case "project_write": {
      const rel = String(args.path ?? "");
      const content = String(args.content ?? "");
      try {
        await sandbox.writeFile(rel, content);
        return JSON.stringify({ path: rel, bytes_written: content.length });
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
    }

    case "project_edit": {
      const rel = String(args.path ?? "");
      const oldStr = String(args.old_string ?? "");
      const newStr = String(args.new_string ?? "");
      const replaceAll = Boolean(args.replace_all ?? false);
      if (oldStr === "") {
        return JSON.stringify({ error: "old_string must be non-empty" });
      }
      try {
        const original = await sandbox.readFile(rel);
        const occurrences = countOccurrences(original, oldStr);
        if (occurrences === 0) {
          return JSON.stringify({ error: `old_string not found in ${rel}` });
        }
        if (!replaceAll && occurrences > 1) {
          return JSON.stringify({
            error: `old_string appears ${occurrences} times in ${rel}; use replace_all or a more specific old_string`,
          });
        }
        const updated = replaceAll
          ? original.split(oldStr).join(newStr)
          : original.replace(oldStr, newStr);
        await sandbox.writeFile(rel, updated);
        return JSON.stringify({
          path: rel,
          replacements: replaceAll ? occurrences : 1,
        });
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
    }

    case "project_search": {
      const pattern = String(args.pattern ?? "");
      if (!pattern) return JSON.stringify({ error: "pattern required" });
      const caseInsensitive = Boolean(args.case_insensitive ?? false);
      const includeGlob = args.include_glob as string | undefined;
      const maxResults = Math.min(
        (args.max_results as number | undefined) ?? DEFAULT_SEARCH_MAX_RESULTS,
        2000
      );
      let re: RegExp;
      try {
        re = new RegExp(pattern, caseInsensitive ? "i" : "");
      } catch (err) {
        return JSON.stringify({ error: `invalid regex: ${(err as Error).message}` });
      }
      const extFilter = parseExtFilter(includeGlob);
      const matches = await searchWorkspace(
        sandbox.workspacePath,
        re,
        extFilter,
        maxResults
      );
      return JSON.stringify({
        workspace,
        pattern,
        count: matches.length,
        truncated: matches.length >= maxResults,
        matches,
      });
    }

    default:
      throw new Error(`unknown fs_project tool: ${name}`);
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

async function walkDir(
  rootAbs: string,
  workspaceRoot: string,
  maxResults: number
): Promise<string[]> {
  const results: string[] = [];
  const queue: string[] = [rootAbs];
  while (queue.length && results.length < maxResults) {
    const dir = queue.shift()!;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name)) continue;
        queue.push(path.join(dir, entry.name));
        continue;
      }
      const abs = path.join(dir, entry.name);
      results.push(path.relative(workspaceRoot, abs));
      if (results.length >= maxResults) break;
    }
  }
  return results;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function parseExtFilter(spec: string | undefined): Set<string> | null {
  if (!spec) return null;
  // Accept ".ts" or ".{ts,tsx}" or "ts" or "{ts,tsx}".
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

async function searchWorkspace(
  workspaceRoot: string,
  re: RegExp,
  extFilter: Set<string> | null,
  maxResults: number
): Promise<SearchMatch[]> {
  const matches: SearchMatch[] = [];
  const queue: string[] = [workspaceRoot];
  while (queue.length && matches.length < maxResults) {
    const dir = queue.shift()!;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (matches.length >= maxResults) break;
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name)) continue;
        queue.push(abs);
        continue;
      }
      if (extFilter) {
        const ext = path.extname(entry.name);
        if (!extFilter.has(ext)) continue;
      }
      try {
        const stat = await fs.stat(abs);
        if (stat.size > SEARCH_FILE_SIZE_CEILING) continue;
        const content = await fs.readFile(abs, "utf8");
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push({
              path: path.relative(workspaceRoot, abs),
              line: i + 1,
              content: lines[i].slice(0, 500),
            });
            if (matches.length >= maxResults) break;
          }
        }
      } catch {
        // unreadable file — skip
      }
    }
  }
  return matches;
}
