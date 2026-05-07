import { useState } from "react";
import { aiLabel, AIName } from "../types.js";
import { MarkdownView } from "./MarkdownView.js";
import { formatDuration } from "../lib/format.js";

interface StreamResponse {
  ai: AIName;
  content: string;
  error?: string;
  duration_ms: number;
  started_at: string;
  finished_at: string;
  step?: number;
  total?: number;
}

interface RunState {
  id: string;
  status: "running" | "done";
  order: AIName[];
  startedAt: string;
  durationMs?: number;
  active: Set<AIName>;
  responses: StreamResponse[];
  partial: Record<string, string>;
  partialStart: Record<string, string>;
  partialStep?: Record<string, { step: number; total: number }>;
  diffPartial?: string;
  diffContent?: string;
  diffError?: string;
  diffActive?: boolean;
  scoreReport?: {
    scores: Array<{ ai: string; confidence: number; rationale: string }>;
    agreement: "low" | "medium" | "high";
    consensus: string[];
    disagreement: string[];
  };
  scoreError?: string;
  scoreActive?: boolean;
}

type Tier = "premium" | "main" | "utility";

const ALL_AIS: AIName[] = ["claude", "gpt", "perplexity"];
const PRESETS = [
  "draft-refine-verify",
  "research-analyze-summarize",
  "attack-defend-judge",
  "research-ideate-build",
];

interface RawResponseEvent {
  ai: AIName;
  content?: string;
  error?: string;
  duration_ms?: number;
  started_at?: string;
  finished_at?: string;
  step?: number;
  total?: number;
}

interface StartEvent {
  id: string;
  mode: "parallel" | "chain";
  order: AIName[];
  project: string | null;
  started_at: string;
}

