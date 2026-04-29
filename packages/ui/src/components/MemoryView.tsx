import { useEffect, useMemo, useState } from "react";
import { MemoryEntry } from "../types.js";

async function fetchEntries(project?: string): Promise<MemoryEntry[]> {
  const url = project ? `/api/memory?project=${encodeURIComponent(project)}` : "/api/memory";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const data = (await res.json()) as { entries: MemoryEntry[] };
  return data.entries;
}

async function saveEntry(project: string, key: string, value: string): Promise<MemoryEntry> {
  const res = await fetch(`/api/memory/${encodeURIComponent(project)}/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) throw new Error(`save failed: ${res.status}`);
  const data = (await res.json()) as { entry: MemoryEntry };
  return data.entry;
}

async function deleteEntry(project: string, key: string): Promise<void> {
  const res = await fetch(`/api/memory/${encodeURIComponent(project)}/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`delete failed: ${res.status}`);
}

export function MemoryView() {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<{ project: string; key: string } | null>(null);
  const [editing, setEditing] = useState<{ project: string; key: string; value: string; isNew: boolean } | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const all = await fetchEntries();
      setEntries(all);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.project.toLowerCase().includes(q) ||
        e.key.toLowerCase().includes(q) ||
        e.value.toLowerCase().includes(q)
    );
  }, [entries, filter]);

  const grouped = useMemo(() => {
    const map = new Map<string, MemoryEntry[]>();
    for (const e of filtered) {
      if (!map.has(e.project)) map.set(e.project, []);
      map.get(e.project)!.push(e);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const selectedEntry = entries.find((e) => selected && e.project === selected.project && e.key === selected.key);

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.project.trim() || !editing.key.trim()) {
      setError("project and key are required");
      return;
    }
    try {
      await saveEntry(editing.project.trim(), editing.key.trim(), editing.value);
      setEditing(null);
      setSelected({ project: editing.project.trim(), key: editing.key.trim() });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (project: string, key: string) => {
    if (!confirm(`Delete [${project}] ${key}?`)) return;
    try {
      await deleteEntry(project, key);
      if (selected && selected.project === project && selected.key === key) setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <h2 className="title">Memory</h2>
      <p className="subtitle">Shared key-value store across all AIs, scoped by project.</p>

      <div className="toolbar">
        <input
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ maxWidth: 300 }}
        />
        <button onClick={() => setEditing({ project: "global", key: "", value: "", isNew: true })}>
          + New entry
        </button>
        <button onClick={load} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 1fr) 2fr", gap: 16, marginTop: 16 }}>
        <div className="card" style={{ maxHeight: "70vh", overflowY: "auto" }}>
          {grouped.length === 0 && <div className="muted">No entries.</div>}
          {grouped.map(([project, list]) => (
            <div key={project} style={{ marginBottom: 16 }}>
              <div className="tag" style={{ marginBottom: 8 }}>{project} · {list.length}</div>
              {list.map((e) => (
                <button
                  key={e.project + "::" + e.key}
                  className={"list-row" + (selected && selected.project === e.project && selected.key === e.key ? " active" : "")}
                  style={{ width: "100%", border: "none", textAlign: "left", color: "var(--text)", background: "transparent" }}
                  onClick={() => { setSelected({ project: e.project, key: e.key }); setEditing(null); }}
                >
                  <div>
                    <div>{e.key}</div>
                    <div className="muted tiny">{e.value.slice(0, 80)}{e.value.length > 80 ? "…" : ""}</div>
                  </div>
                  <div className="muted tiny">{e.updated_at.split("T")[0]}</div>
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="card">
          {editing ? (
            <div className="column">
              <div>
                <div className="muted tiny">Project</div>
                <input value={editing.project} onChange={(e) => setEditing({ ...editing, project: e.target.value })} disabled={!editing.isNew} />
              </div>
              <div>
                <div className="muted tiny">Key</div>
                <input value={editing.key} onChange={(e) => setEditing({ ...editing, key: e.target.value })} disabled={!editing.isNew} />
              </div>
              <div>
                <div className="muted tiny">Value</div>
                <textarea
                  value={editing.value}
                  onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                  rows={16}
                />
              </div>
              <div className="row">
                <button className="primary" onClick={handleSave}>Save</button>
                <button onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          ) : selectedEntry ? (
            <div className="column">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <div className="tag">{selectedEntry.project}</div>
                  <h3 style={{ margin: "8px 0" }}>{selectedEntry.key}</h3>
                  <div className="muted tiny">
                    Updated {selectedEntry.updated_at}
                    {selectedEntry.source ? ` · by ${selectedEntry.source}` : ""}
                  </div>
                </div>
                <div className="row">
                  <button onClick={() => setEditing({ project: selectedEntry.project, key: selectedEntry.key, value: selectedEntry.value, isNew: false })}>Edit</button>
                  <button onClick={() => handleDelete(selectedEntry.project, selectedEntry.key)}>Delete</button>
                </div>
              </div>
              <pre>{selectedEntry.value}</pre>
            </div>
          ) : (
            <div className="muted">Select an entry, or create a new one.</div>
          )}
        </div>
      </div>
    </div>
  );
}
