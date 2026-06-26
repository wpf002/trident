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
  content: string;
  error?: string;
  citations?: string[];
  duration_ms?: number;
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
 * Step-by-step chain: runs one AI at a time, pauses between steps so the user
 * can add feedback before continuing, and stays open for follow-up turns.
 */
export function InteractiveChain({
  prompt,
  order,
  systemPrompts,
  system,
  tier,
  onNewChat,
}: {
  prompt: string;
  order: AIName[];
  systemPrompts: Partial<Record<AIName, string>>;
  system?: string;
  tier: Tier;
  onNewChat: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [messages, setMessages] = useState<ApiMessage[]>([{ role: "user", content: prompt }]);
  const [stepIndex, setStepIndex] = useState(0); // next index in `order` to run
  const [streaming, setStreaming] = useState<string | null>(null);
  const [streamingAi, setStreamingAi] = useState<AIName | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [followup, setFollowup] = useState("");
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const chainDone = stepIndex >= order.length;
  const paused = !busy && !chainDone && stepIndex > 0;

  // Run a single AI turn against the given message history.
  const runTurn = async (ai: AIName, history: ApiMessage[], sys: string, step?: number) => {
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
      let done: { content: string; error?: string; citations?: string[]; duration_ms?: number } | null = null;
      for (;;) {
        const { value, done: rdDone } = await reader.read();
        if (rdDone) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const ev = block.match(/^event: (.*)$/m)?.[1];
          const dataLine = block.match(/^data: (.*)$/m)?.[1];
          if (!ev || !dataLine) continue;
          const data = JSON.parse(dataLine);
          if (ev === "token") {
            acc += data.delta ?? "";
            setStreaming(acc);
          } else if (ev === "done") {
            done = data;
          }
        }
      }
      const result = done ?? { content: acc };
      const turn: Turn = {
        kind: "ai",
        ai,
        step,
        content: result.content ?? acc,
        error: result.error,
        citations: result.citations,
        duration_ms: result.duration_ms,
      };
      setTurns((t) => [...t, turn]);
      if (!result.error && (result.content ?? acc)) {
        setMessages((m) => [...m, { role: "assistant", content: result.content ?? acc }]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setStreaming(null);
      setStreamingAi(null);
    }
  };

  // Kick off the first step once.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const ai = order[0];
    runTurn(ai, [{ role: "user", content: prompt }], stepSystem(ai, 0, order.length, systemPrompts, system), 1);
    setStepIndex(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const continueChain = (withFeedback: boolean) => {
    let history = messages;
    const extra: Turn[] = [];
    if (withFeedback && feedback.trim()) {
      const fb: ApiMessage = { role: "user", content: feedback.trim() };
      history = [...messages, fb];
      setMessages(history);
      extra.push({ kind: "feedback", content: feedback.trim() });
      setFeedback("");
    }
    if (extra.length) setTurns((t) => [...t, ...extra]);
    const ai = order[stepIndex];
    runTurn(ai, history, stepSystem(ai, stepIndex, order.length, systemPrompts, system), stepIndex + 1);
    setStepIndex(stepIndex + 1);
  };

  const sendFollowup = () => {
    if (!followup.trim()) return;
    const msg: ApiMessage = { role: "user", content: followup.trim() };
    const history = [...messages, msg];
    setMessages(history);
    setTurns((t) => [...t, { kind: "feedback", content: followup.trim() }]);
    setFollowup("");
    const ai = order[order.length - 1]; // the final/synthesizer AI handles follow-ups
    runTurn(ai, history, "Continue the conversation, directly addressing the user's latest message.");
  };

  // For Copy Results: prompt + each AI turn.
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
                <MarkdownView text={t.content} />
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
            </div>
          </div>
          <MarkdownView text={streaming} />
          <span className="cursor">▍</span>
        </div>
      )}

      {error && <div className="error">{error}</div>}

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
