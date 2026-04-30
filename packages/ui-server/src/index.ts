#!/usr/bin/env node
import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { nanoid } from "nanoid";
import { listSessions, getSession, insertSession } from "./db.js";
import {
  AI_MAP,
  AIMessage,
  AIName,
  AIResponse,
  CHAIN_PRESETS,
  VALID_AIS,
  ModelTier,
  callClaude,
  generateImage,
  ImageQuality,
  ImageSize,
} from "@trident/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

dotenv.config({ path: path.join(REPO_ROOT, ".env") });

const PORT = parseInt(process.env.TRIDENT_UI_PORT ?? "4242", 10);
const STATIC_DIR = path.join(__dirname, "..", "static");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ─── Image generation ────────────────────────────────────────────────────────

const VALID_IMAGE_SIZES: ReadonlySet<string> = new Set(["1024x1024", "1024x1792", "1792x1024"]);
const VALID_IMAGE_QUALITIES: ReadonlySet<string> = new Set(["standard", "hd"]);

app.post("/api/image/generate", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const prompt = body.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }
  if (body.size !== undefined && (typeof body.size !== "string" || !VALID_IMAGE_SIZES.has(body.size))) {
    res.status(400).json({ error: "size must be 1024x1024, 1024x1792, or 1792x1024" });
    return;
  }
  if (body.quality !== undefined && (typeof body.quality !== "string" || !VALID_IMAGE_QUALITIES.has(body.quality))) {
    res.status(400).json({ error: "quality must be 'standard' or 'hd'" });
    return;
  }
  const result = await generateImage(prompt, {
    size: body.size as ImageSize | undefined,
    quality: body.quality as ImageQuality | undefined,
  });
  res.json(result);
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
  tier?: ModelTier;
  diff?: boolean;
  score?: boolean;
}

const VALID_TIERS: ReadonlySet<string> = new Set(["premium", "main", "utility"]);

const DIFF_SYSTEM_PROMPT = `You are an analyst comparing multiple AI responses to the same prompt. Produce a structured comparison with three sections, in this order, using these exact markdown headings:

## Agreement
Bullet points covering substantive claims, facts, or recommendations all responses share.

## Disagreement
Bullet points covering points where the responses differ. Identify which AI says what.

## Conflicts
Bullet points flagging any claims that directly contradict each other or look factually incorrect. If you cannot verify a claim, mark it as "unverifiable". If there are no conflicts, write "None identified."

Be concise and concrete.`;

const CONFIDENCE_SYSTEM_PROMPT = `You are evaluating multiple AI responses to a single prompt. Return ONLY a JSON object — no markdown fences, no preamble — with exactly this shape:

{
  "scores": [{ "ai": "<ai name>", "confidence": <0-100>, "rationale": "<one sentence>" }],
  "agreement": "low" | "medium" | "high",
  "consensus": ["<short bullet>", "..."],
  "disagreement": ["<short bullet>", "..."]
}

One scores entry per response, in the same order given. Do not invent AI names — use the names exactly as given.`;

