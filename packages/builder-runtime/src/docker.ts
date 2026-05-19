// Docker-backed sandbox — stub for v2.
//
// The plan: bind-mount the worktree read-write into a container, set
// --network=none by default, run shell_exec via `docker exec`, and use the
// same git stash mechanism for snapshots (operating on the bind-mounted
// path, which the host can see).
//
// The interface is identical to WorktreeSandbox so the builder loop won't
// change. Wiring is gated on TRIDENT_BUILDER_SANDBOX=docker.

import type { Sandbox, SandboxFactory, SandboxFactoryOpts } from "./sandbox.js";

export class DockerSandboxFactory implements SandboxFactory {
  async create(_opts: SandboxFactoryOpts): Promise<Sandbox> {
    throw new Error("DockerSandboxFactory not implemented — v2");
  }
  async attach(_opts: SandboxFactoryOpts): Promise<Sandbox> {
    throw new Error("DockerSandboxFactory not implemented — v2");
  }
}
