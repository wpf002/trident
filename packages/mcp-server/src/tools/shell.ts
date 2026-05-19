// shell_exec — bounded command execution inside the build sandbox. The
// runtime enforces timeout, output cap, env scrubbing, and destructive-
// pattern refusal; this handler is just the MCP-facing shape.

import type { ToolContext } from "../lib/builder-ctx.js";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
} from "@trident/builder-runtime";

export const shellTools = [
  {
    name: "shell_exec",
    description:
      "Run a shell command inside the active build workspace. Has access to the workspace files but not the host filesystem; no host secrets are forwarded; output is capped; commands matching a destructive-pattern denylist are refused. Returns exit code, stdout, stderr, and timing.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Build workspace token" },
        command: { type: "string", description: "Shell command to run" },
        cwd: {
          type: "string",
          description: "Working directory relative to workspace root (default: root)",
        },
        timeout_ms: {
          type: "number",
          description: `Wall-clock timeout (default ${DEFAULT_EXEC_TIMEOUT_MS}, max ${MAX_EXEC_TIMEOUT_MS})`,
        },
        env: {
          type: "object",
          description:
            "Extra env vars to set for this command only. Forbidden keys (API keys, etc.) are silently dropped.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["workspace", "command"],
    },
  },
];

export async function handleShellTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  if (name !== "shell_exec") throw new Error(`unknown shell tool: ${name}`);

  const workspace = String(args.workspace ?? "");
  const command = String(args.command ?? "");
  if (!command) return JSON.stringify({ error: "command required" });

  const sandbox = await ctx.resolveSandbox(workspace);
  const result = await sandbox.exec(command, {
    cwd: args.cwd as string | undefined,
    timeoutMs: args.timeout_ms as number | undefined,
    env: args.env as Record<string, string> | undefined,
  });
  return JSON.stringify(result);
}
