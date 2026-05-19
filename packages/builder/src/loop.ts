// The agent control loop. Orchestrates ingest → plan → execute → evaluate →
// commit, with retries, escalation, ceilings, and event emission.

import fsp from "fs/promises";
import path from "path";
import { nanoid } from "nanoid";
import type { Sandbox } from "@trident/builder-runtime";

import {
  type BuilderConfig,
  type PlanNode,
  type PlanTree,
  type StepEvaluation,
  type CreateBuildOptions,
  DEFAULT_CONFIG,
} from "./types.js";
import {
  bumpBuildCost,
  bumpTaskAttempts,
  getBuild,
  insertBuild,
  insertEvent,
  insertTask,
  listTasksForBuild,
  setBuildCurrentStep,
  setBuildPlanTree,
  setBuildSpecDigest,
  setTaskEvaluation,
  setTaskSnapshot,
  updateBuildStatus,
  updateTaskStatus,
} from "./db.js";
import { globalBus, makeEvent } from "./events.js";
import { generatePlan, ingestSpec, reviseSubPlan } from "./planner.js";
import { evaluateStep, type EvaluatorSignals } from "./evaluator.js";
import { runCoder } from "./coder.js";
import { checkCeilings, detectLoop } from "./guardrails.js";
import {
  buildsRoot,
  createWorkspace,
  dataDir,
  defaultBaseBranch,
  defaultSourceRepo,
  destroyWorkspace,
  prepareSourceRepo,
} from "./state.js";
import fs from "fs";
import fsp from "fs/promises";

