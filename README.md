# Trident

Multi-AI orchestration layer. Connects Claude, ChatGPT, and Perplexity to a single MCP server — shared docs, shared tools, parallel and chained query modes, a web dashboard, scheduled jobs, synthesis/scoring, and an autonomous coding agent.

---

## What It Does

| Feature | Description |
| --- | --- |
| **Shared Docs** | Drop files in `data/docs/` — all AIs can read them via MCP |
| **Web Search** | Tavily integration exposed as an MCP tool |
| **Perplexity MCP tool** | Claude/ChatGPT can call `perplexity_search` for live, cited answers |
| **Google Workspace tools** | `gmail_search`, `gdrive_search`, `gcal_upcoming` over OAuth |
| **External APIs** | Allowlisted API fetcher (news, finance, weather, etc.) |
| **Parallel Mode** | Fire one prompt at all three AIs, compare side-by-side |
| **Chain Mode** | Output of AI #1 → input to AI #2 → input to AI #3 |
| **Chain Presets** | `draft-refine-verify`, `research-analyze-summarize`, `attack-defend-judge`, `research-ideate-build` |
| **Routing Config** | `trident.config.json` defines named routes (`--mode research`) |
| **Markdown Output** | `--output path.md` writes a formatted run transcript |
| **Diff Synthesis** | `--diff` adds Claude-led agreement/disagreement/conflict analysis |
| **Confidence Scoring** | `--score` adds per-AI confidence and consensus levels |
| **Session Replay** | Every parallel/chain run is logged; `trident sessions` lists & replays |
| **Web UI** | Dark dashboard at `http://localhost:4242` — query interface with live streaming, session history, build dashboard |
| **Scheduler** | `schedules.json` + node-cron run chains on a schedule |
| **Route Detection** | `trident route detect <prompt>` asks Claude which mode fits |
| **Builder Module** | Autonomous coding agent — give it a spec, it plans, scaffolds, writes, tests, and commits inside a sandboxed worktree |

---

## Requirements

- Node.js 18+
- npm 8+
- API keys: Anthropic, OpenAI, Perplexity, Tavily (optional but recommended)

---

## Setup

### 1. Clone and bootstrap

```bash
git clone https://github.com/YOUR_USERNAME/trident.git
cd trident
cp .env.example .env
# Fill in your API keys in .env
bash bootstrap.sh
```

`bootstrap.sh` installs dependencies, builds all workspace packages in dependency order, links the `trident` CLI globally, and creates default `trident.config.json` and `schedules.json` files.

### 2. Connect the MCP server to Claude

Add to your Claude desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on Mac):

