// Default policy for sandboxed process execution.
// All values overridable per-call via ExecOptions, but the runtime clamps to
// the ceilings below — the agent can't ask for an unbounded process.

export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
export const MAX_EXEC_TIMEOUT_MS = 300_000;
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

// Env vars that must NEVER reach a sandboxed child process. The agent has no
// reason to see host secrets or API keys; if it ever exfiltrates anything, it
// shouldn't be ours to lose.
export const FORBIDDEN_ENV_KEYS: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "PERPLEXITY_API_KEY",
  "TAVILY_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
]);

// Env vars allowed through unconditionally — basic shell hygiene.
export const PASSTHROUGH_ENV_KEYS: ReadonlySet<string> = new Set([
  "PATH",
  "LANG",
  "LC_ALL",
  "TERM",
  "TZ",
]);

// Hard-coded refusal patterns. Matched against the raw command string before
// spawn. Intentionally a small, high-confidence list — false positives here
// stop the agent dead. Broader policy (deny lists, sudo, etc.) lives at the
// builder/guardrails layer, not in the runtime.
export const DESTRUCTIVE_COMMAND_PATTERNS: ReadonlyArray<RegExp> = [
  /\brm\s+-rf?\s+\/(?!\S)/,           // rm -rf / (root)
  /\brm\s+-rf?\s+~(?:\/|\s|$)/,       // rm -rf ~
  /\bgit\s+push\s+(?:-f\b|--force\b)/,
  /\bgit\s+push\b.*--force-with-lease/,
  /\bdd\s+if=.*\s+of=\/dev\/[sh]d/,
  /\bmkfs\b/,
  /:\(\)\s*\{\s*:\|:&\s*\}/,          // fork bomb
  /\bsudo\b/,
  /\bshutdown\b/,
  /\breboot\b/,
];

export function buildChildEnv(
  workspacePath: string,
  overrides?: Record<string, string>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV_KEYS) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  env.HOME = workspacePath;
  env.PWD = workspacePath;
  // Mark the env so a hooked process knows it's inside a Trident sandbox.
  env.TRIDENT_SANDBOX = "1";

  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (FORBIDDEN_ENV_KEYS.has(k)) continue;
      env[k] = v;
    }
  }
  return env;
}

export function isDestructiveCommand(command: string): RegExp | null {
  for (const pattern of DESTRUCTIVE_COMMAND_PATTERNS) {
    if (pattern.test(command)) return pattern;
  }
  return null;
}
