// Bridge between MCP tool handlers and the builder-runtime sandbox layer.
//
// The MCP server can't hold long-lived sandbox handles — tool calls are
// stateless requests from external clients (Claude Desktop, ChatGPT) and from
// the builder running in-process. Resolution flow:
//
//   1. Builder creates a sandbox via WorktreeSandboxFactory.create(...)
//      and writes a registry entry to data/builder-workspaces.json.
//   2. Any caller invoking an MCP tool passes `workspace: "<build_id>"`.
//   3. The handler looks up the registry and either:
//        - reuses an in-process Sandbox (when called by the builder), or
//        - calls factory.attach(...) to reopen it (when called over stdio).
//
// In-process callers (the builder) pass their own ToolContext that short-
// circuits the registry lookup. External callers get the default ctx.

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  WorktreeSandboxFactory,
  type Sandbox,
  type SandboxFactory,
} from "@trident/builder-runtime";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../../../data");
const REGISTRY_PATH = path.join(DATA_DIR, "builder-workspaces.json");
const BUILDS_ROOT = path.join(DATA_DIR, "builds");

export interface WorkspaceRegistryEntry {
  buildId: string;
  sourceRepo: string;
  baseBranch: string;
  workspaceRoot: string;
  createdAt: string;
}

export interface WorkspaceRegistryFile {
  workspaces: Record<string, WorkspaceRegistryEntry>;
}

export interface ToolContext {
  // Resolve a workspace token to a Sandbox handle. Each call returns a usable
  // Sandbox — for the default ctx that means a fresh attach(); for in-process
  // builder contexts it returns the cached handle.
  resolveSandbox(workspace: string): Promise<Sandbox>;
}

// ─── Registry I/O ─────────────────────────────────────────────────────────

export async function readRegistry(): Promise<WorkspaceRegistryFile> {
  try {
    const raw = await fsp.readFile(REGISTRY_PATH, "utf8");
    return JSON.parse(raw) as WorkspaceRegistryFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { workspaces: {} };
    }
    throw err;
  }
}

export async function writeRegistry(file: WorkspaceRegistryFile): Promise<void> {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  await fsp.writeFile(REGISTRY_PATH, JSON.stringify(file, null, 2));
}

export async function registerWorkspace(entry: WorkspaceRegistryEntry): Promise<void> {
  const file = await readRegistry();
  file.workspaces[entry.buildId] = entry;
  await writeRegistry(file);
}

export async function unregisterWorkspace(buildId: string): Promise<void> {
  const file = await readRegistry();
  delete file.workspaces[buildId];
  await writeRegistry(file);
}

// ─── Default context (stdio MCP server) ───────────────────────────────────

export function createDefaultToolContext(opts?: {
  factory?: SandboxFactory;
}): ToolContext {
  const factory = opts?.factory ?? new WorktreeSandboxFactory();
  return {
    async resolveSandbox(workspace: string): Promise<Sandbox> {
      if (!workspace || typeof workspace !== "string") {
        throw new Error("no_active_workspace: 'workspace' argument is required");
      }
      const file = await readRegistry();
      const entry = file.workspaces[workspace];
      if (!entry) {
        throw new Error(`no_active_workspace: '${workspace}' not in registry`);
      }
      return factory.attach({
        sourceRepo: entry.sourceRepo,
        baseBranch: entry.baseBranch,
        buildId: entry.buildId,
        workspaceRoot: entry.workspaceRoot ?? BUILDS_ROOT,
      });
    },
  };
}
