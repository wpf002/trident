import { useState } from "react";
import { MemoryView } from "./components/MemoryView.js";
import { SessionsView } from "./components/SessionsView.js";
import { QueryView } from "./components/QueryView.js";

type Tab = "query" | "memory" | "sessions";

export function App() {
  const [tab, setTab] = useState<Tab>("query");

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>
          <span className="accent">▲</span> Trident
        </h1>
        <button
          className={"nav-item" + (tab === "query" ? " active" : "")}
          onClick={() => setTab("query")}
        >
          Query
        </button>
        <button
          className={"nav-item" + (tab === "memory" ? " active" : "")}
          onClick={() => setTab("memory")}
        >
          Memory
        </button>
        <button
          className={"nav-item" + (tab === "sessions" ? " active" : "")}
          onClick={() => setTab("sessions")}
        >
          Sessions
        </button>
        <div style={{ flex: 1 }} />
        <div className="muted tiny" style={{ padding: "8px 12px" }}>
          Multi-AI orchestration
        </div>
      </aside>
      <main className="main">
        {tab === "query" && <QueryView />}
        {tab === "memory" && <MemoryView />}
        {tab === "sessions" && <SessionsView />}
      </main>
    </div>
  );
}
