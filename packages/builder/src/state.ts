// Workspace lifecycle + registry sync. The builder owns the lifecycle:
//   - create: factory.create() + write registry entry so MCP server tools
//     can attach to this build's workspace from another process.
//   - attach: factory.attach() + ensure registry entry exists.
//   - destroy: factory.destroy() + remove registry entry.
//
// `prepareSourceRepo` makes the Builder usable in environments where the
// source repo is a remote URL (Railway, Docker, etc.) rather than a local
// path — it clones the URL into a persistent location under DATA_DIR and
// returns the local path that the factory should branch from.

import { execFile } from "child_process";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import {
  createSandboxFactory,
  type Sandbox,
  type SandboxFactory,
} from "@trident/builder-runtime";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Allow TRIDENT_DATA_DIR override so a Railway volume can be mounted
// elsewhere than /app/data.
const DATA_DIR = process.env.TRIDENT_DATA_DIR
  ? path.resolve(process.env.TRIDENT_DATA_DIR)
  : path.resolve(__dirname, "../../../data");
const BUILDS_ROOT = path.join(DATA_DIR, "builds");
const REPOS_ROOT = path.join(DATA_DIR, "builder-repos");
const REGISTRY_PATH = path.join(DATA_DIR, "builder-workspaces.json");

export function dataDir(): string {
  return DATA_DIR;
}

export function buildsRoot(): string {
  return BUILDS_ROOT;
}

export function ensureBuildsRoot(): void {
  if (!fs.existsSync(BUILDS_ROOT)) fs.mkdirSync(BUILDS_ROOT, { recursive: true });
}

// ─── Source repo preparation ──────────────────────────────────────────────

// Looks like a remote URL: https://, git://, git@host:owner/repo (SSH),
// or anything that's not an absolute/relative filesystem path.
function isRemoteUrl(s: string): boolean {
  if (s.startsWith("/") || s.startsWith("./") || s.startsWith("../")) return false;
  if (/^[a-z]:[\\/]/i.test(s)) return false;  // Windows drive letter
  return (
    s.startsWith("http://") ||
    s.startsWith("https://") ||
    s.startsWith("git://") ||
    s.startsWith("ssh://") ||
    /^git@[\w.-]+:/.test(s)
  );
}

function slugFromUrl(url: string): string {
  // Pull "owner-repo" from common URL shapes.
  const stripped = url.replace(/\.git$/, "").replace(/\/$/, "");
  const m =
    stripped.match(/[:/]([^/:]+)\/([^/]+)$/) ??
    stripped.match(/\/([^/]+)$/);
  if (!m) return "repo";
  const parts = m.slice(1).join("-");
  return parts.replace(/[^A-Za-z0-9._-]/g, "-").toLowerCase();
}

function authedUrl(url: string, token: string | undefined): string {
  if (!token) return url;
  if (url.startsWith("https://")) {
    // GitHub-style x-access-token auth — works for repo clone + push.
    return url.replace(
      /^https:\/\//,
      `https://x-access-token:${encodeURIComponent(token)}@`
    );
  }
  // SSH or other — token doesn't apply.
  return url;
}

// Ensure a local path exists that the worktree sandbox can use as source.
// If `repo` is already a local directory, return its absolute path.
// If `repo` is a URL, clone (or fast-forward) it under DATA_DIR/builder-repos
// and return that path. The TRIDENT_GITHUB_TOKEN env var, if set, is used
// for HTTPS clones — required for private repos.
export async function prepareSourceRepo(repo: string): Promise<string> {
  if (!isRemoteUrl(repo)) {
    return path.resolve(repo);
  }
  if (!fs.existsSync(REPOS_ROOT)) fs.mkdirSync(REPOS_ROOT, { recursive: true });
  const token = process.env.TRIDENT_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  const localPath = path.join(REPOS_ROOT, slugFromUrl(repo));
  const cloneUrl = authedUrl(repo, token);

  if (!fs.existsSync(path.join(localPath, ".git"))) {
    await execFileAsync("git", ["clone", "--no-tags", cloneUrl, localPath], {
      maxBuffer: 32 * 1024 * 1024,
    });
  } else {
    // Fast-forward existing clone. Best-effort — if the remote URL changed
    // (e.g. token rotated) we still want builds to proceed against the
    // last-known state.
    await execFileAsync("git", ["remote", "set-url", "origin", cloneUrl], {
      cwd: localPath,
    }).catch(() => undefined);
    await execFileAsync("git", ["fetch", "--prune", "origin"], {
      cwd: localPath,
      maxBuffer: 32 * 1024 * 1024,
    }).catch(() => undefined);
  }

  // Configure a default committer if one isn't already set, so commits don't
  // fail with "Author identity unknown" inside the worktree.
  const name = process.env.TRIDENT_BUILDER_GIT_USER_NAME || "Trident Builder";
  const email =
    process.env.TRIDENT_BUILDER_GIT_USER_EMAIL || "builder@trident.local";
  await execFileAsync("git", ["config", "user.name", name], { cwd: localPath }).catch(
    () => undefined
  );
  await execFileAsync("git", ["config", "user.email", email], { cwd: localPath }).catch(
    () => undefined
  );

  return localPath;
}

// ─── Defaults from env ───────────────────────────────────────────────────

// The deployed Trident on Railway can pin a single source repo via
// TRIDENT_BUILDER_DEFAULT_REPO. Pre-fills the UI and acts as the fallback
// when a build request omits source_repo.
export function defaultSourceRepo(): string | null {
  const v = process.env.TRIDENT_BUILDER_DEFAULT_REPO;
  return v && v.trim() ? v.trim() : null;
}

export function defaultBaseBranch(): string {
  return process.env.TRIDENT_BUILDER_DEFAULT_BASE_BRANCH || "main";
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
