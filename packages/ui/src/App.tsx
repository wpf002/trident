import { useState } from "react";
import { SessionsView } from "./components/SessionsView.js";
import { QueryView } from "./components/QueryView.js";
import { ImageView } from "./components/ImageView.js";
import { BuildsView } from "./components/BuildsView.js";
import { Brand } from "./components/Brand.js";

type Tab = "query" | "image" | "builds" | "sessions";

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
          className={"nav-item" + (tab === "image" ? " active" : "")}
          onClick={() => setTab("image")}
        >
          Image
        </button>
        <button
          className={"nav-item" + (tab === "builds" ? " active" : "")}
          onClick={() => setTab("builds")}
        >
          Builds
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
        <div className={"view" + (tab !== "image" ? " view-hidden" : "")}>
          <ImageView />
        </div>
        <div className={"view" + (tab !== "builds" ? " view-hidden" : "")}>
          <BuildsView active={tab === "builds"} />
        </div>
        <div className={"view" + (tab !== "sessions" ? " view-hidden" : "")}>
          <SessionsView active={tab === "sessions"} />
        </div>
      </main>
    </div>
  );
}
