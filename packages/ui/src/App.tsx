import { useState } from "react";
import { SessionsView } from "./components/SessionsView.js";
import { QueryView } from "./components/QueryView.js";
import { Brand } from "./components/Brand.js";

type Tab = "query" | "sessions";

export function App() {
  const [tab, setTab] = useState<Tab>("query");

  // All views stay mounted; we toggle visibility with `view-hidden` so
  // in-progress state (streaming runs, form values) survives tab switches.
  return (
    <div className="app">
      <aside className="sidebar">
        <Brand />
        <button
          className={"nav-item" + (tab === "query" ? " active" : "")}
          onClick={() => setTab("query")}
        >
          Chat
        </button>
        <button
          className={"nav-item" + (tab === "sessions" ? " active" : "")}
          onClick={() => setTab("sessions")}
        >
          History
        </button>
      </aside>
      <main className="main">
        <div className={"view" + (tab !== "query" ? " view-hidden" : "")}>
          <QueryView />
        </div>
        <div className={"view" + (tab !== "sessions" ? " view-hidden" : "")}>
          <SessionsView active={tab === "sessions"} />
        </div>
      </main>
    </div>
  );
}
