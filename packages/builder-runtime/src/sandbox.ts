// The Sandbox interface. Worktree and (later) Docker implementations satisfy
// this shape; the rest of the builder only depends on the interface so the
// isolation backend can be swapped without touching the agent loop.

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  refused?: { reason: "destructive_command"; pattern: string };
}

export interface ExecOptions {
  // Relative to sandbox workspace root. Defaults to workspace root.
  cwd?: string;
  timeoutMs?: number;
  // Merged onto the sandbox's safe env. Forbidden keys (see limits.ts) are
  // silently dropped.
  env?: Record<string, string>;
}

export type SnapshotId = string;

export interface Sandbox {
  readonly id: string;
  readonly buildId: string;
  readonly branch: string;
  readonly workspacePath: string;
  readonly baseBranch: string;
  readonly sourceRepo: string;

  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;

  readFile(relPath: string): Promise<string>;
  writeFile(relPath: string, content: string): Promise<void>;
  fileExists(relPath: string): Promise<boolean>;

  // Snapshot/restore the workspace. Implemented via `git stash` in the
  // worktree backend — cheap and granular. Snapshots survive across
  // exec() calls but not across destroy().
  snapshot(label: string): Promise<SnapshotId>;
  restore(snapshotId: SnapshotId): Promise<void>;
  listSnapshots(): Promise<Array<{ id: SnapshotId; label: string; createdAt: string }>>;

  // Remove the worktree (or stop the container). Idempotent — calling
  // destroy() twice is safe.
  destroy(): Promise<void>;
}

export interface SandboxFactoryOpts {
  // Absolute path to the source repo to branch from.
  sourceRepo: string;
  // Base branch to create the builder branch from (e.g. "main").
  baseBranch: string;
  // The build ID — used to name the branch and workspace directory.
  buildId: string;
  // Where to place the workspace. The factory creates
  //   <workspaceRoot>/<buildId>/workspace
  // and writes logs/snapshots/cache siblings to it.
  workspaceRoot: string;
}

export interface SandboxFactory {
  create(opts: SandboxFactoryOpts): Promise<Sandbox>;
  // Reattach to a workspace that was created in a prior process. Used by
  // `trident build resume <id>`.
  attach(opts: SandboxFactoryOpts): Promise<Sandbox>;
}