```json
{
  "mcpServers": {
    "trident": {
      "command": "node",
      "args": ["/absolute/path/to/trident/packages/mcp-server/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop. You'll see Trident tools available in Claude.

### 3. Connect to ChatGPT

In ChatGPT Desktop → Settings → Extensions → Add MCP Server:

- Name: `Trident`
- Command: `node /absolute/path/to/trident/packages/mcp-server/dist/index.js`

---

## CLI Usage

### Status

```bash
trident status                                  # check API keys
trident google status                           # check Google OAuth setup
```

### Parallel mode

```bash
trident parallel "What are the tradeoffs between RAG and fine-tuning?"
trident parallel "Summarize this topic" --ais claude,gpt
trident parallel "Compare these frameworks" --diff --score
trident parallel "Plan the BHIS migration" --output runs/bhis.md
```

### Chain mode

```bash
trident chain "Write an overview of MCP architecture" --preset draft-refine-verify
trident chain "How should I build X?" --preset research-ideate-build  # research → creative → realistic plan
trident chain "Is Rust worth learning in 2025?" --order perplexity,claude,gpt
trident chain "Summarize this topic" --mode summarize         # uses trident.config.json
trident chain "Audit this proposal" --show-intermediate
```

### Model tiers (cost vs quality)

By default Trident uses the **main** tier — Sonnet 4.6 / GPT-4o-mini / sonar-pro — strong quality at low cost. Internal calls (route detection, synthesis, scoring) automatically use the cheaper **utility** tier (Haiku 4.5 / GPT-4o-mini / sonar). Override per-call:

```bash
trident parallel "..." --premium     # Opus 4.7 / GPT-4o / sonar-reasoning (~10× cost)
trident parallel "..." --fast        # Utility tier everywhere (cheapest)
trident chain "..."  --premium       # Same flags work on chain
```

Or set defaults via env vars in `.env`:

```dotenv
TRIDENT_CLAUDE_MAIN_MODEL=claude-sonnet-4-6
TRIDENT_GPT_MAIN_MODEL=gpt-4o-mini
TRIDENT_PERPLEXITY_MAIN_MODEL=sonar-pro
# (also _PREMIUM_MODEL and _UTILITY_MODEL variants per provider)
```

### Session replay

```bash
trident sessions                                # list recent runs
trident sessions list --mode chain --limit 20
trident sessions get <id>                       # reprint a past run
```

### Routing

```bash
trident route                                   # list configured modes
trident route detect "Find the latest news on quantum computing breakthroughs"
```

### Web UI

```bash
trident ui                                      # http://localhost:4242
trident ui --port 5000
```

The UI has two views:

- **Query** — type a prompt, choose parallel/chain/preset/AIs, results stream in via SSE
- **Sessions** — list past runs, click to view full output

### Scheduler

```bash
trident schedule                                # list schedules + last-run status
trident schedule run <id>                       # run a schedule once now
trident schedule daemon                         # start the cron loop (runs forever)
```

### Google Workspace

One-time setup:

```bash
# 1. Get OAuth credentials from Google Cloud Console:
#    - Go to https://console.cloud.google.com/apis/credentials
#    - Create OAuth 2.0 Client ID, type: "Desktop app"
#    - Download the JSON, save as ./credentials.json at the repo root.
# 2. Enable Gmail, Drive, and Calendar APIs in the same project.
# 3. Authorize:
trident google login
```

That writes a token to `data/google-token.json` (gitignored). The MCP tools `gmail_search`, `gdrive_search`, and `gcal_upcoming` are now usable from Claude/ChatGPT.

---

## Builder Module

Autonomous coding agent built on top of Trident's AI router. Hand it a spec, it plans, writes, tests, and commits — inside a sandboxed git worktree so it can't touch the host repo.

### How it works

```text
spec → ingest → plan (Opus) → decompose → execute (Sonnet) → evaluate (Haiku)
                                                ↓
                                       pass? → next step
                                       fail? → refine → escalate → human
                                                ↓
                                            commit
```

| Phase | Model tier | Why |
| --- | --- | --- |
| Ingest | utility | Cheap structured extraction from the spec |
| Plan | **premium** | Plan quality compounds — one Opus call saves dozens of retries |
| Execute (codegen) | main | Sonnet is the workhorse for the hot loop |
| Evaluate | utility | Pass/fail/confidence is the same shape as `--score` |
| Cross-check eval | utility (GPT) | Second opinion on contested verdicts |
| Commit message | utility | GPT-4o-mini writes good messages cheaply |

All overridable via `TRIDENT_*_MODEL` env vars. `--premium` and `--fast` flags shift the whole table up or down a tier — same UX as parallel/chain.

### CLI usage

```bash
trident build path/to/spec.md                    # build in current repo
trident build spec.md --repo ../other-project    # target a different repo
trident build spec.md --premium                  # bump all tiers up
trident build spec.md --fast                     # cheapest possible run
trident build list                               # all builds + status
trident build status <id>                        # detail for one build
trident build resume <id>                        # continue a paused build
trident build abort <id>                         # stop a running build
```

### Sandbox

Every build runs inside an ephemeral git worktree at `data/builds/<build_id>/workspace/`, on its own branch `builder/<build_id>`. The agent never touches your working tree. Final commit lives on that branch — you decide whether to merge it.

Worktree is the v1 sandbox. Docker is wired behind the same interface for v2 (`TRIDENT_BUILDER_SANDBOX=docker`).

### Tool layer

The builder uses the existing MCP tool surface plus new ones added for code work:

| Tool | Purpose |
| --- | --- |
| `project_list`, `project_read`, `project_write`, `project_edit`, `project_search` | Workspace-scoped filesystem |
| `shell_exec` | Run a command inside the sandbox (timeout-bounded, no host secrets) |
| `git_status`, `git_diff`, `git_branch`, `git_commit`, `git_log` | Git inside the worktree (no push — that's a human action) |
| `pkg_install`, `pkg_run` | Detects npm/pnpm/yarn/cargo/pip and dispatches |
| `test_run`, `typecheck`, `lint` | Verification — returns structured pass/fail counts |
| `browser_*` | Headless Chromium for UI builds (v2) |

These tools are also available to Claude Desktop and ChatGPT via the MCP server — one tool surface, multiple consumers.

### Build dashboard

Open `http://localhost:4242` and click **Builds**. The detail view is a four-pane layout:

