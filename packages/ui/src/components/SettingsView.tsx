import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";

type KeySource = "settings" | "environment" | "none";

interface KeyStatus {
  id: string;
  label: string;
  apiKeyEnv: string;
  source: KeySource;
  masked: string | null;
  updatedAt: string | null;
  builtIn: boolean;
}

interface StoreInfo {
  path: string;
  exists: boolean;
  encrypted: boolean;
}

function sourceBadge(source: KeySource) {
  if (source === "settings") return <span className="key-badge saved">Saved here</span>;
  if (source === "environment") return <span className="key-badge env">From .env</span>;
  return <span className="key-badge none">Not set</span>;
}

function KeyRow({ k, onChanged }: { k: KeyStatus; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/keys/${encodeURIComponent(k.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `save failed (${res.status})`);
      setValue("");
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Remove the ${k.label} key saved here?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/keys/${encodeURIComponent(k.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`delete failed (${res.status})`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="key-row">
      <div className="key-row-head">
        <div className="row" style={{ gap: 10 }}>
          <span className={"tag " + k.id}>{k.label}</span>
          {sourceBadge(k.source)}
        </div>
        <code className="key-mask">{k.masked ?? "—"}</code>
      </div>

      <div className="muted tiny">
        Environment variable: <code>{k.apiKeyEnv}</code>
        {k.updatedAt && ` · saved ${new Date(k.updatedAt).toLocaleDateString()}`}
      </div>

      {editing ? (
        <div className="column" style={{ gap: 8 }}>
          <input
            type="password"
            autoComplete="off"
            placeholder={`Paste your ${k.label} API key`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
          <div className="row" style={{ gap: 8 }}>
            <button className="primary" onClick={save} disabled={busy || !value.trim()}>
              {busy ? "Saving…" : "Save Key"}
            </button>
            <button
              className="secondary"
              onClick={() => {
                setEditing(false);
                setValue("");
                setError(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ gap: 8 }}>
          <button className="secondary" onClick={() => setEditing(true)} disabled={busy}>
            {k.source === "none" ? "Add Key" : "Replace Key"}
          </button>
          {k.source === "settings" && (
            <button className="secondary danger" onClick={remove} disabled={busy}>
              Delete
            </button>
          )}
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {k.source === "settings" && (
        <div className="muted tiny">This overrides <code>{k.apiKeyEnv}</code> from .env. Deleting it falls back to that value.</div>
      )}
    </div>
  );
}

export function SettingsView({ active = true }: { active?: boolean }) {
  const [keys, setKeys] = useState<KeyStatus[]>([]);
  const [store, setStore] = useState<StoreInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/keys");
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const data = (await res.json()) as { keys: KeyStatus[]; store: StoreInfo };
      setKeys(data.keys ?? []);
      setStore(data.store ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (active) load();
  }, [active]);

  const configured = keys.filter((k) => k.source !== "none").length;

  return (
    <div>
      <header className="page-header">
        <h2 className="page-title">Settings</h2>
        <p className="page-subtitle">
          Your API keys. Trident calls each provider directly with your key — nothing is proxied.
        </p>
        <div className="divider" />
      </header>

      {error && (
        <div className="error" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div className="card column">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="label" style={{ margin: 0 }}>
            API Keys
          </span>
          <span className="muted tiny">
            {loading ? "Loading…" : `${configured} of ${keys.length} configured`}
          </span>
        </div>

        <div className="muted tiny">
          Keys are stored on your own server, never sent anywhere except the provider they belong to.
          Only a masked preview is ever shown.
          {store && (
            <>
              {" "}
              {store.encrypted ? (
                <span style={{ color: "var(--green)" }}>Encrypted at rest.</span>
              ) : (
                <span style={{ color: "var(--yellow)" }}>
                  Stored with owner-only permissions — set <code>TRIDENT_TOKEN_KEY</code> to also encrypt at rest.
                </span>
              )}
            </>
          )}
        </div>

        <div className="divider" />

        {keys.length === 0 && !loading ? (
          <div className="pane-empty">No providers configured.</div>
        ) : (
          <div className="column" style={{ gap: 14 }}>
            {keys.map((k) => (
              <KeyRow key={k.id} k={k} onChanged={load} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
