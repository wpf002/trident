import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ─── Types (mirror @trident/builder shapes; the API is the source of truth) ──

interface BuildSummary {
  id: string;
  spec_path: string;
  source_repo: string;
  status: string;
  cost_usd: number;
  tasks_total: number;
  tasks_done: number;
  started_at: string;
  finished_at: string | null;
}

interface Task {
  id: string;
  build_id: string;
  parent_id: string | null;
  kind: "milestone" | "task" | "step";
  ordinal: number;
  intent: string;
  expected_files: string[];
  verification: unknown;
  status: string;
  attempts: number;
  max_attempts: number;
  last_evaluation: {
    verdict: "pass" | "fail" | "partial";
    confidence: number;
    reason: string;
  } | null;
}

interface BuildDetail {
  build: {
    id: string;
    spec_path: string;
    source_repo: string;
    base_branch: string;
    builder_branch: string;
    workspace_path: string;
    status: string;
    cost_usd: number;
    started_at: string;
    finished_at: string | null;
  };
  tasks: Task[];
}

interface BuildEvent {
  id: number;
  build_id: string;
  task_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  session_id: string | null;
  created_at: string;
}

// ─── Top-level ────────────────────────────────────────────────────────────

export function BuildsView({ active }: { active: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);

  if (selected) {
    return (
      <BuildDetailView
        buildId={selected}
        onBack={() => setSelected(null)}
        active={active}
      />
    );
  }
  return <BuildsList onOpen={setSelected} active={active} />;
}

// ─── List ─────────────────────────────────────────────────────────────────

interface BuilderConfig {
  default_source_repo: string | null;
  default_base_branch: string;
  anthropic_configured: boolean;
  has_github_token: boolean;
}

