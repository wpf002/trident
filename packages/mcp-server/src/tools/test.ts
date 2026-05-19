// Verification tools — test_run, typecheck, lint. Each detects the relevant
// runner from the workspace and runs it via sandbox.exec(). Output is parsed
// best-effort into structured pass/fail counts where the runner format is
// recognizable; raw stdout/stderr is always included so the evaluator can
// still read the full output on a refine retry.

import type { ToolContext } from "../lib/builder-ctx.js";
import type { Sandbox } from "@trident/builder-runtime";

export const testTools = [
  {
    name: "test_run",
    description:
      "Run the project's test suite inside the active workspace. The framework is auto-detected (vitest, jest, pytest, cargo test) unless overridden. Returns structured pass/fail counts when parseable, plus raw stdout/stderr.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Build workspace token" },
        framework: {
          type: "string",
          enum: ["auto", "vitest", "jest", "pytest", "cargo", "mocha"],
          description: "Override detection (default: auto)",
        },
        pattern: {
          type: "string",
          description: "Optional file/test pattern (framework-specific)",
        },
        timeout_ms: { type: "number", description: "Override timeout (default 300000)" },
      },
      required: ["workspace"],
    },
  },
  {
    name: "typecheck",
    description:
      "Run the project's type-checker (tsc --noEmit for Node, mypy for Python, cargo check for Rust). Returns exit code plus parsed error count when recognizable.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Build workspace token" },
        project: { type: "string", description: "Optional tsconfig path" },
        timeout_ms: { type: "number", description: "Override timeout (default 300000)" },
      },
      required: ["workspace"],
    },
  },
  {
    name: "lint",
    description:
      "Run the project's linter (eslint for Node, ruff/flake8 for Python, cargo clippy for Rust). With fix:true applies auto-fixes where supported.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Build workspace token" },
        fix: { type: "boolean", description: "Apply auto-fixes (default false)" },
        path: { type: "string", description: "Optional path to lint" },
        timeout_ms: { type: "number", description: "Override timeout (default 180000)" },
      },
      required: ["workspace"],
    },
  },
];

type TestFramework = "vitest" | "jest" | "pytest" | "cargo" | "mocha" | "unknown";

async function detectTestFramework(sandbox: Sandbox): Promise<TestFramework> {
  if (await sandbox.fileExists("Cargo.toml")) return "cargo";
  if (
    await sandbox.fileExists("pytest.ini") ||
    await sandbox.fileExists("pyproject.toml")
  ) {
    return "pytest";
  }
  if (await sandbox.fileExists("package.json")) {
    try {
      const pkg = JSON.parse(await sandbox.readFile("package.json")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const all = { ...pkg.dependencies, ...pkg.devDependencies };
      if (all.vitest) return "vitest";
      if (all.jest) return "jest";
      if (all.mocha) return "mocha";
    } catch {
      // unparseable — fall through
    }
  }
  return "unknown";
}

export async function handleTestTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const workspace = String(args.workspace ?? "");
  const sandbox = await ctx.resolveSandbox(workspace);

  switch (name) {
    case "test_run":
      return runTests(sandbox, args);
    case "typecheck":
      return runTypecheck(sandbox, args);
    case "lint":
      return runLint(sandbox, args);
    default:
      throw new Error(`unknown test tool: ${name}`);
  }
}

async function runTests(
  sandbox: Sandbox,
  args: Record<string, unknown>
): Promise<string> {
  let framework = (args.framework as TestFramework | "auto" | undefined) ?? "auto";
  if (framework === "auto") framework = await detectTestFramework(sandbox);
  const pattern = args.pattern as string | undefined;
  const timeoutMs = (args.timeout_ms as number | undefined) ?? 300_000;

  const cmd = testCommand(framework, pattern);
  if (!cmd) {
    return JSON.stringify({
      error: "could not detect test framework",
      framework,
    });
  }
  const r = await sandbox.exec(cmd, { timeoutMs });
  const summary = parseTestSummary(framework, r.stdout, r.stderr);
  return JSON.stringify({
    framework,
    command: cmd,
    exit_code: r.exitCode,
    timed_out: r.timedOut,
    duration_ms: r.durationMs,
    passed: summary.passed,
    failed: summary.failed,
    stdout: r.stdout,
    stderr: r.stderr,
  });
}

function testCommand(framework: TestFramework, pattern: string | undefined): string | null {
  const pat = pattern ? ` ${quoteShell(pattern)}` : "";
  switch (framework) {
    case "vitest":
      return `npx vitest run${pat}`;
    case "jest":
      return `npx jest${pat}`;
    case "mocha":
      return `npx mocha${pat}`;
    case "pytest":
      return `pytest${pat}`;
    case "cargo":
      return pattern ? `cargo test ${quoteShell(pattern)}` : "cargo test";
    default:
      return null;
  }
}

