// Workspace lifecycle + registry sync. The builder owns the lifecycle:
//   - create: factory.create() + write registry entry so MCP server tools
//     can attach to this build's workspace from another process.
//   - attach: factory.attach() + ensure registry entry exists.
//   - destroy: factory.destroy() + remove registry entry.

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  createSandboxFactory,
  type Sandbox,
  type SandboxFactory,
} from "@trident/builder-runtime";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../../data");
const BUILDS_ROOT = path.join(DATA_DIR, "builds");
const REGISTRY_PATH = path.join(DATA_DIR, "builder-workspaces.json");

export function buildsRoot(): string {
  return BUILDS_ROOT;
}

export function ensureBuildsRoot(): void {
  if (!fs.existsSync(BUILDS_ROOT)) fs.mkdirSync(BUILDS_ROOT, { recursive: true });
}

interface RegistryEntry {
  buildId: string;
  sourceRepo: string;
  baseBranch: string;
  workspaceRoot: string;
  createdAt: string;
}

interface RegistryFile {
  workspaces: Record<string, RegistryEntry>;
}

async function readRegistry(): Promise<RegistryFile> {
  try {
    const raw = await fsp.readFile(REGISTRY_PATH, "utf8");
    return JSON.parse(raw) as RegistryFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { workspaces: {} };
    }
    throw err;
  }
}

async function writeRegistry(file: RegistryFile): Promise<void> {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  await fsp.writeFile(REGISTRY_PATH, JSON.stringify(file, null, 2));
}

export async function registerWorkspace(entry: RegistryEntry): Promise<void> {
  const file = await readRegistry();
  file.workspaces[entry.buildId] = entry;
  await writeRegistry(file);
}

export async function unregisterWorkspace(buildId: string): Promise<void> {
  const file = await readRegistry();
  delete file.workspaces[buildId];
  await writeRegistry(file);
}

// ─── Sandbox lifecycle ────────────────────────────────────────────────────

export async function createWorkspace(opts: {
  buildId: string;
  sourceRepo: string;
  baseBranch: string;
  factory?: SandboxFactory;
}): Promise<Sandbox> {
  ensureBuildsRoot();
  const factory = opts.factory ?? createSandboxFactory();
  const sandbox = await factory.create({
    sourceRepo: opts.sourceRepo,
    baseBranch: opts.baseBranch,
    buildId: opts.buildId,
    workspaceRoot: BUILDS_ROOT,
  });
  await registerWorkspace({
    buildId: opts.buildId,
    sourceRepo: opts.sourceRepo,
    baseBranch: opts.baseBranch,
    workspaceRoot: BUILDS_ROOT,
    createdAt: new Date().toISOString(),
  });
  return sandbox;
}

export async function attachWorkspace(opts: {
  buildId: string;
  sourceRepo: string;
  baseBranch: string;
  factory?: SandboxFactory;
}): Promise<Sandbox> {
  const factory = opts.factory ?? createSandboxFactory();
  return factory.attach({
    sourceRepo: opts.sourceRepo,
    baseBranch: opts.baseBranch,
    buildId: opts.buildId,
    workspaceRoot: BUILDS_ROOT,
  });
}

export async function destroyWorkspace(
  buildId: string,
  sandbox: Sandbox
): Promise<void> {
  await sandbox.destroy().catch(() => undefined);
  await unregisterWorkspace(buildId);
}
