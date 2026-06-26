#!/usr/bin/env node
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { nanoid } from "nanoid";
import {
  listSessionSummaries,
  getSessionRun,
  logSessionRun,
  clearSessionRuns,
  aiLabel,
  formatResponsesForSynthesis,
  parseConfidenceReport,
  DIFF_SYSTEM_PROMPT,
  CONFIDENCE_SYSTEM_PROMPT,
} from "@trident/core";
import {
  AI_MAP,
  AIMessage,
  AIName,
  AIResponse,
  CHAIN_PRESETS,
  VALID_AIS,
  ModelTier,
  callClaude,
} from "@trident/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

dotenv.config({ path: path.join(REPO_ROOT, ".env") });

const PORT = parseInt(process.env.PORT ?? process.env.TRIDENT_UI_PORT ?? "4242", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const STATIC_DIR = path.join(__dirname, "..", "static");

// ─── Security config ──────────────────────────────────────────────────────────
// Optional shared bearer token. When set, all /api routes (except the public
// auth-status probe) require `Authorization: Bearer <token>`. When unset, the
// API is open — safe only when bound to localhost.
const API_TOKEN = process.env.TRIDENT_API_TOKEN?.trim() || undefined;
// Comma-separated CORS allowlist. The same-origin UI does not need CORS, so the
// default (empty) blocks all cross-origin browser access.
const ALLOWED_ORIGINS = (process.env.TRIDENT_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const isPublicBind = HOST !== "127.0.0.1" && HOST !== "localhost";

// Structured security/audit log. One JSON line per event to stdout. Never
// includes secrets, tokens, or prompt/response bodies — only metadata.
function audit(event: string, req: Request, extra: Record<string, unknown> = {}) {
  const line = {
    ts: new Date().toISOString(),
    event,
    ip: req.ip,
    method: req.method,
    path: req.path,
    ...extra,
  };
  console.log(`[audit] ${JSON.stringify(line)}`);
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function extractBearer(req: Request): string | undefined {
  const h = req.header("authorization");
  if (h && h.startsWith("Bearer ")) return h.slice(7).trim();
  return undefined;
}

// Gate every /api route except the public probe. No-op when no token is set.
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!API_TOKEN) return next();
  if (req.path === "/auth/status") return next();
  const token = extractBearer(req);
  if (!token || !timingSafeEqual(token, API_TOKEN)) {
    audit("auth_failure", req, { reason: token ? "bad_token" : "no_token" });
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

const app = express();
app.disable("x-powered-by");
// Trust the first proxy hop (Railway/edge) so req.ip and rate-limiting key off
// the real client address rather than the proxy. Keep at 1 (not `true`) to
// avoid X-Forwarded-For spoofing that would let clients evade rate limits.
app.set("trust proxy", 1);
app.use(
  helmet({
    // CSP tuned for the Vite bundle (same-origin module script), Google Fonts,
    // and KaTeX/inline styles. Adjust if you add cross-origin assets.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    // Allow cross-origin font/style loads (Google Fonts) under default policies.
    crossOriginEmbedderPolicy: false,
  })
);
app.use(
  cors({
    origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : false,
  })
);
app.use(express.json({ limit: "5mb" }));

// ─── Rate limiting ─────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    audit("rate_limited", req, { scope: "api" });
    res.status(429).json({ error: "rate_limited" });
  },
});
// Paid-LLM endpoint: tighter cap to bound spend / abuse.
const queryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    audit("rate_limited", req, { scope: "query" });
    res.status(429).json({ error: "rate_limited", detail: "Too many queries; try again later." });
  },
});
app.use("/api", apiLimiter);
app.use("/api", requireAuth);

// ─── Auth probe (public) ─────────────────────────────────────────────────────
// Lets the UI know whether to show a token gate. Returns no secret.
app.get("/api/auth/status", (_req: Request, res: Response) => {
  res.json({ authRequired: !!API_TOKEN });
});
// Authenticated no-op the UI uses to validate an entered token.
app.get("/api/auth/check", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// Chain presets (order + per-step system prompts) so the client can drive an
// interactive, step-by-step chain.
app.get("/api/presets", (_req: Request, res: Response) => {
  res.json({ presets: CHAIN_PRESETS });
});

// ─── Sessions ────────────────────────────────────────────────────────────────

app.get("/api/sessions", (_req: Request, res: Response) => {
  // Summaries omit response bodies — the list view only needs row headers.
  res.json({ sessions: listSessionSummaries({ limit: 200 }) });
});

app.delete("/api/sessions", (req: Request, res: Response) => {
  const removed = clearSessionRuns();
  audit("sessions_cleared", req, { removed });
  res.json({ removed });
});

app.get("/api/sessions/:id", (req: Request, res: Response) => {
  const session = getSessionRun(req.params.id);
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

// Diff/score prompts + formatter + parser are shared via @trident/core so the
// UI and CLI can't drift (imported at the top of this file).

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

app.post("/api/query/stream", queryLimiter, async (req: Request, res: Response) => {
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

  audit("query", req, { runId, mode: parsed.mode, ais: order, tier: parsed.tier ?? "main", prompt_len: parsed.prompt.length });
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
    const diffPrompt = formatResponsesForSynthesis(parsed.prompt, collected, aiLabel);
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
    const scorePrompt = formatResponsesForSynthesis(parsed.prompt, collected, aiLabel);
    const scoreResult = await callClaude(
      [{ role: "user", content: scorePrompt }],
      CONFIDENCE_SYSTEM_PROMPT,
      { tier: "utility" }
    );
    let report: unknown = null;
    let scoreError: string | undefined = scoreResult.error;
    if (!scoreError) {
      // Shared, validated parser (same one the CLI uses).
      try {
        report = parseConfidenceReport(scoreResult.content);
      } catch (err) {
        scoreError = err instanceof Error ? err.message : String(err);
      }
    }
    send("synthesis_done", { kind: "score", report, error: scoreError });
    if (report) synthesisMeta.confidence = report;
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - runStart;

  try {
    logSessionRun({
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
        citations: r.citations,
      })),
      duration_ms: durationMs,
      preset: parsed.preset ?? null,
      system_prompt: parsed.system ?? null,
      metadata: { source: "ui", tier: parsed.tier ?? "main", ...synthesisMeta },
      started_at: startedAt,
      finished_at: finishedAt,
    });
  } catch (err) {
    // Log full detail server-side; send a generic note to the client.
    console.error(`[error] failed to persist session ${runId}:`, err);
    send("warn", { message: "Failed to persist session." });
  }

  send("done", { id: runId, duration_ms: durationMs, finished_at: finishedAt });
  res.end();
});