function formatResponsesForSynthesis(
  prompt: string,
  responses: Array<{ ai: string; content: string; error?: string }>
): string {
  const sections = responses.map((r, i) => {
    if (r.error) return `### Response ${i + 1} — ${r.ai} (errored)\n\n[Error: ${r.error}]`;
    return `### Response ${i + 1} — ${r.ai}\n\n${r.content}`;
  });
  return [
    "The user asked the following prompt to multiple AIs in parallel:",
    "",
    `> ${prompt.replace(/\n/g, "\n> ")}`,
    "",
    "Here are their responses:",
    "",
    ...sections,
  ].join("\n");
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
  if (b.tier !== undefined && (typeof b.tier !== "string" || !VALID_TIERS.has(b.tier))) {
    return { error: "tier must be one of: premium, main, utility" };
  }
  if (b.diff !== undefined && typeof b.diff !== "boolean") return { error: "diff must be boolean" };
  if (b.score !== undefined && typeof b.score !== "boolean") return { error: "score must be boolean" };
  return {
    prompt: b.prompt,
    mode: b.mode,
    ais,
    preset: b.preset as string | undefined,
    system: b.system as string | undefined,
    tier: b.tier as ModelTier | undefined,
    diff: b.diff as boolean | undefined,
    score: b.score as boolean | undefined,
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

  let order: AIName[];
  let systemPrompts: Partial<Record<AIName, string>> = {};
  if (parsed.mode === "chain" && parsed.preset && CHAIN_PRESETS[parsed.preset]) {
    const p = CHAIN_PRESETS[parsed.preset];
    order = p.order;
    systemPrompts = p.systemPrompts ?? {};
  } else {
    order = parsed.ais ?? ["claude", "gpt", "perplexity"];
  }

  send("start", { id: runId, mode: parsed.mode, order, started_at: startedAt });

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
      tier: parsed.tier ?? "main",
      tokens: (chunk) => send("ai_token", { ai, delta: chunk }),
    });
    const aiFinish = new Date().toISOString();
    const timed: TimedResponse = { ...result, started_at: aiStart, finished_at: aiFinish };
    collected.push(timed);
    send("ai_done", { ...timed, ...extra });
    return timed;
  };

  if (parsed.mode === "parallel") {
    await Promise.all(
      order.map((ai) => streamAi(ai, [{ role: "user", content: parsed.prompt }], parsed.system))
    );
  } else {
    const conversation: AIMessage[] = [{ role: "user", content: parsed.prompt }];
    for (let i = 0; i < order.length; i++) {
      const ai = order[i];
      const system =
        systemPrompts[ai] ??
        parsed.system ??
        (i === 0
          ? "You are the first AI in a chain. Provide a thorough initial response."
          : i === order.length - 1
          ? "You are the final AI in a chain. Synthesize all previous responses into a definitive answer."
          : "You are in the middle of a chain. Build on the previous response.");

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

  // ─── Synthesis (--diff / --score equivalents) ────────────────────────────
  const synthesisMeta: Record<string, unknown> = {};
  const usableForSynthesis = collected.filter((r) => !r.error && r.content.trim().length > 0);

  if (parsed.diff && usableForSynthesis.length >= 2) {
    send("synthesis_start", { kind: "diff" });
    const diffPrompt = formatResponsesForSynthesis(parsed.prompt, collected);
    const diffResult = await callClaude(
      [{ role: "user", content: diffPrompt }],
      DIFF_SYSTEM_PROMPT,
      {
        tier: "utility",
        tokens: (chunk) => send("synthesis_token", { kind: "diff", delta: chunk }),
      }
    );
    send("synthesis_done", { kind: "diff", content: diffResult.content, error: diffResult.error });
    if (!diffResult.error) {
      synthesisMeta.synthesis = { content: diffResult.content, duration_ms: diffResult.duration_ms };
    }
  }

  if (parsed.score && usableForSynthesis.length >= 2) {
    send("synthesis_start", { kind: "score" });
    const scorePrompt = formatResponsesForSynthesis(parsed.prompt, collected);
    const scoreResult = await callClaude(
      [{ role: "user", content: scorePrompt }],
      CONFIDENCE_SYSTEM_PROMPT,
      { tier: "utility" }
    );
    let report: unknown = null;
    let scoreError: string | undefined = scoreResult.error;
    if (!scoreError) {
      try {
        let text = scoreResult.content.trim();
        const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
        if (fence) text = fence[1].trim();
        report = JSON.parse(text);
      } catch (err) {
        scoreError = `Failed to parse confidence report: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    send("synthesis_done", { kind: "score", report, error: scoreError });
    if (report) synthesisMeta.confidence = report;
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - runStart;

  try {
    insertSession({
      id: runId,
      mode: parsed.mode,
      prompt: parsed.prompt,
      project: null,
      ais: order,
      responses: collected.map((r) => ({
        ai: r.ai,
        content: r.content,
        error: r.error,
        duration_ms: r.duration_ms,
        started_at: r.started_at,
        finished_at: r.finished_at,
        model: r.model,
        usage: r.usage,
      })),
      duration_ms: durationMs,
      preset: parsed.preset ?? null,
      system_prompt: parsed.system ?? null,
      metadata: { source: "ui", tier: parsed.tier ?? "main", ...synthesisMeta },
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