export function QueryView() {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"parallel" | "chain">("parallel");
  const [ais, setAis] = useState<AIName[]>([...ALL_AIS]);
  const [preset, setPreset] = useState<string>("");
  const [system, setSystem] = useState("");
  const [tier, setTier] = useState<Tier>("main");
  const [run, setRun] = useState<RunState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggleAi = (ai: AIName) => {
    setAis((curr) => (curr.includes(ai) ? curr.filter((a) => a !== ai) : [...curr, ai]));
  };

  const newChat = () => {
    setPrompt("");
    setSystem("");
    setRun(null);
    setError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const start = async () => {
    setError(null);
    if (!prompt.trim()) {
      setError("Type something to ask first.");
      return;
    }
    if (mode === "parallel" && ais.length === 0) {
      setError("Pick at least one AI to ask.");
      return;
    }

    const body = {
      prompt,
      mode,
      ais,
      preset: mode === "chain" && preset ? preset : undefined,
      system: system || undefined,
      tier,
      diff: mode === "parallel" ? true : undefined,
      score: mode === "parallel" ? true : undefined,
    };

    let response: Response;
    try {
      response = await fetch("/api/query/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    if (!response.ok || !response.body) {
      const text = await response.text();
      setError(`server returned ${response.status}: ${text}`);
      return;
    }

    setRun({
      id: "(pending)",
      status: "running",
      order: [],
      startedAt: new Date().toISOString(),
      active: new Set(),
      responses: [],
      partial: {},
      partialStart: {},
      partialStep: {},
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleEvent = (event: string, dataStr: string) => {
      let data: unknown;
      try {
        data = JSON.parse(dataStr);
      } catch {
        return;
      }
      setRun((curr) => {
        if (!curr) return curr;
        switch (event) {
          case "start": {
            const d = data as StartEvent;
            return { ...curr, id: d.id, order: d.order, startedAt: d.started_at };
          }
          case "ai_start": {
            const d = data as RawResponseEvent;
            const next = new Set(curr.active);
            next.add(d.ai);
            const partial = { ...curr.partial, [d.ai]: "" };
            const partialStart = { ...curr.partialStart, [d.ai]: d.started_at ?? new Date().toISOString() };
            const partialStep = { ...(curr.partialStep ?? {}) };
            if (d.step && d.total) partialStep[d.ai] = { step: d.step, total: d.total };
            return { ...curr, active: next, partial, partialStart, partialStep };
          }
          case "ai_token": {
            const d = data as { ai: AIName; delta: string };
            return {
              ...curr,
              partial: { ...curr.partial, [d.ai]: (curr.partial[d.ai] ?? "") + d.delta },
            };
          }
          case "ai_done": {
            const d = data as RawResponseEvent;
            const next = new Set(curr.active);
            next.delete(d.ai);
            const partial = { ...curr.partial };
            delete partial[d.ai];
            return {
              ...curr,
              active: next,
              partial,
              responses: [
                ...curr.responses,
                {
                  ai: d.ai,
                  content: d.content ?? "",
                  error: d.error,
                  duration_ms: d.duration_ms ?? 0,
                  started_at: d.started_at ?? "",
                  finished_at: d.finished_at ?? "",
                  step: d.step,
                  total: d.total,
                },
              ],
            };
          }
          case "synthesis_start": {
            const d = data as { kind: "diff" | "score" };
            return d.kind === "diff"
              ? { ...curr, diffActive: true, diffPartial: "" }
              : { ...curr, scoreActive: true };
          }
          case "synthesis_token": {
            const d = data as { kind: "diff" | "score"; delta: string };
            if (d.kind === "diff") {
              return { ...curr, diffPartial: (curr.diffPartial ?? "") + d.delta };
            }
            return curr;
          }
          case "synthesis_done": {
            const d = data as
              | { kind: "diff"; content: string; error?: string }
              | { kind: "score"; report: RunState["scoreReport"]; error?: string };
            if (d.kind === "diff") {
              return {
                ...curr,
                diffActive: false,
                diffContent: d.error ? undefined : d.content,
                diffError: d.error,
                diffPartial: undefined,
              };
            }
            return {
              ...curr,
              scoreActive: false,
              scoreReport: d.error ? undefined : d.report,
              scoreError: d.error,
            };
          }
          case "done": {
            const d = data as { id: string; duration_ms: number; finished_at: string };
            return { ...curr, status: "done", durationMs: d.duration_ms, id: d.id };
          }
          case "warn": {
            const d = data as { message: string };
            console.warn("Stream warning:", d.message);
            return curr;
          }
          default:
            return curr;
        }
      });
    };

    const parseBuffer = () => {
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = "message";
        const lines = chunk.split("\n");
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length > 0) handleEvent(event, dataLines.join("\n"));
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        parseBuffer();
      }
      buffer += decoder.decode();
      parseBuffer();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <header className="page-header">
        <h2 className="page-title">Chat</h2>
        <p className="page-subtitle">
          Ask once, hear back from all three. Their answers come in as they think.
        </p>
        <div className="divider" />
      </header>

      <div className="card">
        <div className="column">
          <div>
            <div className="label">Prompt</div>
            <textarea
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What's on your mind?"
            />
          </div>
          <div>
            <div className="label">System prompt (optional)</div>
            <textarea
              rows={2}
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              placeholder="Want them to take a specific tone, role, or angle? Drop it here."
            />
          </div>
          <div className="row">
            <div style={{ minWidth: 140 }}>
              <div className="label">Mode</div>
              <select value={mode} onChange={(e) => setMode(e.target.value as "parallel" | "chain")}>
                <option value="parallel">Parallel</option>
                <option value="chain">Chain</option>
              </select>
            </div>
            {mode === "chain" && (
              <div style={{ minWidth: 220 }}>
                <div className="label">Preset</div>
                <select value={preset} onChange={(e) => setPreset(e.target.value)}>
                  <option value="">Custom order</option>
                  {PRESETS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div>
            <div className="label">
              AIs {mode === "chain" && preset ? "(set by the preset)" : ""}
            </div>
            <div className="row ai-toggles">
              {ALL_AIS.map((ai) => {
                const active = ais.includes(ai);
                return (
                  <button
                    key={ai}
                    onClick={() => toggleAi(ai)}
                    className={active ? "primary" : "secondary"}
                    style={{ minWidth: 120 }}
                    disabled={mode === "chain" && !!preset}
                  >
                    {aiLabel(ai)}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="row">
            <div style={{ minWidth: 220 }}>
              <div className="label">Model tier</div>
              <select value={tier} onChange={(e) => setTier(e.target.value as Tier)}>
                <option value="utility">Fast — Haiku · 4o-mini · sonar</option>
                <option value="main">Main — Sonnet · 4o-mini · sonar-pro</option>
                <option value="premium">Premium — Opus · 4o · sonar-reasoning</option>
              </select>
            </div>
          </div>
          <div className="row">
            <button className="primary" onClick={start} disabled={run?.status === "running"}>
              {run?.status === "running" ? (
                <span className="row" style={{ gap: 8 }}>
                  <span className="spinner" /> Working on it…
                </span>
              ) : (
                "Ask"
              )}
            </button>
            {run && run.status !== "running" && (
              <button className="secondary" onClick={newChat}>
                New chat
              </button>
            )}
            {error && <span className="error">{error}</span>}
          </div>
        </div>
      </div>

      {run && (
        <div style={{ marginTop: 20 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="row">
              <span className="label" style={{ margin: 0 }}>
                Session
              </span>
              {run.status === "running" && <span className="spinner" />}
            </div>
            {run.durationMs !== undefined && (
              <span className="muted tiny">{formatDuration(run.durationMs)}</span>
            )}
          </div>
          <div className="divider" />

          {run.responses.length === 0 && run.status === "running" && (
            <div className="muted">Hang tight — first reply on its way.</div>
          )}

          {run.responses.map((r, i) => (
            <div key={i} className="card">
              <div className="card-header">
                <div className="row">
                  <span className={"tag " + r.ai}>{aiLabel(r.ai)}</span>
                  {r.step && r.total && (
                    <span className="muted tiny">
                      step {r.step}/{r.total}
                    </span>
                  )}
                </div>
                <span className="muted tiny">{formatDuration(r.duration_ms)}</span>
              </div>
              {r.error ? (
                <div className="error">{r.error}</div>
              ) : (
                <MarkdownView text={r.content} />
              )}
            </div>
          ))}

          {Array.from(run.active).map((ai) => {
            const partial = run.partial[ai] ?? "";
            const step = run.partialStep?.[ai];
            return (
              <div key={"active-" + ai} className="card bordered-blue">
                <div className="card-header">
                  <div className="row">
                    <span className={"tag " + ai}>{aiLabel(ai)}</span>
                    {step && (
                      <span className="muted tiny">
                        step {step.step}/{step.total}
                      </span>
                    )}
                    <span className="spinner" />
                  </div>
                  <span className="muted tiny">writing…</span>
                </div>
                {partial.length === 0 ? (
                  <div className="muted">thinking it over…</div>
                ) : (
                  <div>
                    <MarkdownView text={partial} />
                    <span className="cursor">▍</span>
                  </div>
                )}
              </div>
            );
          })}

          {(run.diffActive || run.diffContent || run.diffError || run.diffPartial) && (
            <>
              <div className="divider" style={{ margin: "20px 0" }} />
              <div className="card bordered-gold">
                <div className="card-header">
                  <div className="row">
                    <span className="tag claude">Verdict</span>
                    {run.diffActive && <span className="spinner" />}
                  </div>
                  {run.diffActive && <span className="muted tiny">writing…</span>}
                </div>
                {run.diffError ? (
                  <div className="error">{run.diffError}</div>
                ) : (
                  <div>
                    <MarkdownView text={run.diffContent ?? run.diffPartial ?? ""} />
                    {run.diffActive && <span className="cursor">▍</span>}
                  </div>
                )}
              </div>
            </>
          )}

          {(run.scoreActive || run.scoreReport || run.scoreError) && (
            <div className="card bordered-blue">
              <div className="card-header">
                <div className="row">
                  <span className="tag perplexity">Confidence Score</span>
                  {run.scoreActive && <span className="spinner" />}
                </div>
                {run.scoreActive && <span className="muted tiny">comparing…</span>}
              </div>
              {run.scoreError ? (
                <div className="error">{run.scoreError}</div>
              ) : run.scoreReport ? (
                <ConfidenceReportView report={run.scoreReport} />
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ConfidenceReport {
  scores: Array<{ ai: string; confidence: number; rationale: string }>;
  agreement: "low" | "medium" | "high";
  consensus: string[];
  disagreement: string[];
}

function ConfidenceReportView({ report }: { report: ConfidenceReport }) {
  const agreementColor =
    report.agreement === "high"
      ? "var(--green)"
      : report.agreement === "medium"
      ? "var(--yellow)"
      : "var(--red)";
  return (
    <div className="column">
      {report.scores.map((s) => {
        const w = Math.max(0, Math.min(100, s.confidence));
        return (
          <div key={s.ai}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className={"tag " + s.ai}>{aiLabel(s.ai)}</span>
              <span className="muted tiny">{s.confidence}/100</span>
            </div>
            <div className="confidence-bar">
              <div style={{ width: `${w}%` }} />
            </div>
            <div className="muted tiny" style={{ marginTop: 4 }}>
              {s.rationale}
            </div>
          </div>
        );
      })}
      <div className="muted tiny">
        Overall Agreement:{" "}
        <span style={{ color: agreementColor, fontWeight: 600, textTransform: "uppercase" }}>
          {report.agreement}
        </span>
      </div>
    </div>
  );
}