export async function runBuildLoop(opts: {
  buildId: string;
  sandbox: Sandbox;
  config: BuilderConfig;
  specPath: string;
}): Promise<void> {
  const { buildId, sandbox, config, specPath } = opts;
  const recentEvaluations: StepEvaluation[] = [];

  // ── Ingest ────────────────────────────────────────────────────────────
  updateBuildStatus(buildId, "planning");
  emit(buildId, "build_started", { spec_path: specPath });

  const specText = await fsp.readFile(specPath, "utf8").catch(() => {
    throw new Error(`spec not readable: ${specPath}`);
  });
  const ingest = await ingestSpec(specText, config, { buildId, phase: "ingest" });
  bumpBuildCost(buildId, ingest.cost);
  setBuildSpecDigest(buildId, ingest.data);

  // ── Plan ──────────────────────────────────────────────────────────────
  const workspaceMap = await snapshotWorkspaceMap(sandbox);
  const plan = await generatePlan(ingest.data, workspaceMap, config, {
    buildId,
    phase: "plan",
  });
  bumpBuildCost(buildId, plan.cost);
  setBuildPlanTree(buildId, plan.data);
  insertPlanTree(buildId, plan.data);
  emit(buildId, "plan_generated", {
    steps: countLeaves(plan.data),
    session_id: plan.session_id,
  });

  updateBuildStatus(buildId, "running");

  // ── Execute leaves in order ───────────────────────────────────────────
  const leaves = leavesOf(plan.data);
  for (const step of leaves) {
    const fresh = getBuild(buildId);
    if (!fresh) throw new Error(`build ${buildId} disappeared`);
    if (
      fresh.status === "paused" ||
      fresh.status === "aborted" ||
      fresh.status === "failed"
    ) {
      emit(buildId, "build_terminated", { reason: `status=${fresh.status}` });
      return;
    }

    setBuildCurrentStep(buildId, step.id);
    updateTaskStatus(step.id, "running", { startedAt: new Date().toISOString() });
    emit(buildId, "task_started", { task_id: step.id, intent: step.intent });

    const snapshotId = await sandbox.snapshot(`pre:${step.id}`).catch(() => null);
    if (snapshotId) setTaskSnapshot(step.id, snapshotId);

    let stepCost = 0;
    let attemptIdx = 0;
    let succeeded = false;
    let refineContext: string | undefined;

    while (attemptIdx < config.escalation.max_attempts) {
      attemptIdx = bumpTaskAttempts(step.id);

      // Cost/wall-clock check before each attempt.
      const ceiling = checkCeilings(getBuild(buildId)!, stepCost, config);
      if (ceiling.action === "pause") {
        updateBuildStatus(buildId, "paused");
        emit(buildId, "build_terminated", {
          reason: `ceiling:${ceiling.reason}`,
          current: ceiling.current,
          limit: ceiling.limit,
        });
        return;
      }
      if (ceiling.action === "warn") {
        emit(buildId, "intervention_requested", {
          kind: "ceiling_warn",
          level: ceiling.level,
          current: ceiling.current,
          limit: ceiling.limit,
        });
      }

      // CODE
      const coder = await runCoder({
        buildId,
        step,
        attempt: attemptIdx,
        config,
        sandbox,
        refineContext,
      }).catch((err) => {
        return {
          iterations: 0,
          stop_reason: "error",
          cost: 0,
          model: "unknown",
          session_id: nanoid(),
          tool_trace: [],
          final_text: `coder error: ${(err as Error).message}`,
        };
      });
      bumpBuildCost(buildId, coder.cost);
      stepCost += coder.cost;
      for (const t of coder.tool_trace) {
        emit(buildId, "tool_called", { task_id: step.id, name: t.name, input: t.input });
        emit(buildId, "tool_result", {
          task_id: step.id,
          name: t.name,
          output: t.output.slice(0, 1000),
        });
      }

      // VERIFY (run verification command if specified)
      const signals = await runVerification(sandbox, step.verification);

      // EVALUATE
      const diff = (await sandbox.exec("git diff").catch(() => null))?.stdout ?? "";
      const evalResult = await evaluateStep({
        buildId,
        step,
        config,
        diff,
        toolTrace: coder.tool_trace,
        verification: step.verification,
        signals,
      });
      bumpBuildCost(buildId, evalResult.cost);
      stepCost += evalResult.cost;
      setTaskEvaluation(step.id, evalResult.evaluation);
      recentEvaluations.push(evalResult.evaluation);
      if (recentEvaluations.length > 5) recentEvaluations.shift();
      emit(buildId, "step_evaluated", {
        task_id: step.id,
        attempt: attemptIdx,
        verdict: evalResult.evaluation.verdict,
        confidence: evalResult.evaluation.confidence,
        reason: evalResult.evaluation.reason,
      });

      if (evalResult.evaluation.verdict === "pass") {
        succeeded = true;
        break;
      }

      // Loop detector — short-circuit to escalation if we're spinning.
      if (config.loop_detector.enabled) {
        const loop = detectLoop(recentEvaluations, config.loop_detector.similarity_threshold);
        if (loop.looping) {
          emit(buildId, "escalation_triggered", {
            task_id: step.id,
            reason: "loop_detected",
            similarity: loop.similarity,
          });
          break;
        }
      }

      // REFINE — prepare context for the next attempt
      refineContext = `Previous attempt verdict: ${evalResult.evaluation.verdict}\nReason: ${evalResult.evaluation.reason}\nSignals: ${JSON.stringify(signals)}`;
    }

    if (succeeded) {
      updateTaskStatus(step.id, "done", { finishedAt: new Date().toISOString() });
      emit(buildId, "task_done", { task_id: step.id, step_cost_usd: stepCost });
      continue;
    }

    // Escalate: ask Opus to re-plan this step's subtree.
    emit(buildId, "escalation_triggered", { task_id: step.id, reason: "max_attempts" });
    const failureCtx =
      `Step intent: ${step.intent}\n` +
      `Final evaluation: ${JSON.stringify(recentEvaluations[recentEvaluations.length - 1])}`;
    try {
      const digest = (await getBuildSpecDigest(buildId))!;
      const revised = await reviseSubPlan(digest, step, failureCtx, config, {
        buildId,
        phase: "replan",
        stepId: step.id,
      });
      bumpBuildCost(buildId, revised.cost);
      emit(buildId, "plan_revised", { task_id: step.id, session_id: revised.session_id });
      // For v1, after re-plan, mark this step failed and surface a human
      // intervention. We don't auto-execute the revised subtree yet —
      // human decides whether to merge it into the plan.
    } catch (err) {
      emit(buildId, "intervention_requested", {
        task_id: step.id,
        kind: "replan_failed",
        error: (err as Error).message,
      });
    }

    updateTaskStatus(step.id, "failed", { finishedAt: new Date().toISOString() });
    emit(buildId, "task_failed", { task_id: step.id });
    updateBuildStatus(buildId, "escalated");
    return;
  }

  // ── All leaves passed ─────────────────────────────────────────────────
  updateBuildStatus(buildId, "done", new Date().toISOString());
  emit(buildId, "build_terminated", { reason: "success" });
}

// ─── Public entrypoints ──────────────────────────────────────────────────

