import { useEffect, useRef, useState } from "react";
import { SessionsView } from "./components/SessionsView.js";
import { QueryView } from "./components/QueryView.js";
import { SettingsView } from "./components/SettingsView.js";
import { Brand } from "./components/Brand.js";
import {
  fetchAuthStatus,
  getToken,
  setToken,
  clearToken,
  validateToken,
} from "./lib/api.js";

type Tab = "query" | "sessions" | "settings";
type AuthState = "checking" | "open" | "locked" | "unlocked";

function TokenGate({ onUnlock }: { onUnlock: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await validateToken(token);
      if (!ok) {
        setError("That token was rejected. Check it and try again.");
        return;
      }
      setToken(token);
      onUnlock();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-gate">
      <form className="card auth-card" onSubmit={submit}>
        <Brand />
        <div className="label" style={{ marginTop: 18 }}>
          Access token
        </div>
        <input
          type="password"
          autoFocus
          placeholder="Enter your Trident API token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
        <button className="primary" type="submit" disabled={busy} style={{ marginTop: 14 }}>
          {busy ? "Checking…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("query");
  const mainRef = useRef<HTMLElement>(null);
  const [auth, setAuth] = useState<AuthState>("checking");

  // Determine whether the server requires a token, and whether the stored one
  // is still valid, before rendering the app shell.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { authRequired } = await fetchAuthStatus();
      if (cancelled) return;
      if (!authRequired) {
        setAuth("open");
        return;
      }
      const stored = getToken();
      if (stored && (await validateToken(stored))) {
        if (!cancelled) setAuth("unlocked");
      } else {
        clearToken();
        if (!cancelled) setAuth("locked");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (auth === "checking") {
    return (
      <div className="auth-gate">
        <span className="spinner" />
      </div>
    );
  }

  if (auth === "locked") {
    return <TokenGate onUnlock={() => setAuth("unlocked")} />;
  }

  const showLock = auth === "unlocked";

  // Views stay mounted (see below), so the scroll container keeps the previous
  // tab's offset when switching. Reset it so a tab always opens at the top.
  const goToTab = (next: Tab) => {
    setTab(next);
    mainRef.current?.scrollTo({ top: 0 });
  };

  // All views stay mounted; we toggle visibility with `view-hidden` so
  // in-progress state (streaming runs, form values) survives tab switches.
  return (
    <div className="app">
      <aside className="sidebar">
        <Brand />
        <button
          className={"nav-item" + (tab === "query" ? " active" : "")}
          onClick={() => goToTab("query")}
        >
          Chat
        </button>
        <button
          className={"nav-item" + (tab === "sessions" ? " active" : "")}
          onClick={() => goToTab("sessions")}
        >
          History
        </button>
        <button
          className={"nav-item" + (tab === "settings" ? " active" : "")}
          onClick={() => goToTab("settings")}
        >
          Settings
        </button>
        {showLock && (
          <button
            className="nav-item sign-out"
            onClick={() => {
              clearToken();
              setAuth("locked");
            }}
          >
            Sign Out
          </button>
        )}
      </aside>
      <main className="main" ref={mainRef}>
        <div className={"view" + (tab !== "query" ? " view-hidden" : "")}>
          <QueryView />
        </div>
        <div className={"view" + (tab !== "sessions" ? " view-hidden" : "")}>
          <SessionsView active={tab === "sessions"} />
        </div>
        <div className={"view" + (tab !== "settings" ? " view-hidden" : "")}>
          <SettingsView active={tab === "settings"} />
        </div>
      </main>
    </div>
  );
}
