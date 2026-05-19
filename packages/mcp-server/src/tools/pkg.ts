// Package manager dispatch. Detects npm/pnpm/yarn (Node), cargo (Rust),
// pip/poetry (Python) from manifest files in the workspace and routes
// install/run to the right binary. Wraps sandbox.exec so the timeout
// and env scrubbing apply.

import type { ToolContext } from "../lib/builder-ctx.js";
import type { Sandbox } from "@trident/builder-runtime";

export const pkgTools = [
  {
    name: "pkg_install",
    description:
      "Install packages into the active workspace. The package manager is auto-detected from manifest files (package.json + lockfile, Cargo.toml, pyproject.toml, requirements.txt). With no packages, runs the manager's default install (e.g. `npm install`).",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Build workspace token" },
        packages: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of packages to add (default: run lockfile install)",
        },
        dev: { type: "boolean", description: "Add as dev dependency (Node only)" },
        timeout_ms: { type: "number", description: "Override timeout (default 180000)" },
      },
      required: ["workspace"],
    },
  },
  {
    name: "pkg_run",
    description:
      "Run a script defined in the project's manifest. For Node, this is a `package.json` script (npm/pnpm/yarn run); for Cargo, `cargo <script>`; for Python with poetry, `poetry run <script>`.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Build workspace token" },
        script: { type: "string", description: "Script name" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Args appended after the script",
        },
        timeout_ms: { type: "number", description: "Override timeout (default 180000)" },
      },
      required: ["workspace", "script"],
    },
  },
];

type PkgManager =
  | "npm"
  | "pnpm"
  | "yarn"
  | "cargo"
  | "poetry"
  | "pip"
  | "unknown";

async function detectManager(sandbox: Sandbox): Promise<PkgManager> {
  if (await sandbox.fileExists("pnpm-lock.yaml")) return "pnpm";
  if (await sandbox.fileExists("yarn.lock")) return "yarn";
  if (await sandbox.fileExists("package-lock.json")) return "npm";
  if (await sandbox.fileExists("package.json")) return "npm";
  if (await sandbox.fileExists("Cargo.toml")) return "cargo";
  if (await sandbox.fileExists("poetry.lock") || await sandbox.fileExists("pyproject.toml")) {
    return "poetry";
  }
  if (await sandbox.fileExists("requirements.txt")) return "pip";
  return "unknown";
}

export async function handlePkgTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const workspace = String(args.workspace ?? "");
  const sandbox = await ctx.resolveSandbox(workspace);
  const manager = await detectManager(sandbox);
  const timeoutMs = (args.timeout_ms as number | undefined) ?? 180_000;

  switch (name) {
    case "pkg_install": {
      const packages = (args.packages as string[] | undefined) ?? [];
      const dev = Boolean(args.dev ?? false);
      const cmd = installCommand(manager, packages, dev);
      if (!cmd) {
        return JSON.stringify({
          error: `no package manager detected for workspace`,
          detected: manager,
        });
      }
      const r = await sandbox.exec(cmd, { timeoutMs });
      return JSON.stringify({
        manager,
        command: cmd,
        exit_code: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        duration_ms: r.durationMs,
        timed_out: r.timedOut,
      });
    }

    case "pkg_run": {
      const script = String(args.script ?? "");
      if (!script) return JSON.stringify({ error: "script required" });
      const scriptArgs = (args.args as string[] | undefined) ?? [];
      const cmd = runCommand(manager, script, scriptArgs);
      if (!cmd) {
        return JSON.stringify({
          error: `no package manager detected`,
          detected: manager,
        });
      }
      const r = await sandbox.exec(cmd, { timeoutMs });
      return JSON.stringify({
        manager,
        command: cmd,
        exit_code: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        duration_ms: r.durationMs,
        timed_out: r.timedOut,
      });
    }

    default:
      throw new Error(`unknown pkg tool: ${name}`);
  }
}

function installCommand(
  manager: PkgManager,
  packages: string[],
  dev: boolean
): string | null {
  const safePkgs = packages.filter(isSafePackageName).map((p) => `'${p}'`);
  switch (manager) {
    case "npm":
      return packages.length
        ? `npm install ${dev ? "--save-dev " : ""}${safePkgs.join(" ")}`
        : "npm install";
    case "pnpm":
      return packages.length
        ? `pnpm add ${dev ? "-D " : ""}${safePkgs.join(" ")}`
        : "pnpm install";
    case "yarn":
      return packages.length
        ? `yarn add ${dev ? "-D " : ""}${safePkgs.join(" ")}`
        : "yarn install";
    case "cargo":
      return packages.length
        ? `cargo add ${safePkgs.join(" ")}`
        : "cargo fetch";
    case "poetry":
      return packages.length
        ? `poetry add ${dev ? "--group dev " : ""}${safePkgs.join(" ")}`
        : "poetry install";
    case "pip":
      return packages.length
        ? `pip install ${safePkgs.join(" ")}`
        : "pip install -r requirements.txt";
    default:
      return null;
  }
}

function runCommand(
  manager: PkgManager,
  script: string,
  scriptArgs: string[]
): string | null {
  if (!isSafeScriptName(script)) return null;
  const safeArgs = scriptArgs
    .filter((a) => typeof a === "string")
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`);
  const tail = safeArgs.length ? " " + safeArgs.join(" ") : "";
  switch (manager) {
    case "npm":
      return `npm run ${script} --${tail}`;
    case "pnpm":
      return `pnpm run ${script}${tail}`;
    case "yarn":
      return `yarn run ${script}${tail}`;
    case "cargo":
      return `cargo ${script}${tail}`;
    case "poetry":
      return `poetry run ${script}${tail}`;
    case "pip":
      return `python -m ${script}${tail}`;
    default:
      return null;
  }
}

function isSafePackageName(name: string): boolean {
  // npm/cargo/pip name shape — letters, digits, dashes, underscores, dots,
  // slashes (for scoped), @ (for scoped). Reject anything with shell meta.
  return /^[@A-Za-z0-9._/~^=<>\-]+$/.test(name) && name.length < 200;
}

function isSafeScriptName(name: string): boolean {
  return /^[A-Za-z0-9._:\-]+$/.test(name) && name.length < 100;
}
