import { useEffect, useRef, useState } from "react";
import { aiLabel, AIName } from "../types.js";
import { MarkdownView } from "./MarkdownView.js";
import { Sources } from "./Sources.js";
import { CopyResultsButton } from "./CopyResultsButton.js";
import { formatDuration } from "../lib/format.js";
import { apiFetch } from "../lib/api.js";

type Tier = "premium" | "main" | "utility";

interface ApiMessage {
  role: "user" | "assistant";
  content: string;
}

interface Turn {
  kind: "ai" | "feedback";
  ai?: AIName;
  step?: number;
  label?: string;
  content: string;
  error?: string;
  citations?: string[];
  duration_ms?: number;
}

interface TurnResult {
  content: string;
  error?: string;
  citations?: string[];
  duration_ms?: number;
}

const CLARIFY_SYSTEM =
  "Decide whether the user's request is ambiguous. If it would genuinely " +
  "benefit from clarification, ask 1-3 short, specific questions and nothing " +
  "else. If it is already clear enough to answer well, reply with exactly: READY";

function isReady(s: string): boolean {
  const t = s.trim();
  return /^ready\b/i.test(t) && t.length < 40;
}

// Clean, standalone step instructions (no meta "you are in a chain" narration).
function stepSystem(
  ai: AIName,
  i: number,
  total: number,
  systemPrompts: Partial<Record<AIName, string>>,
  override?: string
): string {
  if (systemPrompts[ai]) return systemPrompts[ai] as string;
  if (override) return override;
  if (i === 0) return "Give a thorough, well-structured initial response to the user's request.";
  if (i === total - 1) return "Synthesize everything above into a single, clear, standalone final answer.";
  return "Build on and improve the previous response — add depth, fix gaps, and refine.";
}

/**
 * Step-by-step chain: optionally asks clarifying questions first, runs one AI
 * at a time, pauses between steps for feedback, stays open for follow-ups, and
 * saves the whole conversation to History as it goes.
 */