- **Plan tree** (left) — live status per step
- **Active step** (top-right) — current intent, evaluation, redirect / skip / approve controls
- **Diff** (bottom-left) — live `git diff` against base, file by file
- **Log** (bottom-right) — every event (tool call, eval, escalation) with timestamps

Header controls: **Pause**, **Abort**, **Commit**. Push is one click deeper — never accidental.

### Guardrails

| Guardrail | Default | Triggers |
| --- | --- | --- |
| Cost ceiling | `$5.00` per build | Pause + prompt user to raise |
| Wall-clock ceiling | `60 min` | Pause |
| Per-step cost warn | `$0.50` | UI banner |
| Loop detector | Jaccard > 0.7 on 3 consecutive failures | Force early escalation |
| Max retries per step | 3 | Escalate to Opus re-plan |
| Destructive command denylist | `rm -rf /`, `git push -f`, etc. | Refused at runtime, surfaced to human |

Override per-build at creation time, or set defaults in `trident.config.json`:

```json
{
  "builder": {
    "defaults": {
      "ceilings": { "cost_usd_max": 5.00, "wall_clock_max_min": 60 },
      "escalation": { "max_attempts": 3, "auto_escalate_to_premium": true }
    }
  }
}
```

### State & resume

Every build persists to `data/trident.db` in three new tables (`builds`, `build_tasks`, `build_events`), alongside the existing `session_runs`. Every LLM call the builder makes shows up in `trident sessions` filtered by `--project <build_id>` — so the existing session replay works on builder calls for free.

`trident build resume <id>` rehydrates plan + state from SQLite and picks up at the next ready step. The build branch in the worktree is the source of truth for "what's been built" — completed steps are not re-run.

### Build artifacts

```text
data/builds/<build_id>/
├── workspace/        # git worktree, branch builder/<build_id>
├── snapshots/        # git stash refs from sandbox snapshot()
├── logs/             # stdout/stderr per shell_exec
├── cache/            # working memory (tree.json, imports.json, memory.md)
└── manifest.json
```

Successful builds keep the worktree until you merge. Failed/aborted builds keep everything for debugging. `trident build gc` sweeps archived builds older than N days.

### Running on Railway (or any cloud)

Builder works in the deployed Trident instance too — the same dashboard at your Railway URL gets a working Builds tab.

Set these env vars on the Railway service:

| Var | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Required — Builder uses Claude for planning/coding/evaluation |
| `TRIDENT_BUILDER_DEFAULT_REPO` | Git URL the Builder targets (e.g. `https://github.com/you/repo.git`). Pre-fills the UI; omitting it forces the user to pass `source_repo` per build. |
| `TRIDENT_GITHUB_TOKEN` | Required for private repos; used to authenticate `git clone` |
| `TRIDENT_DATA_DIR` | Path inside the container that maps to a **persistent volume** — Builder writes builds, cloned repos, and SQLite here |
| `TRIDENT_BUILDER_GIT_USER_NAME` / `TRIDENT_BUILDER_GIT_USER_EMAIL` | Git committer identity for builds |
| `TRIDENT_BUILDER_DEFAULT_BASE_BRANCH` | Defaults to `main` |

Mount a Railway volume on the path set by `TRIDENT_DATA_DIR` (e.g. `/data`). Without persistence, every redeploy wipes build history and re-clones the repo from scratch.

The build pipeline ([nixpacks.toml](nixpacks.toml)) compiles `builder-runtime` and `builder` ahead of `ui-server`, so the Railway deploy includes the Builder without changes to your existing setup.

### Architecture

```text
packages/
├── builder/             # the agent loop, planner, coder, evaluator, state
├── builder-runtime/     # sandbox primitives (worktree v1, docker v2)
├── mcp-server/          # tools the builder uses (also exposed to Claude Desktop / ChatGPT)
├── ui-server/           # /api/builds/* routes + SSE event stream
├── ui/                  # /builds view
└── cli/                 # trident build commands
```

