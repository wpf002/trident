// Git tools operating inside the build sandbox's worktree. All run through
// sandbox.exec() so they share the destructive-pattern denylist and the
// scrubbed env. Push is deliberately NOT exposed — human action only.

import type { ToolContext } from "../lib/builder-ctx.js";

export const gitTools = [
  {
    name: "git_status",
    description: "Run `git status --porcelain=v1 -b` in the active workspace.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Build workspace token" },
      },
      required: ["workspace"],
    },
  },
  {
    name: "git_diff",
    description:
      "Show diff for the active workspace. With no args, shows working-tree diff. With `staged: true`, shows the index diff. With `path`, scopes to a single file.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Build workspace token" },
        staged: { type: "boolean", description: "Show staged diff" },
        path: { type: "string", description: "Limit to a single path" },
        unified: { type: "number", description: "Lines of context (default 3)" },
      },
      required: ["workspace"],
    },
  },
  {
    name: "git_log",
    description:
      "Show recent commits in the active workspace's branch. Returns oneline format with author and timestamp.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Build workspace token" },
        limit: { type: "number", description: "Max commits (default 20)" },
        path: { type: "string", description: "Limit to commits touching this path" },
      },
      required: ["workspace"],
    },
  },
  {
    name: "git_branch",
    description:
      "List, create, or switch branches inside the active workspace. Without `name`, lists branches. With `create: true` creates and switches. With just `name`, switches.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Build workspace token" },
        name: { type: "string", description: "Branch name" },
        create: { type: "boolean", description: "Create a new branch" },
        from: {
          type: "string",
          description: "Base commit/branch when creating (default: HEAD)",
        },
      },
      required: ["workspace"],
    },
  },
  {
    name: "git_commit",
    description:
      "Stage specified paths and create a commit on the current branch. Never uses `git add -A`; the caller must list every path explicitly. Push is not exposed via tools — that's a human action via the UI.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Build workspace token" },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Exact list of paths (relative) to stage",
        },
        message: { type: "string", description: "Commit message" },
        author_name: { type: "string", description: "Optional author name" },
        author_email: { type: "string", description: "Optional author email" },
        allow_empty: { type: "boolean", description: "Allow empty commit" },
      },
      required: ["workspace", "paths", "message"],
    },
  },
];

