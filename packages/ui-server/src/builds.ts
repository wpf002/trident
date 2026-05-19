// /api/builds/* routes. Mounted on the shared Express app in index.ts.

import { Router, type Request, type Response } from "express";
import {
  abortBuild,
  createAndRunBuild,
  getBuild,
  globalBus,
  listBuilds,
  listEvents,
  listTasksForBuild,
  pauseBuild,
  resumeBuild,
  summarizeBuild,
  type BuildEvent,
} from "@trident/builder";

export const buildsRouter = Router();

// ─── list ────────────────────────────────────────────────────────────────

buildsRouter.get("/", (_req: Request, res: Response) => {
  const builds = listBuilds(100).map((b) => {
    const summary = summarizeBuild(b.id);
    return summary ?? b;
  });
  res.json({ builds });
});

// ─── create ──────────────────────────────────────────────────────────────

buildsRouter.post("/", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.spec_path !== "string" || !body.spec_path.trim()) {
    res.status(400).json({ error: "spec_path required" });
    return;
  }
  if (typeof body.source_repo !== "string" || !body.source_repo.trim()) {
    res.status(400).json({ error: "source_repo required" });
    return;
  }
  try {
    const buildId = await createAndRunBuild({
      specPath: body.spec_path,
      sourceRepo: body.source_repo,
      baseBranch: typeof body.base_branch === "string" ? body.base_branch : undefined,
      config: (body.config as Record<string, never>) ?? undefined,
      metadata: (body.metadata as Record<string, unknown>) ?? undefined,
    });
    res.json({ id: buildId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── detail ──────────────────────────────────────────────────────────────

buildsRouter.get("/:id", (req: Request, res: Response) => {
  const b = getBuild(req.params.id);
  if (!b) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const tasks = listTasksForBuild(b.id);
  res.json({ build: b, tasks });
});

// ─── events (snapshot) ────────────────────────────────────────────────────

buildsRouter.get("/:id/events", (req: Request, res: Response) => {
  const afterId = parseInt(String(req.query.from ?? "0"), 10);
  const limit = Math.min(parseInt(String(req.query.limit ?? "500"), 10), 2000);
  const events = listEvents(req.params.id, { afterId, limit });
  res.json({ events });
});

// ─── events (SSE) ─────────────────────────────────────────────────────────

buildsRouter.get("/:id/stream", (req: Request, res: Response) => {
  const buildId = req.params.id;
  const fromId = parseInt(String(req.query.from ?? "0"), 10) || 0;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Replay any events the client missed since `from`.
  const backlog = listEvents(buildId, { afterId: fromId, limit: 2000 });
  for (const ev of backlog) {
    res.write(`event: ${ev.kind}\n`);
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  const unsub = globalBus.subscribe(buildId, (ev: BuildEvent) => {
    res.write(`event: ${ev.kind}\n`);
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  });

  // Keep-alive — some proxies/clients drop after ~30s of idle.
  const keepalive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 25_000);

  req.on("close", () => {
    clearInterval(keepalive);
    unsub();
  });
});

// ─── diff ─────────────────────────────────────────────────────────────────

buildsRouter.get("/:id/diff", async (req: Request, res: Response) => {
  const b = getBuild(req.params.id);
  if (!b) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const filePath = req.query.file as string | undefined;
    const args = ["diff", b.base_branch + "..." + b.builder_branch];
    if (filePath) args.push("--", filePath);
    const { stdout } = await execFileAsync("git", args, {
      cwd: b.workspace_path,
      maxBuffer: 16 * 1024 * 1024,
    });
    res.type("text/plain").send(stdout);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── control ──────────────────────────────────────────────────────────────

buildsRouter.post("/:id/pause", (req: Request, res: Response) => {
  const ok = pauseBuild(req.params.id);
  if (!ok) {
    res.status(409).json({ error: "cannot pause" });
    return;
  }
  res.json({ ok: true });
});

buildsRouter.post("/:id/resume", (req: Request, res: Response) => {
  const ok = resumeBuild(req.params.id);
  if (!ok) {
    res.status(409).json({ error: "cannot resume" });
    return;
  }
  res.json({ ok: true });
});

buildsRouter.post("/:id/abort", (req: Request, res: Response) => {
  const ok = abortBuild(req.params.id);
  if (!ok) {
    res.status(409).json({ error: "cannot abort" });
    return;
  }
  res.json({ ok: true });
});
