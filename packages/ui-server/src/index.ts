#!/usr/bin/env node
import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { nanoid } from "nanoid";
import {
  listMemory,
  getMemory,
  upsertMemory,
  deleteMemory,
  listProjects,
  listSessions,
  getSession,
  insertSession,
} from "./db.js";
import { AI_MAP, AIMessage, AIName, AIResponse, CHAIN_PRESETS, VALID_AIS } from "@trident/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

dotenv.config({ path: path.join(REPO_ROOT, ".env") });

const PORT = parseInt(process.env.TRIDENT_UI_PORT ?? "4242", 10);
const STATIC_DIR = path.join(__dirname, "..", "static");

function buildProjectContext(project: string | undefined): string | null {
  if (!project) return null;
  const entries = listMemory(project);
  if (entries.length === 0) return null;
  const lines: string[] = [
    `## Project Context: ${project}`,
    "",
    `The following ${entries.length} memory entries are scoped to project "${project}".`,
    "",
  ];
  let total = lines.join("\n").length;
  for (const e of entries) {
    const value = e.value.length > 4000 ? e.value.slice(0, 4000) + "\n…[truncated]" : e.value;
    const block = `### ${e.key}\n${value}\n`;
    if (total + block.length > 24000) {
      lines.push("_…additional entries omitted (context budget)._");
      break;
    }
    lines.push(block);
    total += block.length;
  }
  return lines.join("\n");
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ─── Memory ──────────────────────────────────────────────────────────────────

app.get("/api/memory", (req: Request, res: Response) => {
  const project = typeof req.query.project === "string" ? req.query.project : undefined;
  res.json({ entries: listMemory(project) });
});

app.get("/api/memory/projects", (_req: Request, res: Response) => {
  res.json({ projects: listProjects() });
});

app.get("/api/memory/:project/:key", (req: Request, res: Response) => {
  const entry = getMemory(req.params.project, req.params.key);
  if (!entry) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ entry });
});

app.put("/api/memory/:project/:key", (req: Request, res: Response) => {
  const { project, key } = req.params;
  const value = (req.body?.value ?? "") as string;
  if (typeof value !== "string") {
    res.status(400).json({ error: "value must be a string" });
    return;
  }
  upsertMemory(project, key, value, "ui");
  res.json({ entry: getMemory(project, key) });
});

app.delete("/api/memory/:project/:key", (req: Request, res: Response) => {
  const ok = deleteMemory(req.params.project, req.params.key);
  res.json({ deleted: ok });
});

// ─── Sessions ────────────────────────────────────────────────────────────────

app.get("/api/sessions", (_req: Request, res: Response) => {
  res.json({ sessions: listSessions(200) });
});

app.get("/api/sessions/:id", (req: Request, res: Response) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ session });
});

// ─── Query (SSE) ─────────────────────────────────────────────────────────────

interface QueryBody {
  prompt: string;
  mode: "parallel" | "chain";
  ais?: AIName[];
  preset?: string;
  system?: string;
  project?: string;
}

function parseQuery(body: unknown): QueryBody | { error: string } {
  if (!body || typeof body !== "object") return { error: "body must be JSON" };
  const b = body as Record<string, unknown>;
  if (typeof b.prompt !== "string" || !b.prompt.trim()) return { error: "prompt is required" };
  if (b.mode !== "parallel" && b.mode !== "chain") return { error: "mode must be 'parallel' or 'chain'" };
  let ais: AIName[] | undefined;
  if (Array.isArray(b.ais)) {
    for (const ai of b.ais) {
      if (typeof ai !== "string" || !VALID_AIS.has(ai as AIName)) return { error: `invalid ai: ${String(ai)}` };
    }
    ais = b.ais as AIName[];
  }
  if (b.preset !== undefined && typeof b.preset !== "string") return { error: "preset must be a string" };
  if (b.system !== undefined && typeof b.system !== "string") return { error: "system must be a string" };
  if (b.project !== undefined && typeof b.project !== "string") return { error: "project must be a string" };
  return {
    prompt: b.prompt,
    mode: b.mode,
    ais,
    preset: b.preset as string | undefined,
    system: b.system as string | undefined,
    project: b.project as string | undefined,
  };
}

