import fs from "fs";
import path from "path";
import { SessionRunResponse } from "./db.js";

const AI_HEADERS: Record<string, string> = {
  claude: "Claude",
  gpt: "ChatGPT",
  perplexity: "Perplexity",
};

function aiHeader(ai: string): string {
  return AI_HEADERS[ai] ?? ai.toUpperCase();
}

interface BaseRunMeta {
  id: string;
  prompt: string;
  responses: SessionRunResponse[];
  started_at: string;
  finished_at: string;
  duration_ms: number;
  project?: string;
  system_prompt?: string;
}

export interface ParallelRunMeta extends BaseRunMeta {
  mode: "parallel";
  ais: string[];
}

export interface ChainRunMeta extends BaseRunMeta {
  mode: "chain";
  order: string[];
  preset?: string;
}

export type RunMeta = ParallelRunMeta | ChainRunMeta;

export function formatRunMarkdown(run: RunMeta, extraSections: { title: string; body: string }[] = []): string {
  const lines: string[] = [];

  lines.push(`# Trident — ${run.mode === "parallel" ? "Parallel" : "Chain"} Run`);
  lines.push("");
  lines.push(`> **Session:** \`${run.id}\``);
  lines.push(`> **Started:** ${run.started_at}`);
  lines.push(`> **Finished:** ${run.finished_at}`);
  lines.push(`> **Duration:** ${run.duration_ms}ms`);

  if (run.mode === "parallel") {
    lines.push(`> **AIs:** ${run.ais.map(aiHeader).join(", ")}`);
  } else {
    lines.push(`> **Order:** ${run.order.map(aiHeader).join(" → ")}`);
    if (run.preset) lines.push(`> **Preset:** \`${run.preset}\``);
  }
  if (run.project) lines.push(`> **Project:** \`${run.project}\``);

  lines.push("");
  lines.push("## Prompt");
  lines.push("");
  lines.push("```");
  lines.push(run.prompt);
  lines.push("```");
  lines.push("");

  if (run.system_prompt) {
    lines.push("## System Prompt");
    lines.push("");
    lines.push("```");
    lines.push(run.system_prompt);
    lines.push("```");
    lines.push("");
  }

  for (let i = 0; i < run.responses.length; i++) {
    const r = run.responses[i];
    const stepLabel = run.mode === "chain" ? ` — Step ${i + 1}/${run.responses.length}` : "";
    lines.push(`## ${aiHeader(r.ai)}${stepLabel}`);
    lines.push("");
    lines.push(`*Started: ${r.started_at} • Finished: ${r.finished_at} • ${r.duration_ms}ms*`);
    lines.push("");
    if (r.error) {
      lines.push(`> **Error:** ${r.error}`);
    } else {
      lines.push(r.content);
    }
    lines.push("");
  }

  for (const section of extraSections) {
    lines.push(`## ${section.title}`);
    lines.push("");
    lines.push(section.body);
    lines.push("");
  }

  return lines.join("\n");
}

export function writeRunOutput(filepath: string, markdown: string): string {
  const resolved = path.resolve(filepath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(resolved, markdown, "utf-8");
  return resolved;
}
