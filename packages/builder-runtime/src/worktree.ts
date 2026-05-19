// Worktree-backed sandbox. v1 isolation strategy:
//   - The build runs in a git worktree off `data/builds/<id>/workspace`, on a
//     branch named `builder/<id>`. The agent never sees the source repo's
//     working tree.
//   - shell_exec inherits a minimal env (no host secrets) and a wall-clock
//     timeout. Output is capped at MAX_OUTPUT_BYTES.
//   - Destructive command patterns are refused before spawn.
//   - Snapshots use `git stash create` to capture working-tree state cheaply.
//
// Things this does NOT protect against (see §4 sandboxing notes):
//   - Network egress
//   - Resource exhaustion via legitimate-looking processes
//   - Symlinks pointing outside the workspace
// Those are accepted v1 gaps; the cost/wall-clock ceilings cap blast radius.

import { spawn, execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";

import {
  buildChildEnv,
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  isDestructiveCommand,
} from "./limits.js";
import type {
  ExecOptions,
  ExecResult,
  Sandbox,
  SandboxFactory,
  SandboxFactoryOpts,
  SnapshotId,
} from "./sandbox.js";

const execFileAsync = promisify(execFile);

interface SnapshotRecord {
  id: SnapshotId;
  label: string;
  // Either a stash commit SHA (working tree had changes) or null (clean — the
  // workspace was at HEAD with no uncommitted edits at snapshot time).
  stashSha: string | null;
  // HEAD at snapshot time. Used by restore() to reset committed state too.
  headSha: string;
  createdAt: string;
}

interface SnapshotFile {
  snapshots: SnapshotRecord[];
}

// `git` helper — runs against a worktree directory. Throws on non-zero exit
// so callers can rely on success.
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const msg = e.stderr?.trim() || e.message;
    throw new Error(`git ${args.join(" ")} failed: ${msg}`);
  }
}

class WorktreeSandbox implements Sandbox {
  readonly id: string;
  readonly buildId: string;
  readonly branch: string;
  readonly workspacePath: string;
  readonly baseBranch: string;
  readonly sourceRepo: string;
  private readonly snapshotsPath: string;
  private destroyed = false;

  constructor(opts: {
    id: string;
    buildId: string;
    branch: string;
    workspacePath: string;
    baseBranch: string;
    sourceRepo: string;
  }) {
    this.id = opts.id;
    this.buildId = opts.buildId;
    this.branch = opts.branch;
    this.workspacePath = opts.workspacePath;
    this.baseBranch = opts.baseBranch;
    this.sourceRepo = opts.sourceRepo;
    this.snapshotsPath = path.join(path.dirname(this.workspacePath), "snapshots.json");
  }

  // ─── path safety ────────────────────────────────────────────────────────

  private resolveSafe(relPath: string): string {
    const resolved = path.resolve(this.workspacePath, relPath);
    if (!resolved.startsWith(this.workspacePath + path.sep) && resolved !== this.workspacePath) {
      throw new Error(`path escapes workspace: ${relPath}`);
    }
    return resolved;
  }

  // ─── exec ───────────────────────────────────────────────────────────────

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    this.assertAlive();

