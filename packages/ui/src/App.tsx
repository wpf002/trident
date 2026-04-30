import { useState } from "react";
import { SessionsView } from "./components/SessionsView.js";
import { QueryView } from "./components/QueryView.js";
import { Brand } from "./components/Brand.js";

type Tab = "query" | "sessions";

export function App() {
  const [tab, setTab] = useState<Tab>("query");

  // Both views stay mounted; we toggle visibility with `view-hidden` so
  // QueryView state (in-flight runs, form values) survives tab switches.
  return (
    <div className="app">
      <aside className="sidebar">
        <Brand />
        <button
          className={"nav-item" + (tab === "query" ? " active" : "")}
          onClick={() => setTab("query")}
        >
          Query
        </button>
        <button
          className={"nav-item" + (tab === "sessions" ? " active" : "")}
          onClick={() => setTab("sessions")}
        >
          Sessions
        </button>
        <div className="sidebar-footer">v1.0 · localhost:4242</div>
      </aside>
      <main className="main">
        <div className={"view" + (tab !== "query" ? " view-hidden" : "")}>
          <QueryView />
        </div>
        <div className={"view" + (tab !== "sessions" ? " view-hidden" : "")}>
          <SessionsView />
        </div>
      </main>
    </div>
  );
}
