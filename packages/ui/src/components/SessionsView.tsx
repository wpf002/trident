import { useEffect, useState } from "react";
import { SessionRun, aiLabel } from "../types.js";

async function fetchSessions(): Promise<SessionRun[]> {
  const res = await fetch("/api/sessions");
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const data = (await res.json()) as { sessions: SessionRun[] };
  return data.sessions;
}

async function fetchSession(id: string): Promise<SessionRun> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const data = (await res.json()) as { session: SessionRun };
  return data.session;
}

export function SessionsView() {
  const [sessions, setSessions] = useState<SessionRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SessionRun | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const all = await fetchSessions();
      setSessions(all);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleSelect = async (id: string) => {
    try {
      const s = await fetchSession(id);
      setSelected(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <h2 className="title">Sessions</h2>
      <p className="subtitle">Past parallel and chain runs. Click a row to replay full output.</p>

      <div className="toolbar">
        <button onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
        <span className="muted tiny">{sessions.length} sessions</span>
      </div>

      {error && <div className="error">{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(360px, 1fr) 2fr", gap: 16, marginTop: 16 }}>
        <div className="card" style={{ maxHeight: "70vh", overflowY: "auto" }}>
          {sessions.length === 0 && <div className="muted">No sessions yet.</div>}
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => handleSelect(s.id)}
              className={"list-row" + (selected?.id === s.id ? " active" : "")}
              style={{ width: "100%", border: "none", color: "var(--text)", background: "transparent" }}
            >
              <div>
                <div className="row" style={{ gap: 6 }}>
                  <span className={"tag " + (s.mode === "parallel" ? "perplexity" : "claude")}>{s.mode}</span>
                  {s.preset && <span className="tag">{s.preset}</span>}
                  {s.project && <span className="tag">{s.project}</span>}
                </div>
                <div style={{ marginTop: 4 }}>{s.prompt.slice(0, 100)}{s.prompt.length > 100 ? "…" : ""}</div>
                <div className="muted tiny">
                  {s.created_at} · {s.duration_ms}ms · {s.ais.map(aiLabel).join(", ")}
                </div>
              </div>
              <div className="muted tiny" style={{ fontFamily: "ui-monospace, monospace" }}>{s.id}</div>
            </button>
          ))}
        </div>

        <div className="card">
          {selected ? <SessionDetail session={selected} /> : <div className="muted">Select a session to view its full output.</div>}
        </div>
      </div>
    </div>
  );
}

function SessionDetail({ session }: { session: SessionRun }) {
  return (
    <div className="column">
      <div>
        <div className="row" style={{ gap: 6 }}>
          <span className="tag">{session.mode}</span>
          {session.preset && <span className="tag">{session.preset}</span>}
          {session.project && <span className="tag">{session.project}</span>}
        </div>
        <h3 style={{ margin: "12px 0 4px" }}>Prompt</h3>
        <pre>{session.prompt}</pre>
        <div className="muted tiny">
          {session.duration_ms}ms total · started {session.started_at}
        </div>
      </div>
      <div className="divider" />
      {session.responses.map((r, i) => (
        <div key={i}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h4 style={{ margin: 0 }}>
              <span className={"tag " + r.ai}>{aiLabel(r.ai)}</span>
              {session.mode === "chain" && <span className="muted tiny" style={{ marginLeft: 8 }}>step {i + 1}/{session.responses.length}</span>}
            </h4>
            <span className="muted tiny">{r.duration_ms}ms</span>
          </div>
          {r.error ? <div className="error" style={{ marginTop: 6 }}>{r.error}</div> : <pre>{r.content}</pre>}
        </div>
      ))}
      {session.metadata && Object.keys(session.metadata).length > 0 && (
        <div>
          <h4>Metadata</h4>
          <pre>{JSON.stringify(session.metadata, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