    const start = Date.now();
    const destructive = isDestructiveCommand(command);
    if (destructive) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: `refused: command matches destructive pattern ${destructive.source}`,
        durationMs: Date.now() - start,
        timedOut: false,
        truncated: false,
        refused: { reason: "destructive_command", pattern: destructive.source },
      };
    }

    const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS);
    const cwd = opts.cwd ? this.resolveSafe(opts.cwd) : this.workspacePath;
    const env = buildChildEnv(this.workspacePath, opts.env);

    return new Promise<ExecResult>((resolve) => {
      const child = spawn(command, [], {
        cwd,
        env,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        // Try graceful, then hard.
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 2000);
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdoutBytes >= MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
        if (chunk.length > remaining) {
          stdout += chunk.subarray(0, remaining).toString("utf8");
          stdoutBytes = MAX_OUTPUT_BYTES;
          truncated = true;
        } else {
          stdout += chunk.toString("utf8");
          stdoutBytes += chunk.length;
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrBytes >= MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        const remaining = MAX_OUTPUT_BYTES - stderrBytes;
        if (chunk.length > remaining) {
          stderr += chunk.subarray(0, remaining).toString("utf8");
          stderrBytes = MAX_OUTPUT_BYTES;
          truncated = true;
        } else {
          stderr += chunk.toString("utf8");
          stderrBytes += chunk.length;
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          exitCode: -1,
          stdout,
          stderr: stderr + `\n[runtime error] ${err.message}`,
          durationMs: Date.now() - start,
          timedOut,
          truncated,
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? -1,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          timedOut,
          truncated,
        });
      });
    });
  }

  // ─── files ──────────────────────────────────────────────────────────────

  async readFile(relPath: string): Promise<string> {
    this.assertAlive();
    const abs = this.resolveSafe(relPath);
    // Refuse symlinks — easiest way to escape the workspace via fs APIs.
    const stat = await fs.lstat(abs);
    if (stat.isSymbolicLink()) {
      throw new Error(`refused: ${relPath} is a symlink`);
    }
    return fs.readFile(abs, "utf8");
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    this.assertAlive();
    const abs = this.resolveSafe(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }

  async fileExists(relPath: string): Promise<boolean> {
    this.assertAlive();
    try {
      const abs = this.resolveSafe(relPath);
      await fs.access(abs);
      return true;
    } catch {
      return false;
    }
  }

  // ─── snapshots ──────────────────────────────────────────────────────────

  async snapshot(label: string): Promise<SnapshotId> {
    this.assertAlive();
    const id = `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const headSha = await git(this.workspacePath, ["rev-parse", "HEAD"]);
    // `git stash create` produces a stash commit but does NOT touch the
    // working tree. Empty string output → workspace is clean, no stash needed.
    const stashSha = (
      await git(this.workspacePath, ["stash", "create", `trident:${label}`])
    ).trim();
    if (stashSha) {
      await git(this.workspacePath, [
        "update-ref",
        `refs/builder/snapshots/${id}`,
        stashSha,
      ]);
    }
    await this.appendSnapshot({
      id,
      label,
      stashSha: stashSha || null,
      headSha,
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  async restore(snapshotId: SnapshotId): Promise<void> {
    this.assertAlive();
    const records = await this.readSnapshots();
    const rec = records.find((r) => r.id === snapshotId);
    if (!rec) throw new Error(`unknown snapshot: ${snapshotId}`);

    // Reset committed state back to where it was at snapshot time. This is
    // safe inside a builder worktree because only the builder branch lives
    // here — no other process is consuming it.
    await git(this.workspacePath, ["reset", "--hard", rec.headSha]);
    // Drop everything not tracked at that point. -fdx removes ignored files
    // too; agent has no business preserving them across a rollback.
    await git(this.workspacePath, ["clean", "-fdx"]);

    if (rec.stashSha) {
      // `git stash apply` against a clean tree replays the working changes
      // captured at snapshot time.
      await git(this.workspacePath, ["stash", "apply", "--index", rec.stashSha]);
    }
  }

  async listSnapshots(): Promise<Array<{ id: SnapshotId; label: string; createdAt: string }>> {
    const records = await this.readSnapshots();
    return records.map(({ id, label, createdAt }) => ({ id, label, createdAt }));
  }

  private async readSnapshots(): Promise<SnapshotRecord[]> {
    try {
      const raw = await fs.readFile(this.snapshotsPath, "utf8");
      return (JSON.parse(raw) as SnapshotFile).snapshots;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  private async appendSnapshot(rec: SnapshotRecord): Promise<void> {
    const records = await this.readSnapshots();
    records.push(rec);
    // Keep last 20 (§4) — older ones get their refs garbage-collected too.
    const KEEP = 20;
    if (records.length > KEEP) {
      const removed = records.splice(0, records.length - KEEP);
      for (const r of removed) {
        if (r.stashSha) {
          await git(this.workspacePath, [
            "update-ref",
            "-d",
            `refs/builder/snapshots/${r.id}`,
          ]).catch(() => undefined);
        }
      }
    }
    await fs.mkdir(path.dirname(this.snapshotsPath), { recursive: true });
    await fs.writeFile(
      this.snapshotsPath,
      JSON.stringify({ snapshots: records } satisfies SnapshotFile, null, 2)
    );
  }

  // ─── lifecycle ──────────────────────────────────────────────────────────

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    // `git worktree remove` is run against the source repo. --force allows
    // removal even with uncommitted changes (we don't preserve them; the
    // caller is expected to commit anything they care about before destroy).
    await git(this.sourceRepo, ["worktree", "remove", "--force", this.workspacePath]).catch(
      () => undefined
    );
  }

  private assertAlive() {
    if (this.destroyed) throw new Error(`sandbox ${this.id} has been destroyed`);
  }
}

// ─── factory ──────────────────────────────────────────────────────────────

async function assertGitRepo(repoPath: string): Promise<void> {
  try {
    const out = await git(repoPath, ["rev-parse", "--is-inside-work-tree"]);
    if (out !== "true") throw new Error("not inside a git work tree");
  } catch (err) {
    throw new Error(`${repoPath} is not a git repository: ${(err as Error).message}`);
  }
}

export class WorktreeSandboxFactory implements SandboxFactory {
  async create(opts: SandboxFactoryOpts): Promise<Sandbox> {
    const sourceRepo = path.resolve(opts.sourceRepo);
    await assertGitRepo(sourceRepo);

    const buildDir = path.resolve(opts.workspaceRoot, opts.buildId);
    const workspacePath = path.join(buildDir, "workspace");
    const branch = `builder/${opts.buildId}`;

    await fs.mkdir(buildDir, { recursive: true });

    // Refuse if the workspace already exists — caller should use attach().
    try {
      await fs.access(workspacePath);
      throw new Error(`workspace already exists: ${workspacePath} (use attach())`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    await git(sourceRepo, [
      "worktree",
      "add",
      "-b",
      branch,
      workspacePath,
      opts.baseBranch,
    ]);

    return new WorktreeSandbox({
      id: opts.buildId,
      buildId: opts.buildId,
      branch,
      workspacePath,
      baseBranch: opts.baseBranch,
      sourceRepo,
    });
  }

  async attach(opts: SandboxFactoryOpts): Promise<Sandbox> {
    const sourceRepo = path.resolve(opts.sourceRepo);
    await assertGitRepo(sourceRepo);

    const buildDir = path.resolve(opts.workspaceRoot, opts.buildId);
    const workspacePath = path.join(buildDir, "workspace");
    const branch = `builder/${opts.buildId}`;

    try {
      await fs.access(workspacePath);
    } catch {
      throw new Error(`cannot attach: workspace missing at ${workspacePath}`);
    }

    // Verify the worktree is still registered with the source repo.
    const worktrees = await git(sourceRepo, ["worktree", "list", "--porcelain"]);
    if (!worktrees.includes(workspacePath)) {
      throw new Error(
        `worktree at ${workspacePath} is no longer registered with ${sourceRepo}`
      );
    }

    return new WorktreeSandbox({
      id: opts.buildId,
      buildId: opts.buildId,
      branch,
      workspacePath,
      baseBranch: opts.baseBranch,
      sourceRepo,
    });
  }
}
