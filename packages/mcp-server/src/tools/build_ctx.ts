// build_workspace_root — one-shot orientation tool. The agent calls it at
// the start of each step so it doesn't waste tokens rediscovering basics:
// language hints, package manager, current branch, source repo.

import type { ToolContext } from "../lib/builder-ctx.js";
import type { Sandbox } from "@trident/builder-runtime";

export const buildCtxTools = [
  {
    name: "build_workspace_root",
    description:
      "Return metadata about the active build workspace: paths, branch, base, detected package manager, and detected primary language. Call this once per step before navigating the codebase.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Build workspace token" },
      },
      required: ["workspace"],
    },
  },
];

export async function handleBuildCtxTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  if (name !== "build_workspace_root") {
    throw new Error(`unknown build_ctx tool: ${name}`);
  }
  const workspace = String(args.workspace ?? "");
  const sandbox = await ctx.resolveSandbox(workspace);
  const [language, packageManager] = await Promise.all([
    detectLanguage(sandbox),
    detectPackageManager(sandbox),
  ]);
  return JSON.stringify({
    workspace,
    build_id: sandbox.buildId,
    branch: sandbox.branch,
    base_branch: sandbox.baseBranch,
    source_repo: sandbox.sourceRepo,
    workspace_path: sandbox.workspacePath,
    language,
    package_manager: packageManager,
  });
}

async function detectLanguage(sandbox: Sandbox): Promise<string> {
  if (await sandbox.fileExists("tsconfig.json")) return "typescript";
  if (await sandbox.fileExists("package.json")) return "javascript";
  if (await sandbox.fileExists("Cargo.toml")) return "rust";
  if (await sandbox.fileExists("go.mod")) return "go";
  if (await sandbox.fileExists("pyproject.toml")) return "python";
  if (await sandbox.fileExists("requirements.txt")) return "python";
  if (await sandbox.fileExists("Gemfile")) return "ruby";
  return "unknown";
}

async function detectPackageManager(sandbox: Sandbox): Promise<string> {
  if (await sandbox.fileExists("pnpm-lock.yaml")) return "pnpm";
  if (await sandbox.fileExists("yarn.lock")) return "yarn";
  if (await sandbox.fileExists("package-lock.json")) return "npm";
  if (await sandbox.fileExists("package.json")) return "npm";
  if (await sandbox.fileExists("Cargo.toml")) return "cargo";
  if (await sandbox.fileExists("poetry.lock")) return "poetry";
  if (await sandbox.fileExists("requirements.txt")) return "pip";
  return "unknown";
}