export async function handleGitTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const workspace = String(args.workspace ?? "");
  const sandbox = await ctx.resolveSandbox(workspace);

  switch (name) {
    case "git_status": {
      const r = await sandbox.exec("git status --porcelain=v1 -b");
      return JSON.stringify({
        exit_code: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
      });
    }

    case "git_diff": {
      const staged = Boolean(args.staged ?? false);
      const filePath = args.path as string | undefined;
      const unified = (args.unified as number | undefined) ?? 3;
      const parts = [
        "git",
        "diff",
        `--unified=${Math.max(0, Math.min(20, unified))}`,
      ];
      if (staged) parts.push("--cached");
      if (filePath) parts.push("--", quoteShell(filePath));
      const r = await sandbox.exec(parts.join(" "));
      return JSON.stringify({
        exit_code: r.exitCode,
        diff: r.stdout,
        stderr: r.stderr,
        truncated: r.truncated,
      });
    }

    case "git_log": {
      const limit = Math.max(1, Math.min(200, (args.limit as number | undefined) ?? 20));
      const filePath = args.path as string | undefined;
      const fmt = "%H%x00%an%x00%ae%x00%aI%x00%s";
      const parts = [
        "git",
        "log",
        `-n ${limit}`,
        `--pretty=format:${fmt}`,
      ];
      if (filePath) parts.push("--", quoteShell(filePath));
      const r = await sandbox.exec(parts.join(" "));
      if (r.exitCode !== 0) {
        return JSON.stringify({
          exit_code: r.exitCode,
          error: r.stderr,
        });
      }
      const commits = r.stdout
        .split("\n")
        .filter((l) => l.length > 0)
        .map((line) => {
          const [sha, an, ae, date, subject] = line.split("\x00");
          return { sha, author_name: an, author_email: ae, date, subject };
        });
      return JSON.stringify({ commits });
    }

    case "git_branch": {
      const branch = args.name as string | undefined;
      if (!branch) {
        const r = await sandbox.exec("git branch --list -a");
        const current = await sandbox.exec("git branch --show-current");
        return JSON.stringify({
          current: current.stdout.trim(),
          branches: r.stdout,
        });
      }
      if (!isSafeRef(branch)) {
        return JSON.stringify({ error: `unsafe branch name: ${branch}` });
      }
      if (args.create) {
        const from = (args.from as string | undefined) ?? "HEAD";
        if (!isSafeRef(from)) {
          return JSON.stringify({ error: `unsafe ref: ${from}` });
        }
        const r = await sandbox.exec(
          `git checkout -b ${quoteShell(branch)} ${quoteShell(from)}`
        );
        return JSON.stringify({
          exit_code: r.exitCode,
          stdout: r.stdout,
          stderr: r.stderr,
        });
      }
      const r = await sandbox.exec(`git checkout ${quoteShell(branch)}`);
      return JSON.stringify({
        exit_code: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
      });
    }

    case "git_commit": {
      const paths = (args.paths as string[] | undefined) ?? [];
      const message = String(args.message ?? "");
      const allowEmpty = Boolean(args.allow_empty ?? false);
      if (!Array.isArray(paths) || paths.length === 0) {
        return JSON.stringify({ error: "paths[] must be non-empty" });
      }
      if (!message.trim()) {
        return JSON.stringify({ error: "message required" });
      }
      for (const p of paths) {
        if (typeof p !== "string" || p.includes("..") || p.startsWith("/")) {
          return JSON.stringify({ error: `unsafe path: ${p}` });
        }
      }
      const stage = await sandbox.exec(
        `git add -- ${paths.map(quoteShell).join(" ")}`
      );
      if (stage.exitCode !== 0) {
        return JSON.stringify({
          stage: { exit_code: stage.exitCode, stderr: stage.stderr },
        });
      }
      const env: Record<string, string> = {};
      if (typeof args.author_name === "string") env.GIT_AUTHOR_NAME = args.author_name;
      if (typeof args.author_email === "string") env.GIT_AUTHOR_EMAIL = args.author_email;
      if (env.GIT_AUTHOR_NAME) env.GIT_COMMITTER_NAME = env.GIT_AUTHOR_NAME;
      if (env.GIT_AUTHOR_EMAIL) env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOR_EMAIL;
      const commitCmd =
        `git commit -m ${quoteShell(message)}` + (allowEmpty ? " --allow-empty" : "");
      const r = await sandbox.exec(commitCmd, { env });
      if (r.exitCode !== 0) {
        return JSON.stringify({
          commit: { exit_code: r.exitCode, stdout: r.stdout, stderr: r.stderr },
        });
      }
      const sha = await sandbox.exec("git rev-parse HEAD");
      return JSON.stringify({
        commit: {
          exit_code: 0,
          sha: sha.stdout.trim(),
          stdout: r.stdout,
        },
      });
    }

    default:
      throw new Error(`unknown git tool: ${name}`);
  }
}

function isSafeRef(ref: string): boolean {
  // Conservative: alphanumeric, slash, dash, underscore, dot. No spaces or
  // shell metacharacters. Rejects empty + leading/trailing dots.
  if (!ref || ref.length > 255) return false;
  if (!/^[A-Za-z0-9._\-/]+$/.test(ref)) return false;
  if (ref.startsWith(".") || ref.endsWith(".")) return false;
  if (ref.includes("..")) return false;
  return true;
}

function quoteShell(s: string): string {
  // POSIX single-quote escape: wrap, and replace any internal ' with '\''
  return `'${s.replace(/'/g, "'\\''")}'`;
}