function BuildsList({
  onOpen,
  active,
}: {
  onOpen: (id: string) => void;
  active: boolean;
}) {
  const [builds, setBuilds] = useState<BuildSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [specText, setSpecText] = useState("");
  const [sourceRepo, setSourceRepo] = useState("");
  const [config, setConfig] = useState<BuilderConfig | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/builds");
      const data = (await r.json()) as { builds: BuildSummary[] };
      setBuilds(data.builds);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch the builder server config once — tells us whether a default
  // source repo is pinned (Railway case) and whether the API key is set.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/builds/config");
        if (!r.ok) return;
        const data = (await r.json()) as BuilderConfig;
        if (cancelled) return;
        setConfig(data);
        if (data.default_source_repo && !sourceRepo) {
          setSourceRepo(data.default_source_repo);
        }
      } catch {
        // ignore — UI still works, user enters repo manually
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [active, refresh]);

  const handleCreate = async () => {
    if (!specText.trim() || !sourceRepo.trim()) return;
    setCreating(true);
    try {
      const r = await fetch("/api/builds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec_text: specText, source_repo: sourceRepo }),
      });
      const data = (await r.json()) as { id?: string; error?: string };
      if (data.id) {
        onOpen(data.id);
        setSpecText("");
      } else {
        alert(data.error ?? "failed to start build");
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="builds-page">
      <header className="builds-header">
        <h1>Builds</h1>
        <button className="btn" onClick={() => void refresh()} disabled={loading}>
          {loading ? "…" : "Refresh"}
        </button>
      </header>

      {config && !config.anthropic_configured && (
        <div className="builds-banner">
          <strong>ANTHROPIC_API_KEY is not set on this server.</strong> Builds
          will fail to start until it's configured.
        </div>
      )}

      <section className="builds-new builds-new-stacked">
        <textarea
          className="builds-input builds-spec-area"
          placeholder="Spec — describe what you want built (markdown OK)"
          rows={6}
          value={specText}
          onChange={(e) => setSpecText(e.target.value)}
        />
        <input
          className="builds-input"
          placeholder={
            config?.default_source_repo
              ? `Source repo (default: ${config.default_source_repo})`
              : "Source repo (local path or git URL)"
          }
          value={sourceRepo}
          onChange={(e) => setSourceRepo(e.target.value)}
        />
        <button
          className="btn btn-primary"
          onClick={() => void handleCreate()}
          disabled={creating || !specText.trim() || !sourceRepo.trim()}
        >
          {creating ? "Starting…" : "Start Build"}
        </button>
      </section>

      {builds.length === 0 ? (
        <div className="builds-empty">No builds yet.</div>
      ) : (
        <table className="builds-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>ID</th>
              <th>Spec</th>
              <th>Progress</th>
              <th>Cost</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {builds.map((b) => (
              <tr
                key={b.id}
                className="builds-row"
                onClick={() => onOpen(b.id)}
              >
                <td>
                  <StatusChip status={b.status} />
                </td>
                <td className="mono">{b.id}</td>
                <td className="truncate">{b.spec_path}</td>
                <td>
                  {b.tasks_done}/{b.tasks_total}
                </td>
                <td>${b.cost_usd.toFixed(2)}</td>
                <td>{relativeTime(b.started_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Detail ───────────────────────────────────────────────────────────────

function BuildDetailView({
  buildId,
  onBack,
  active,
}: {
  buildId: string;
  onBack: () => void;
  active: boolean;
}) {
  const [detail, setDetail] = useState<BuildDetail | null>(null);
  const [events, setEvents] = useState<BuildEvent[]>([]);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");

  const refreshDetail = useCallback(async () => {
    const r = await fetch(`/api/builds/${buildId}`);
    if (!r.ok) return;
    const data = (await r.json()) as BuildDetail;
    setDetail(data);
    if (!selectedTask && data.tasks.length) {
      const running = data.tasks.find((t) => t.status === "running");
      setSelectedTask(running?.id ?? data.tasks[0].id);
    }
  }, [buildId, selectedTask]);

  const refreshDiff = useCallback(async () => {
    const r = await fetch(`/api/builds/${buildId}/diff`);
    if (r.ok) setDiff(await r.text());
  }, [buildId]);

  // Initial snapshot + diff
  useEffect(() => {
    if (!active) return;
    void refreshDetail();
    void refreshDiff();
  }, [active, refreshDetail, refreshDiff]);

  // SSE subscription
  useEffect(() => {
    if (!active) return;
    const es = new EventSource(`/api/builds/${buildId}/stream`);
    const append = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as BuildEvent;
        setEvents((prev) => [...prev.slice(-499), data]);
        if (
          data.kind === "tool_result" ||
          data.kind === "task_done" ||
          data.kind === "task_failed"
        ) {
          void refreshDiff();
        }
        if (
          data.kind === "task_started" ||
          data.kind === "task_done" ||
          data.kind === "task_failed" ||
          data.kind === "plan_generated" ||
          data.kind === "build_terminated"
        ) {
          void refreshDetail();
        }
      } catch {
        // ignore
      }
    };
    const kinds = [
      "build_started",
      "plan_generated",
      "plan_revised",
      "task_started",
      "tool_called",
      "tool_result",
      "step_evaluated",
      "task_done",
      "task_failed",
      "escalation_triggered",
      "intervention_requested",
      "human_action",
      "build_terminated",
    ];
    for (const k of kinds) es.addEventListener(k, append);
    return () => {
      for (const k of kinds) es.removeEventListener(k, append);
      es.close();
    };
  }, [buildId, active, refreshDetail, refreshDiff]);

  const control = async (action: "pause" | "resume" | "abort") => {
    await fetch(`/api/builds/${buildId}/${action}`, { method: "POST" });
    void refreshDetail();
  };

  if (!detail) {
    return (
      <div className="builds-page">
        <header className="builds-header">
          <button className="btn" onClick={onBack}>
            ← Builds
          </button>
        </header>
        <div className="builds-empty">Loading…</div>
      </div>
    );
  }

  const activeTask = detail.tasks.find((t) => t.id === selectedTask) ?? null;

  return (
    <div className="build-detail">
      <header className="builds-header">
        <button className="btn" onClick={onBack}>
          ← Builds
        </button>
        <div className="build-header-info">
          <span className="mono">{detail.build.id}</span>
          <StatusChip status={detail.build.status} />
          <span className="dim">${detail.build.cost_usd.toFixed(4)}</span>
          <span className="dim">{relativeTime(detail.build.started_at)}</span>
        </div>
        <div className="build-header-actions">
          {detail.build.status === "running" && (
            <button className="btn" onClick={() => void control("pause")}>
              Pause
            </button>
          )}
          {detail.build.status === "paused" && (
            <button className="btn" onClick={() => void control("resume")}>
              Resume
            </button>
          )}
          {!["done", "failed", "aborted"].includes(detail.build.status) && (
            <button className="btn btn-warn" onClick={() => void control("abort")}>
              Abort
            </button>
          )}
        </div>
      </header>

      <div className="build-grid">
        <div className="pane pane-plan">
          <h3>Plan</h3>
          <PlanTreePane
            tasks={detail.tasks}
            selectedId={selectedTask}
            onSelect={setSelectedTask}
          />
        </div>
        <div className="pane pane-active">
          <h3>Active Step</h3>
          <ActiveStepPane task={activeTask} />
        </div>
        <div className="pane pane-diff">
          <h3>Diff</h3>
          <pre className="diff-view">{diff || "(no diff yet)"}</pre>
        </div>
        <div className="pane pane-log">
          <h3>Log</h3>
          <LiveLogPane events={events} />
        </div>
      </div>
    </div>
  );
}

// ─── Sub-panes ────────────────────────────────────────────────────────────

function PlanTreePane({
  tasks,
  selectedId,
  onSelect,
}: {
  tasks: Task[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  // Build nested view from flat tasks.
  type NestedTask = Task & { children: NestedTask[] };
  const tree = useMemo<NestedTask[]>(() => {
    const map = new Map<string, NestedTask>();
    for (const t of tasks) map.set(t.id, { ...t, children: [] });
    const roots: NestedTask[] = [];
    for (const t of tasks) {
      const node = map.get(t.id)!;
      if (t.parent_id && map.has(t.parent_id)) {
        map.get(t.parent_id)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }, [tasks]);

  function renderNode(
    n: NestedTask,
    depth: number
  ): React.ReactNode {
    return (
      <div key={n.id}>
        <div
          className={
            "plan-node" + (n.id === selectedId ? " plan-node-selected" : "")
          }
          style={{ paddingLeft: depth * 16 + 8 }}
          onClick={() => onSelect(n.id)}
        >
          <span className="plan-icon">{taskGlyph(n.status)}</span>
          <span className="plan-intent">{n.intent}</span>
        </div>
        {n.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  }

  return <div className="plan-tree">{tree.map((n) => renderNode(n, 0))}</div>;
}

function ActiveStepPane({ task }: { task: Task | null }) {
  if (!task) return <div className="dim">No step selected.</div>;
  return (
    <div className="active-step">
      <div className="active-step-row">
        <span className="label">Intent</span>
        <span>{task.intent}</span>
      </div>
      <div className="active-step-row">
        <span className="label">Status</span>
        <StatusChip status={task.status} />
        <span className="dim">
          attempt {task.attempts} / {task.max_attempts}
        </span>
      </div>
      {task.expected_files.length > 0 && (
        <div className="active-step-row">
          <span className="label">Expected</span>
          <span className="mono dim">{task.expected_files.join(", ")}</span>
        </div>
      )}
      {task.verification ? (
        <div className="active-step-row">
          <span className="label">Verify</span>
          <code className="mono dim">{JSON.stringify(task.verification)}</code>
        </div>
      ) : null}
      {task.last_evaluation && (
        <div className="active-step-eval">
          <div>
            <strong>{task.last_evaluation.verdict}</strong>{" "}
            <span className="dim">
              (confidence {Math.round(task.last_evaluation.confidence * 100)}%)
            </span>
          </div>
          <div className="dim">{task.last_evaluation.reason}</div>
        </div>
      )}
    </div>
  );
}

function LiveLogPane({ events }: { events: BuildEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [events]);
  return (
    <div ref={ref} className="live-log">
      {events.map((ev) => (
        <div key={ev.id} className="log-row">
          <span className="log-time">{shortTime(ev.created_at)}</span>
          <span className={"log-kind log-kind-" + ev.kind}>{ev.kind}</span>
          <span className="log-payload">{formatPayload(ev)}</span>
        </div>
      ))}
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: string }) {
  return <span className={"chip chip-" + status}>{status}</span>;
}

function taskGlyph(status: string): string {
  switch (status) {
    case "done":
      return "✓";
    case "failed":
      return "✗";
    case "running":
      return "▶";
    case "ready":
      return "○";
    case "skipped":
      return "·";
    default:
      return "○";
  }
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString();
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function formatPayload(ev: BuildEvent): string {
  switch (ev.kind) {
    case "tool_called":
    case "tool_result":
      return String(ev.payload.name ?? "");
    case "task_started":
      return String(ev.payload.intent ?? "");
    case "step_evaluated":
      return `${ev.payload.verdict} attempt=${ev.payload.attempt}`;
    case "plan_generated":
      return `steps=${ev.payload.steps ?? ""}`;
    case "build_terminated":
      return String(ev.payload.reason ?? "");
    default:
      return JSON.stringify(ev.payload).slice(0, 120);
  }
}