interface TestSummary {
  passed: number | null;
  failed: number | null;
}

function parseTestSummary(
  framework: TestFramework,
  stdout: string,
  stderr: string
): TestSummary {
  const blob = stdout + "\n" + stderr;
  switch (framework) {
    case "vitest": {
      // Tests  3 passed (3)   or   Tests  1 failed | 2 passed (3)
      const passed = matchNum(blob, /(\d+)\s+passed/i);
      const failed = matchNum(blob, /(\d+)\s+failed/i);
      return { passed, failed };
    }
    case "jest": {
      const passed = matchNum(blob, /Tests:.*?(\d+)\s+passed/i);
      const failed = matchNum(blob, /Tests:.*?(\d+)\s+failed/i);
      return { passed, failed };
    }
    case "mocha": {
      const passed = matchNum(blob, /(\d+)\s+passing/i);
      const failed = matchNum(blob, /(\d+)\s+failing/i);
      return { passed, failed };
    }
    case "pytest": {
      const passed = matchNum(blob, /(\d+)\s+passed/i);
      const failed = matchNum(blob, /(\d+)\s+failed/i);
      return { passed, failed };
    }
    case "cargo": {
      const passed = matchNum(blob, /(\d+)\s+passed/i);
      const failed = matchNum(blob, /(\d+)\s+failed/i);
      return { passed, failed };
    }
    default:
      return { passed: null, failed: null };
  }
}

function matchNum(s: string, re: RegExp): number | null {
  const m = s.match(re);
  return m ? parseInt(m[1], 10) : null;
}

async function runTypecheck(
  sandbox: Sandbox,
  args: Record<string, unknown>
): Promise<string> {
  const timeoutMs = (args.timeout_ms as number | undefined) ?? 300_000;
  let cmd = "";
  let kind: "tsc" | "mypy" | "cargo" | "unknown" = "unknown";
  if (await sandbox.fileExists("tsconfig.json")) {
    const project = args.project as string | undefined;
    cmd = project ? `npx tsc --noEmit -p ${quoteShell(project)}` : "npx tsc --noEmit";
    kind = "tsc";
  } else if (await sandbox.fileExists("Cargo.toml")) {
    cmd = "cargo check";
    kind = "cargo";
  } else if (await sandbox.fileExists("pyproject.toml")) {
    cmd = "python -m mypy .";
    kind = "mypy";
  } else {
    return JSON.stringify({ error: "no type-checker detected" });
  }
  const r = await sandbox.exec(cmd, { timeoutMs });
  const blob = r.stdout + "\n" + r.stderr;
  let errors: number | null = null;
  if (kind === "tsc") {
    const m = blob.match(/Found\s+(\d+)\s+error/i);
    errors = m ? parseInt(m[1], 10) : r.exitCode === 0 ? 0 : null;
  } else if (kind === "mypy") {
    const m = blob.match(/(\d+)\s+error/i);
    errors = m ? parseInt(m[1], 10) : r.exitCode === 0 ? 0 : null;
  }
  return JSON.stringify({
    kind,
    command: cmd,
    exit_code: r.exitCode,
    timed_out: r.timedOut,
    duration_ms: r.durationMs,
    errors,
    stdout: r.stdout,
    stderr: r.stderr,
  });
}

async function runLint(
  sandbox: Sandbox,
  args: Record<string, unknown>
): Promise<string> {
  const fix = Boolean(args.fix ?? false);
  const filePath = args.path as string | undefined;
  const timeoutMs = (args.timeout_ms as number | undefined) ?? 180_000;

  let cmd = "";
  let kind: "eslint" | "ruff" | "clippy" | "unknown" = "unknown";
  if (
    (await sandbox.fileExists(".eslintrc.js")) ||
    (await sandbox.fileExists(".eslintrc.json")) ||
    (await sandbox.fileExists("eslint.config.js")) ||
    (await sandbox.fileExists("eslint.config.mjs"))
  ) {
    cmd = `npx eslint${fix ? " --fix" : ""} ${filePath ? quoteShell(filePath) : "."}`;
    kind = "eslint";
  } else if (await sandbox.fileExists("Cargo.toml")) {
    cmd = `cargo clippy${fix ? " --fix --allow-dirty --allow-staged" : ""}`;
    kind = "clippy";
  } else if (await sandbox.fileExists("pyproject.toml")) {
    cmd = `ruff check${fix ? " --fix" : ""} ${filePath ? quoteShell(filePath) : "."}`;
    kind = "ruff";
  } else {
    return JSON.stringify({ error: "no linter detected" });
  }
  const r = await sandbox.exec(cmd, { timeoutMs });
  return JSON.stringify({
    kind,
    command: cmd,
    exit_code: r.exitCode,
    timed_out: r.timedOut,
    duration_ms: r.durationMs,
    stdout: r.stdout,
    stderr: r.stderr,
  });
}

function quoteShell(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