app.post("/api/query/stream", async (req: Request, res: Response) => {
  const parsed = parseQuery(req.body);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const runId = nanoid(12);
  const startedAt = new Date().toISOString();
  const runStart = Date.now();
  const projectBlock = buildProjectContext(parsed.project);

  let order: AIName[];
  let systemPrompts: Partial<Record<AIName, string>> = {};
  if (parsed.mode === "chain" && parsed.preset && CHAIN_PRESETS[parsed.preset]) {
    const p = CHAIN_PRESETS[parsed.preset];
    order = p.order;
    systemPrompts = p.systemPrompts ?? {};
  } else {
    order = parsed.ais ?? ["claude", "gpt", "perplexity"];
  }

  send("start", { id: runId, mode: parsed.mode, order, project: parsed.project ?? null, started_at: startedAt });

  interface TimedResponse extends AIResponse {
    started_at: string;
    finished_at: string;
  }
  const collected: TimedResponse[] = [];

  const streamAi = async (
    ai: AIName,
    messages: AIMessage[],
    system: string | undefined,
    extra: Record<string, unknown> = {}
  ): Promise<TimedResponse> => {
    const aiStart = new Date().toISOString();
    send("ai_start", { ai, started_at: aiStart, ...extra });
    const result = await AI_MAP[ai](messages, system, {
      tokens: (chunk) => send("ai_token", { ai, delta: chunk }),
    });
    const aiFinish = new Date().toISOString();
    const timed: TimedResponse = { ...result, started_at: aiStart, finished_at: aiFinish };
    collected.push(timed);
    send("ai_done", { ...timed, ...extra });
    return timed;
  };

  if (parsed.mode === "parallel") {
    const baseSystem = projectBlock
      ? (parsed.system ? `${projectBlock}\n\n---\n\n${parsed.system}` : projectBlock)
      : parsed.system;
    await Promise.all(order.map((ai) => streamAi(ai, [{ role: "user", content: parsed.prompt }], baseSystem)));
  } else {
    const conversation: AIMessage[] = [{ role: "user", content: parsed.prompt }];
    for (let i = 0; i < order.length; i++) {
      const ai = order[i];
      const baseSystem =
        systemPrompts[ai] ??
        parsed.system ??
        (i === 0
          ? "You are the first AI in a chain. Provide a thorough initial response."
          : i === order.length - 1
          ? "You are the final AI in a chain. Synthesize all previous responses into a definitive answer."
          : "You are in the middle of a chain. Build on the previous response.");
      const system = projectBlock ? `${projectBlock}\n\n---\n\n${baseSystem}` : baseSystem;

      const ctx = [...conversation];
      if (i > 0) {
        const prev = order[i - 1];
        ctx.push({ role: "user", content: `The above was ${prev}'s response. Now it's your turn in the chain.` });
      }

      const result = await streamAi(ai, ctx, system, { step: i + 1, total: order.length });
      if (!result.error) {
        conversation.push({ role: "assistant", content: result.content });
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - runStart;

  try {
    insertSession({
      id: runId,
      mode: parsed.mode,
      prompt: parsed.prompt,
      project: parsed.project ?? null,
      ais: order,
      responses: collected.map((r) => ({
        ai: r.ai,
        content: r.content,
        error: r.error,
        duration_ms: r.duration_ms,
        started_at: r.started_at,
        finished_at: r.finished_at,
      })),
      duration_ms: durationMs,
      preset: parsed.preset ?? null,
      system_prompt: parsed.system ?? null,
      metadata: { source: "ui" },
      started_at: startedAt,
      finished_at: finishedAt,
    });
  } catch (err) {
    send("warn", { message: `Failed to persist session: ${err instanceof Error ? err.message : String(err)}` });
  }

  send("done", { id: runId, duration_ms: durationMs, finished_at: finishedAt });
  res.end();
});

// ─── Static UI (built React bundle) ──────────────────────────────────────────

if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  app.get("*", (req: Request, res: Response, next) => {
    if (req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(path.join(STATIC_DIR, "index.html"));
  });
}

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Trident UI server listening on http://localhost:${PORT}`);
  if (!fs.existsSync(STATIC_DIR)) {
    console.log(`(static UI bundle not found at ${STATIC_DIR} — run 'npm run build --workspace=packages/ui' to build it)`);
  }
});