export async function createAndRunBuild(opts: CreateBuildOptions): Promise<string> {
  const buildId = nanoid(12);
  const config: BuilderConfig = { ...DEFAULT_CONFIG, ...(opts.config ?? {}) };
  const baseBranch = opts.baseBranch ?? defaultBaseBranch();

  // Resolve source repo: explicit arg → env default → error.
  const repoSpec = opts.sourceRepo ?? defaultSourceRepo();
  if (!repoSpec) {
    throw new Error(
      "no source repo: pass sourceRepo or set TRIDENT_BUILDER_DEFAULT_REPO"
    );
  }
  // Clones if it's a URL; resolves locally otherwise. Idempotent across calls.
  const sourceRepo = await prepareSourceRepo(repoSpec);

  // Resolve spec: explicit path, OR write inline text to a per-build spec file
  // under data/builds/<id>/spec.md so it survives resume/replay.
  let specPath: string;
  if (opts.specPath) {
    specPath = path.resolve(opts.specPath);
  } else if (opts.specText) {
    const buildDir = path.join(buildsRoot(), buildId);
    if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });
    specPath = path.join(buildDir, "spec.md");
    await fsp.writeFile(specPath, opts.specText, "utf8");
  } else {
    throw new Error("no spec: pass specPath or specText");
  }

  const sandbox = await createWorkspace({
    buildId,
    sourceRepo,
    baseBranch,
  });

  insertBuild({
    id: buildId,
    spec_path: specPath,
    source_repo: sourceRepo,
    base_branch: baseBranch,
    builder_branch: sandbox.branch,
    workspace_path: sandbox.workspacePath,
    status: "pending",
    config,
    metadata: opts.metadata,
    started_at: new Date().toISOString(),
  });

  // Fire-and-forget the loop — caller polls via getBuild / events.
  runBuildLoop({
    buildId,
    sandbox,
    config,
    specPath,
  })
    .catch((err) => {
      emit(buildId, "build_terminated", { reason: "error", error: (err as Error).message });
      updateBuildStatus(buildId, "failed", new Date().toISOString());
    })
    .finally(async () => {
      await destroyWorkspace(buildId, sandbox).catch(() => undefined);
    });

  return buildId;
}

// Expose data dir for callers (ui-server, cli) that need to know where things live.
export { dataDir };

// ─── helpers ──────────────────────────────────────────────────────────────

function emit(buildId: string, kind: Parameters<typeof makeEvent>[1], payload: Record<string, unknown>) {
  const ev = makeEvent(buildId, kind, payload, {
    taskId: typeof payload.task_id === "string" ? payload.task_id : null,
    sessionId: typeof payload.session_id === "string" ? payload.session_id : null,
  });
  insertEvent(ev);
  globalBus.emit(ev);
}

function leavesOf(tree: PlanTree): PlanNode[] {
  const out: PlanNode[] = [];
  function walk(n: PlanNode) {
    if (n.children.length === 0) out.push(n);
    else n.children.forEach(walk);
  }
  tree.root.forEach(walk);
  return out;
}

function countLeaves(tree: PlanTree): number {
  return leavesOf(tree).length;
}

function insertPlanTree(buildId: string, tree: PlanTree): void {
  function walk(n: PlanNode, parentId: string | null) {
    const isLeaf = n.children.length === 0;
    insertTask({
      id: n.id,
      build_id: buildId,
      parent_id: parentId,
      kind: n.kind,
      ordinal: n.ordinal,
      intent: n.intent,
      expected_files: n.expected_files,
      verification: n.verification,
      status: isLeaf ? "ready" : "pending",
      max_attempts: 3,
    });
    n.children.forEach((c) => walk(c, n.id));
  }
  tree.root.forEach((n) => walk(n, null));
}

async function snapshotWorkspaceMap(sandbox: Sandbox): Promise<string> {
  // Get a depth-2 listing of the workspace for the planner's context.
  const r = await sandbox.exec(
    "find . -maxdepth 2 -not -path './node_modules*' -not -path './.git*' -not -path './dist*' | head -200"
  );
  return r.stdout;
}

async function runVerification(
  sandbox: Sandbox,
  verification: PlanNode["verification"]
): Promise<EvaluatorSignals> {
  if (!verification) return {};
  if (verification.kind === "cmd") {
    const r = await sandbox.exec(verification.command, { timeoutMs: 300_000 });
    return { exit_code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  }
  if (verification.kind === "typecheck") {
    let cmd = "";
    if (await sandbox.fileExists("tsconfig.json")) cmd = "npx tsc --noEmit";
    else if (await sandbox.fileExists("Cargo.toml")) cmd = "cargo check";
    if (!cmd) return {};
    const r = await sandbox.exec(cmd, { timeoutMs: 300_000 });
    return { exit_code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  }
  if (verification.kind === "test") {
    let cmd = "";
    if (await sandbox.fileExists("package.json")) cmd = "npm test --silent";
    else if (await sandbox.fileExists("Cargo.toml")) cmd = "cargo test";
    else if (await sandbox.fileExists("pyproject.toml")) cmd = "pytest";
    if (!cmd) return {};
    const r = await sandbox.exec(cmd, { timeoutMs: 300_000 });
    return { exit_code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  }
  return {};
}

async function getBuildSpecDigest(buildId: string) {
  const b = getBuild(buildId);
  return b?.spec_digest ?? null;
}

// Re-export for index.ts
export { listTasksForBuild };