// ─── Single chat turn (stateless) ────────────────────────────────────────────
// Runs ONE AI's response to a supplied conversation, streaming tokens. The
// client orchestrates interactive / step-by-step chains by calling this per
// turn and inserting its own user messages (feedback, clarifying answers)
// between turns. Stateless — the full conversation is passed on every call.

interface TurnBody {
  messages: AIMessage[];
  ai: AIName;
  system?: string;
  tier?: ModelTier;
}

function parseTurn(body: unknown): TurnBody | { error: string } {
  if (!body || typeof body !== "object") return { error: "body must be JSON" };
  const b = body as Record<string, unknown>;
  if (typeof b.ai !== "string" || !VALID_AIS.has(b.ai as AIName)) {
    return { error: `invalid ai: ${String(b.ai)}` };
  }
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    return { error: "messages must be a non-empty array" };
  }
  const messages: AIMessage[] = [];
  for (const m of b.messages) {
    if (!m || typeof m !== "object") return { error: "each message must be an object" };
    const mm = m as Record<string, unknown>;
    if (mm.role !== "user" && mm.role !== "assistant") {
      return { error: "message.role must be 'user' or 'assistant'" };
    }
    if (typeof mm.content !== "string") return { error: "message.content must be a string" };
    messages.push({ role: mm.role, content: mm.content });
  }
  if (b.system !== undefined && typeof b.system !== "string") return { error: "system must be a string" };
  if (b.tier !== undefined && (typeof b.tier !== "string" || !VALID_TIERS.has(b.tier))) {
    return { error: "tier must be one of: premium, main, utility" };
  }
  return {
    messages,
    ai: b.ai as AIName,
    system: b.system as string | undefined,
    tier: b.tier as ModelTier | undefined,
  };
}

app.post("/api/chat/turn", queryLimiter, async (req: Request, res: Response) => {
  const parsed = parseTurn(req.body);
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

  audit("turn", req, { ai: parsed.ai, tier: parsed.tier ?? "main", history_len: parsed.messages.length });
  send("start", { ai: parsed.ai, started_at: new Date().toISOString() });

  const result = await AI_MAP[parsed.ai](parsed.messages, parsed.system, {
    tier: parsed.tier ?? "main",
    tokens: (chunk) => send("token", { delta: chunk }),
  });

  send("done", {
    ai: parsed.ai,
    content: result.content,
    error: result.error,
    duration_ms: result.duration_ms,
    model: result.model,
    usage: result.usage,
    citations: result.citations,
    finished_at: new Date().toISOString(),
  });
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

// ─── Error handler ────────────────────────────────────────────────────────────
// Final middleware: log the real error server-side and return a generic message
// so stack traces / internal detail never reach the client (regardless of
// NODE_ENV, which otherwise governs Express's default stack-trace behavior).
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  console.error(`[error] ${req.method} ${req.path}:`, err);
  if (res.headersSent) return;
  res.status(500).json({ error: "internal_error" });
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  console.log(`Trident UI server listening on http://${HOST}:${PORT}`);
  if (API_TOKEN) {
    console.log("Auth: ENABLED (TRIDENT_API_TOKEN set — /api requires a bearer token).");
  } else if (isPublicBind) {
    console.warn(
      `⚠ Auth DISABLED and bound to ${HOST} (public). Anyone who can reach this host can read/delete\n` +
        `  history and spend your API keys. Set TRIDENT_API_TOKEN, or bind locally with HOST=127.0.0.1.`
    );
  } else {
    console.log("Auth: disabled (bound to localhost — set TRIDENT_API_TOKEN before exposing publicly).");
  }
  if (ALLOWED_ORIGINS.length) {
    console.log(`CORS allowlist: ${ALLOWED_ORIGINS.join(", ")}`);
  }
  if (!fs.existsSync(STATIC_DIR)) {
    console.log(`(static UI bundle not found at ${STATIC_DIR} — run 'npm run build --workspace=packages/ui' to build it)`);
  }
});
