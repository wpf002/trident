import { Fragment, useEffect, useState } from "react";
import { SessionRun, aiLabel } from "../types.js";
import { MarkdownView } from "./MarkdownView.js";

function modeLabel(mode: string): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

interface SessionDayGroup {
  label: string;
  items: SessionRun[];
}

function groupSessionsByDay(sessions: SessionRun[]): SessionDayGroup[] {
  const groups = new Map<string, SessionRun[]>();
  for (const s of sessions) {
    const key = dayKey(s.created_at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Unknown";
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

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

  useEffect(() => {
    load();
  }, []);

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
      <header className="page-header">
        <h2 className="page-title">History</h2>
        <p className="page-subtitle">
          Past parallel and chain runs. Click any entry to replay its full output.
        </p>
        <div className="divider" />
      </header>

      {error && (
        <div className="error" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div className="split-panes">
        {/* Left: history list */}
        <div className="pane">
          <div className="pane-header">
            <div className="row">
              <span className="label" style={{ margin: 0 }}>
                History
              </span>
              <span className="muted tiny">{sessions.length} sessions</span>
            </div>
            <button className="secondary" onClick={load} disabled={loading}>
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
          <div className="pane-body history-list">
            {sessions.length === 0 ? (
              <div className="pane-empty">No sessions yet.</div>
            ) : (
              groupSessionsByDay(sessions).map((group) => (
                <Fragment key={group.label}>
                  <div className="history-day-header">
                    <span className="history-day-label">{group.label}</span>
                    <span className="muted tiny">{group.items.length}</span>
                  </div>
                  {group.items.map((s, i) => (
                    <Fragment key={s.id}>
                      {i > 0 && <div className="history-separator" />}
                      <SessionListRow
                        session={s}
                        active={selected?.id === s.id}
                        onClick={() => handleSelect(s.id)}
                      />
                    </Fragment>
                  ))}
                </Fragment>
              ))
            )}
          </div>
        </div>

        {/* Right: detail */}
        <div className="pane">
          {selected ? (
            <SessionDetail session={selected} />
          ) : (
            <>
              <div className="pane-header">
                <span className="label" style={{ margin: 0 }}>
                  Detail
                </span>
              </div>
              <div className="pane-empty">Select a session to view its full output.</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionListRow({
  session,
  active,
  onClick,
}: {
  session: SessionRun;
  active: boolean;
  onClick: () => void;
}) {
  const tokIn = session.responses.reduce((acc, r) => acc + (r.usage?.input_tokens ?? 0), 0);
  const tokOut = session.responses.reduce((acc, r) => acc + (r.usage?.output_tokens ?? 0), 0);
  const tokSummary = tokIn + tokOut > 0 ? `${tokIn}↑ / ${tokOut}↓` : null;

  return (
    <button
      onClick={onClick}
      className={"history-row" + (active ? " active" : "")}
    >
      <div className="history-row-time">
        <div className="history-row-time-main">{formatTimeOnly(session.created_at)}</div>
        <div className="history-row-time-sub">{session.duration_ms}ms</div>
      </div>
      <div className="history-row-marker" aria-hidden="true">
        <span className="history-row-dot" />
      </div>
      <div className="history-row-body">
        <div className="row" style={{ gap: 6, marginBottom: 6 }}>
          <span className={"tag " + session.mode}>{modeLabel(session.mode)}</span>
          {session.preset && <span className="tag">{session.preset}</span>}
          {session.project && <span className="tag">{session.project}</span>}
        </div>
        <div className="history-row-prompt">
          {session.prompt.slice(0, 110)}
          {session.prompt.length > 110 ? "…" : ""}
        </div>
        <div className="muted tiny history-row-meta">
          <span style={{ fontFamily: "JetBrains Mono, monospace" }}>{session.id}</span>
          {tokSummary && <span>· {tokSummary}</span>}
        </div>
      </div>
    </button>
  );
}

function formatTimeOnly(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function SessionDetail({ session }: { session: SessionRun }) {
  return (
    <>
      <div className="pane-header">
        <div className="row">
          <span className={"tag " + session.mode}>{modeLabel(session.mode)}</span>
          {session.preset && <span className="tag">{session.preset}</span>}
          {session.project && <span className="tag">{session.project}</span>}
          <span
            className="muted tiny"
            style={{ fontFamily: "JetBrains Mono, monospace" }}
          >
            {session.id}
          </span>
        </div>
        <span className="muted tiny">{session.duration_ms}ms total</span>
      </div>
      <div className="pane-body padded">
        <div className="column">
          <section>
            <div className="label">Prompt</div>
            <pre>{session.prompt}</pre>
            <div className="muted tiny" style={{ marginTop: 6 }}>
              {formatDate(session.created_at)}
            </div>
          </section>

          <div className="divider" />

          <section className="column">
            <div className="label">Responses ({session.responses.length})</div>
            {session.responses.map((r, i) => {
              const usage = r.usage
                ? `${r.usage.input_tokens}↑/${r.usage.output_tokens}↓ tok`
                : null;
              return (
                <details key={i} className="ai-block">
                  <summary>
                    <div className="row" style={{ gap: 8 }}>
                      <span className={"tag " + r.ai}>{aiLabel(r.ai)}</span>
                      {session.mode === "chain" && (
                        <span className="muted tiny">
                          step {i + 1}/{session.responses.length}
                        </span>
                      )}
                      {r.error && <span className="muted tiny" style={{ color: "var(--red)" }}>error</span>}
                    </div>
                    <div className="muted tiny">
                      {r.duration_ms}ms{usage ? ` · ${usage}` : ""}
                      {r.model ? ` · ${r.model}` : ""}
                    </div>
                  </summary>
                  <div className="ai-block-body">
                    {r.error ? (
                      <div className="error">{r.error}</div>
                    ) : (
                      <MarkdownView text={r.content} />
                    )}
                  </div>
                </details>
              );
            })}
          </section>

          {session.metadata && Object.keys(session.metadata).length > 0 && (
            <>
              <div className="divider" />
              <section>
                <details className="ai-block">
                  <summary>
                    <span className="label" style={{ margin: 0 }}>
                      Metadata
                    </span>
                    <span className="muted tiny">JSON</span>
                  </summary>
                  <div className="ai-block-body">
                    <pre>{JSON.stringify(session.metadata, null, 2)}</pre>
                  </div>
                </details>
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
