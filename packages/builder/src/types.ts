// Central type vocabulary for the Builder module.

import { z } from "zod";

// ─── Configuration ────────────────────────────────────────────────────────

export type BuilderTier = "premium" | "main" | "utility";

export interface BuilderCeilings {
  cost_usd_max: number;
  cost_usd_warn: number;
  wall_clock_max_min: number;
  cost_per_step_warn: number;
}

export interface BuilderEscalation {
  max_attempts: number;
  auto_escalate_to_premium: boolean;
}

export interface BuilderLoopDetector {
  enabled: boolean;
  similarity_threshold: number;
}

export interface BuilderConfig {
  tier_planner: BuilderTier;
  tier_coder: BuilderTier;
  tier_evaluator: BuilderTier;
  ceilings: BuilderCeilings;
  escalation: BuilderEscalation;
  loop_detector: BuilderLoopDetector;
}

export const DEFAULT_CONFIG: BuilderConfig = {
  tier_planner: "premium",
  tier_coder: "main",
  tier_evaluator: "utility",
  ceilings: {
    cost_usd_max: 5.0,
    cost_usd_warn: 2.0,
    wall_clock_max_min: 60,
    cost_per_step_warn: 0.5,
  },
  escalation: {
    max_attempts: 3,
    auto_escalate_to_premium: true,
  },
  loop_detector: {
    enabled: true,
    similarity_threshold: 0.7,
  },
};

// ─── Build state ──────────────────────────────────────────────────────────

export type BuildStatus =
  | "pending"
  | "planning"
  | "running"
  | "paused"
  | "escalated"
  | "done"
  | "failed"
  | "aborted";

export interface BuildRow {
  id: string;
  spec_path: string;
  spec_digest: SpecDigest | null;
  source_repo: string;
  base_branch: string;
  builder_branch: string;
  workspace_path: string;
  status: BuildStatus;
  current_step_id: string | null;
  plan_tree: PlanTree | null;
  cost_usd: number;
  config: BuilderConfig;
  metadata: Record<string, unknown> | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
}

// ─── Spec ingestion ────────────────────────────────────────────────────────

export const SpecDigestSchema = z.object({
  goal: z.string(),
  constraints: z.array(z.string()).default([]),
  success_criteria: z.array(z.string()).default([]),
  inferred_target_files: z.array(z.string()).default([]),
  notes: z.string().default(""),
});
export type SpecDigest = z.infer<typeof SpecDigestSchema>;

// ─── Plan tree ────────────────────────────────────────────────────────────

export const VerificationSchema = z.union([
  z.object({ kind: z.literal("cmd"), command: z.string() }),
  z.object({ kind: z.literal("test"), framework: z.string().optional(), pattern: z.string().optional() }),
  z.object({ kind: z.literal("typecheck") }),
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("assert"), description: z.string() }),
]);
export type Verification = z.infer<typeof VerificationSchema>;

export interface PlanNode {
  id: string;
  kind: "milestone" | "task" | "step";
  ordinal: number;
  parent_id: string | null;
  intent: string;
  expected_files: string[];
  verification: Verification | null;
  children: PlanNode[];
}

export interface PlanTree {
  root: PlanNode[];
}

// LLM produces a simpler shape — we attach IDs/ordinals ourselves.
export const PlannerOutputNodeSchema: z.ZodType<PlannerOutputNode> = z.lazy(() =>
  z.object({
    kind: z.enum(["milestone", "task", "step"]),
    intent: z.string(),
    expected_files: z.array(z.string()).default([]),
    verification: VerificationSchema.nullable().default(null),
    children: z.array(PlannerOutputNodeSchema).default([]),
  })
);
export interface PlannerOutputNode {
  kind: "milestone" | "task" | "step";
  intent: string;
  expected_files: string[];
  verification: Verification | null;
  children: PlannerOutputNode[];
}

export const PlannerOutputSchema = z.object({
  root: z.array(PlannerOutputNodeSchema),
});
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

// ─── Task state ───────────────────────────────────────────────────────────

export type TaskStatus = "pending" | "ready" | "running" | "done" | "failed" | "skipped";

export interface TaskRow {
  id: string;
  build_id: string;
  parent_id: string | null;
  kind: "milestone" | "task" | "step";
  ordinal: number;
  intent: string;
  expected_files: string[];
  verification: Verification | null;
  status: TaskStatus;
  attempts: number;
  max_attempts: number;
  last_evaluation: StepEvaluation | null;
  snapshot_before: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

// ─── Evaluation ───────────────────────────────────────────────────────────

export const StepEvaluationSchema = z.object({
  verdict: z.enum(["pass", "fail", "partial"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  signals: z
    .object({
      verification_exit_code: z.number().optional(),
      verification_stdout: z.string().optional(),
      typecheck_ok: z.boolean().optional(),
      tests_passed: z.number().nullable().optional(),
      tests_failed: z.number().nullable().optional(),
    })
    .default({}),
});
export type StepEvaluation = z.infer<typeof StepEvaluationSchema>;

// ─── Public API request shapes ────────────────────────────────────────────

export interface CreateBuildOptions {
  specPath: string;
  sourceRepo: string;
  baseBranch?: string;
  config?: Partial<BuilderConfig>;
  metadata?: Record<string, unknown>;
}

export interface BuildSummary {
  id: string;
  spec_path: string;
  source_repo: string;
  status: BuildStatus;
  cost_usd: number;
  tasks_total: number;
  tasks_done: number;
  started_at: string;
  finished_at: string | null;
}
