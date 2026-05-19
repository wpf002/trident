export type {
  ExecResult,
  ExecOptions,
  Sandbox,
  SandboxFactory,
  SandboxFactoryOpts,
  SnapshotId,
} from "./sandbox.js";

export { WorktreeSandboxFactory } from "./worktree.js";
export { DockerSandboxFactory } from "./docker.js";

export {
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  FORBIDDEN_ENV_KEYS,
  isDestructiveCommand,
} from "./limits.js";

import { WorktreeSandboxFactory } from "./worktree.js";
import { DockerSandboxFactory } from "./docker.js";
import type { SandboxFactory } from "./sandbox.js";

export type SandboxBackend = "worktree" | "docker";

export function createSandboxFactory(backend?: SandboxBackend): SandboxFactory {
  const resolved =
    backend ??
    ((process.env.TRIDENT_BUILDER_SANDBOX as SandboxBackend | undefined) ?? "worktree");
  switch (resolved) {
    case "worktree":
      return new WorktreeSandboxFactory();
    case "docker":
      return new DockerSandboxFactory();
    default:
      throw new Error(`unknown sandbox backend: ${resolved}`);
  }
}