`builder` depends on `core` (AI clients, tiers) and `builder-runtime` (sandbox). It never spawns processes directly — only through the runtime interface. Swapping worktree for Docker doesn't touch the loop.

---

## Routing Config (`trident.config.json`)

```json
{
  "routing": {
    "research": ["perplexity", "claude", "gpt"],
    "code": ["claude", "gpt", "perplexity"],
    "summarize": ["gpt", "claude", "perplexity"],
    "default": ["claude", "gpt", "perplexity"]
  }
}
```

Use with `trident chain "..." --mode research`. Add your own modes — anything you put here is selectable.

---

## Schedules (`schedules.json`)

```json
[
  {
    "id": "morning-briefing",
    "cron": "0 7 * * *",
    "prompt": "Give me a briefing on AI news, cybersecurity threats, and market movements from the last 24 hours",
    "preset": "research-analyze-summarize",
    "output": "data/docs/briefings/daily.md"
  }
]
```

Per-schedule fields:

- `id` — unique identifier (used by `trident schedule run <id>`)
- `cron` — standard 5-field cron expression
- `prompt` — the chain's input
- `preset` *or* `order` — choose AI sequence
- `output` *(optional)* — file path (relative to repo root) for a markdown transcript
- `system` *(optional)* — global system prompt override

`trident schedule daemon` keeps a long-lived process running — pair with `pm2`, `systemd`, or `launchd` for production.

---

## Chain Presets

| Preset | Order | Use Case |
| --- | --- | --- |
| `draft-refine-verify` | Claude → GPT → Perplexity | Writing with live fact-check |
| `research-analyze-summarize` | Perplexity → Claude → GPT | Research to actionable summary |
| `attack-defend-judge` | GPT → Claude → Perplexity | Debate and verdict |
| `research-ideate-build` | Perplexity → GPT → Claude | Project planning: research the ground truth, ideate creatively, then build a realistic plan |

Add more in [`packages/core/src/presets.ts`](packages/core/src/presets.ts) — every package (CLI, scheduler, UI server) reads from there.

---

## Project Structure

```text
trident/
├── packages/
│   ├── core/                # Shared AI clients, chain presets, types (no I/O)
│   ├── mcp-server/          # MCP server (Claude + ChatGPT connect here)
│   │   └── src/
│   │       ├── index.ts     # Server entry point
│   │       ├── db/          # SQLite session store
│   │       ├── lib/google.ts
│   │       └── tools/       # search, files, api, perplexity, google
│   ├── cli/                 # Trident CLI
│   │   └── src/
│   │       ├── index.ts     # CLI entry point
│   │       ├── commands/    # parallel, chain, sessions, route, config, google
│   │       └── lib/         # db, output, synthesis, config, clients
│   ├── scheduler/           # node-cron based scheduled chains
│   ├── ui-server/           # Express + SSE API for the dashboard
│   └── ui/                  # React + Vite dashboard
├── data/
│   ├── docs/                # Drop files here — surfaced to MCP `read_file`/`list_files` tools
│   ├── trident.db           # Auto-created session store
│   ├── scheduler-state.json # Last-run state for each schedule (gitignored)
│   └── google-token.json    # OAuth token (gitignored)
├── trident.config.json      # Routing modes
├── schedules.json           # Scheduled chains
├── credentials.json         # Google OAuth client (gitignored — you provide)
├── .env                     # Your API keys (gitignored)
└── .env.example
```

---

## Extending

- **Add an external API domain:** edit [`packages/mcp-server/src/tools/api.ts`](packages/mcp-server/src/tools/api.ts) → add to `ALLOWED_DOMAINS`.
- **Add a chain preset:** edit `CHAIN_PRESETS` in [`packages/cli/src/commands/chain.ts`](packages/cli/src/commands/chain.ts) and [`packages/scheduler/src/index.ts`](packages/scheduler/src/index.ts).
- **Add a new MCP tool:** create a file in `packages/mcp-server/src/tools/`, register it in `src/index.ts`.
- **Add a routing mode:** edit `trident.config.json`.

---

## License

MIT