export function InteractiveChain({
  prompt,
  order,
  systemPrompts,
  system,
  tier,
  clarifyFirst,
  onNewChat,
}: {
  prompt: string;
  order: AIName[];
  systemPrompts: Partial<Record<AIName, string>>;
  system?: string;
  tier: Tier;
  clarifyFirst?: boolean;
  onNewChat: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [messages, setMessages] = useState<ApiMessage[]>([{ role: "user", content: prompt }]);
  const [stepIndex, setStepIndex] = useState(0);
  const [clarifying, setClarifying] = useState<boolean>(!!clarifyFirst);
  const [awaitingClarify, setAwaitingClarify] = useState(false);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [streamingAi, setStreamingAi] = useState<AIName | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [clarifyAnswer, setClarifyAnswer] = useState("");
  const [followup, setFollowup] = useState("");
  const [error, setError] = useState<string | null>(null);

  const startedRef = useRef(false);
  const sessionId = useRef<string>(
    typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)
  );
  const startedAt = useRef(new Date().toISOString());
  const startMs = useRef(Date.now());

  const chainDone = !clarifying && stepIndex >= order.length;
  const paused = !busy && !clarifying && !chainDone && stepIndex > 0;

  // Stream a single turn — pure: streams tokens and returns the final result.
  const streamTurn = async (ai: AIName, history: ApiMessage[], sys: string): Promise<TurnResult> => {
    setBusy(true);
    setError(null);
    setStreaming("");
    setStreamingAi(ai);
    let acc = "";
    try {
      const res = await apiFetch("/api/chat/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ messages: history, ai, system: sys, tier }),
      });
      if (!res.ok || !res.body) {
        const t = await res.text();
        throw new Error(`server returned ${res.status}: ${t}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done: TurnResult | null = null;
      for (;;) {
        const { value, done: rd } = await reader.read();
        if (rd) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const ev = block.match(/^event: (.*)$/m)?.[1];
          const dl = block.match(/^data: (.*)$/m)?.[1];
          if (!ev || !dl) continue;
          const data = JSON.parse(dl);
          if (ev === "token") {
            acc += data.delta ?? "";
            setStreaming(acc);
          } else if (ev === "done") {
            done = data;
          }
        }
      }
      return done ?? { content: acc };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return { content: "", error: msg };
    } finally {
      setBusy(false);
      setStreaming(null);
      setStreamingAi(null);
    }
  };

  // Run chain step `i` over `history`, appending optional pre-turns (feedback).
  const runStep = async (i: number, history: ApiMessage[], pre: Turn[] = []) => {
    const ai = order[i];
    const r = await streamTurn(ai, history, stepSystem(ai, i, order.length, systemPrompts, system));
    setTurns((t) => [
      ...t,
      ...pre,
      { kind: "ai", ai, step: i + 1, content: r.content, error: r.error, citations: r.citations, duration_ms: r.duration_ms },
    ]);
    setMessages(r.error || !r.content ? history : [...history, { role: "assistant", content: r.content }]);
    setStepIndex(i + 1);
  };

  // Optional clarify phase before the chain.
  const runClarify = async () => {
    const ai = order[0];
    const r = await streamTurn(ai, [{ role: "user", content: prompt }], CLARIFY_SYSTEM);
    if (r.error || isReady(r.content)) {
      setClarifying(false);
      runStep(0, [{ role: "user", content: prompt }]);
      return;
    }
    setTurns((t) => [
      ...t,
      { kind: "ai", ai, label: "clarifying questions", content: r.content, citations: r.citations, duration_ms: r.duration_ms },
    ]);
    setMessages((m) => [...m, { role: "assistant", content: r.content }]);
    setAwaitingClarify(true);
  };

  const submitClarify = () => {
    const ans = clarifyAnswer.trim();
    // The conversation must end with a user message (Claude rejects otherwise),
    // so always append one — the answer, or a hidden "go ahead" if skipped.
    const history: ApiMessage[] = [...messages, { role: "user", content: ans || "Go ahead with your best answer." }];
    const pre: Turn[] = ans ? [{ kind: "feedback", content: ans }] : [];
    setClarifyAnswer("");
    setAwaitingClarify(false);
    setClarifying(false);
    runStep(0, history, pre);
  };

  const continueChain = (withFeedback: boolean) => {
    const note = withFeedback ? feedback.trim() : "";
    // Always end the conversation with a user message so each step alternates
    // roles (Claude requires the last message to be from the user). A plain
    // "continue" is sent (hidden) when there's no feedback.
    const history: ApiMessage[] = [
      ...messages,
      { role: "user", content: note || "Continue — build on and improve the response above." },
    ];
    const pre: Turn[] = note ? [{ kind: "feedback", content: note }] : [];
    if (note) setFeedback("");
    runStep(stepIndex, history, pre);
  };

  const sendFollowup = async () => {
    if (!followup.trim()) return;
    const history = [...messages, { role: "user" as const, content: followup.trim() }];
    setTurns((t) => [...t, { kind: "feedback", content: followup.trim() }]);
    setMessages(history);
    setFollowup("");
    const ai = order[order.length - 1];
    const r = await streamTurn(ai, history, "Continue the conversation, directly addressing the user's latest message.");
    setTurns((t) => [
      ...t,
      { kind: "ai", ai, content: r.content, error: r.error, citations: r.citations, duration_ms: r.duration_ms },
    ]);
    if (!r.error && r.content) setMessages((m) => [...m, { role: "assistant", content: r.content }]);
  };

  // Kick off once.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (clarifyFirst) runClarify();
    else runStep(0, [{ role: "user", content: prompt }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist (upsert) to History whenever the transcript grows.
  useEffect(() => {
    const aiTurns = turns.filter((t) => t.kind === "ai");
    if (aiTurns.length === 0) return;
    const finishedAt = new Date().toISOString();
    apiFetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: sessionId.current,
        mode: "chain",
        prompt,
        ais: order,
        responses: aiTurns.map((t) => ({
          ai: t.ai ?? "",
          content: t.error ? "" : t.content,
          error: t.error,
          duration_ms: t.duration_ms ?? 0,
          started_at: startedAt.current,
          finished_at: finishedAt,
          citations: t.citations,
        })),
        duration_ms: Date.now() - startMs.current,
        metadata: { source: "ui-interactive", transcript: turns },
        started_at: startedAt.current,
        finished_at: finishedAt,
      }),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns]);

  const copyResponses = turns
    .filter((t) => t.kind === "ai")
    .map((t) => ({ ai: t.ai ?? "", content: t.content, error: t.error }));

  return (
    <div style={{ marginTop: 20 }} className="column">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="label" style={{ margin: 0 }}>
          Chain · {order.map(aiLabel).join(" → ")}
        </span>
        <div className="row" style={{ gap: 8 }}>
          <CopyResultsButton prompt={prompt} responses={copyResponses} />
          <button className="secondary" onClick={onNewChat}>
            New Chat
          </button>
        </div>
      </div>

      <div className="card">
        <div className="label">Prompt</div>
        <pre>{prompt}</pre>
      </div>

      {turns.map((t, i) =>
        t.kind === "feedback" ? (
          <div key={i} className="chain-feedback">
            <span className="label" style={{ margin: 0 }}>
              You
            </span>
            <div>{t.content}</div>
          </div>
        ) : (
          <div key={i} className="card">
            <div className="card-header">
              <div className="row">
                <span className={"tag " + t.ai}>{aiLabel(t.ai ?? "")}</span>
                {t.label && <span className="muted tiny">{t.label}</span>}
                {t.step && <span className="muted tiny">step {t.step}</span>}
              </div>
              {t.duration_ms !== undefined && (
                <span className="muted tiny">{formatDuration(t.duration_ms)}</span>
              )}
            </div>
            {t.error ? (
              <div className="error">{t.error}</div>
            ) : (
              <>
                <MarkdownView text={t.content} perplexity={t.ai === "perplexity"} />
                <Sources citations={t.citations} />
              </>
            )}
          </div>
        )
      )}

      {streaming !== null && (
        <div className="card">
          <div className="card-header">
            <div className="row">
              <span className={"tag " + (streamingAi ?? "")}>{aiLabel(streamingAi ?? "")}</span>
              <span className="spinner" />
              {clarifying && <span className="muted tiny">clarifying…</span>}
            </div>
          </div>
          <MarkdownView text={streaming} perplexity={streamingAi === "perplexity"} />
          <span className="cursor">▍</span>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {/* Answer the clarifying questions, then start the chain. */}
      {awaitingClarify && !busy && (
        <div className="card bordered-gold column">
          <div className="label" style={{ margin: 0 }}>
            Answer the questions above, then start the chain
          </div>
          <textarea
            placeholder="Your answers / extra context…"
            value={clarifyAnswer}
            onChange={(e) => setClarifyAnswer(e.target.value)}
            rows={3}
          />
          <div className="row">
            <button className="primary" onClick={submitClarify} disabled={busy}>
              {clarifyAnswer.trim() ? "Answer → start chain" : "Skip → start chain"}
            </button>
          </div>
        </div>
      )}

      {/* Between-step pause: continue, optionally with feedback. */}
      {paused && (
        <div className="card bordered-gold column">
          <div className="label" style={{ margin: 0 }}>
            Paused — next: {aiLabel(order[stepIndex])} (step {stepIndex + 1}/{order.length})
          </div>
          <textarea
            placeholder="Optional: add feedback or steer the next step before continuing…"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={2}
          />
          <div className="row">
            <button className="primary" onClick={() => continueChain(true)} disabled={busy}>
              {feedback.trim() ? `Add note → ${aiLabel(order[stepIndex])}` : `Continue → ${aiLabel(order[stepIndex])}`}
            </button>
          </div>
        </div>
      )}

      {/* After the chain: keep the dialogue going. */}
      {chainDone && !busy && (
        <div className="card column">
          <div className="label" style={{ margin: 0 }}>
            Follow-up — keep the conversation going
          </div>
          <textarea
            placeholder="Ask a follow-up or push back on the answer…"
            value={followup}
            onChange={(e) => setFollowup(e.target.value)}
            rows={2}
          />
          <div className="row">
            <button className="primary" onClick={sendFollowup} disabled={!followup.trim()}>
              Send → {aiLabel(order[order.length - 1])}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
