# Trident

Multi-AI orchestration layer with shared context. Connects Claude, ChatGPT, and Perplexity to a single MCP server — shared memory, shared docs, shared tools, parallel and chained query modes, a web dashboard, scheduled jobs, file watcher, and synthesis/scoring.

---

## What It Does

| Feature | Description |
| --- | --- |
| **Shared Memory** | Any AI can read/write to a SQLite store scoped by project |
| **Shared Docs** | Drop files in `data/docs/` — all AIs can read them via MCP |
| **Web Search** | Tavily integration exposed as an MCP tool |
| **Perplexity MCP tool** | Claude/ChatGPT can call `perplexity_search` for live, cited answers |
| **Google Workspace tools** | `gmail_search`, `gdrive_search`, `gcal_upcoming` over OAuth |
| **External APIs** | Allowlisted API fetcher (news, finance, weather, etc.) |
| **Parallel Mode** | Fire one prompt at all three AIs, compare side-by-side |
| **Chain Mode** | Output of AI #1 → input to AI #2 → input to AI #3 |
| **Chain Presets** | `draft-refine-verify`, `research-analyze-summarize`, `attack-defend-judge` |
| **Routing Config** | `trident.config.json` defines named routes (`--mode research`) |
| **Project Context** | `--project foo` auto-injects all memory entries for that project |
| **Markdown Output** | `--output path.md` writes a formatted run transcript |
| **Diff Synthesis** | `--diff` adds Claude-led agreement/disagreement/conflict analysis |
| **Confidence Scoring** | `--score` adds per-AI confidence and consensus levels |
| **Session Replay** | Every parallel/chain run is logged; `trident sessions` lists & replays |
| **Web UI** | Dark dashboard at `http://localhost:4242` — memory browser, sessions, query interface with live streaming |
| **File Watcher** | `trident watch` extracts key facts from new/changed docs into memory |
| **Scheduler** | `schedules.json` + node-cron run chains on a schedule |
| **Route Detection** | `trident route detect <prompt>` asks Claude which mode fits |

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
trident parallel "Plan the BHIS migration" --project BHIS --output runs/bhis.md
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

By default Trident uses the **main** tier — Sonnet 4.6 / GPT-4o-mini / sonar-pro — strong quality at low cost. Internal calls (route detection, synthesis, scoring, watcher fact extraction) automatically use the cheaper **utility** tier (Haiku 4.5 / GPT-4o-mini / sonar). Override per-call:

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
trident sessions list --mode chain --project BHIS --limit 20
trident sessions get <id>                       # reprint a past run
```

### Memory

```bash
trident memory list
trident memory list --project BHIS
trident memory set project_goal "Build a church analytics dashboard" --project BHIS
trident memory get project_goal --project BHIS
trident memory delete project_goal --project BHIS
trident memory projects
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

The UI has three views:

- **Query** — type a prompt, choose parallel/chain/preset/AIs, results stream in via SSE
- **Memory** — browse, edit, create, delete entries (scoped by project)
- **Sessions** — list past runs, click to view full output

### File watcher

```bash
trident watch                                   # continuous — Ctrl+C to stop
trident watch --once                            # single pass and exit
```

The watcher reads new/changed files in `data/docs/`, sends each to Claude with a "extract 5–10 key facts" prompt, and writes the result to memory under the file's first subdirectory as the project namespace. Memory key format: `doc_facts:<rel_path>`.

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
    "output": "data/docs/briefings/daily.md",
    "memory_key": "last_briefing",
    "project": "global"
  }
]
```

Per-schedule fields:

- `id` — unique identifier (used by `trident schedule run <id>`)
- `cron` — standard 5-field cron expression
- `prompt` — the chain's input
- `preset` *or* `order` — choose AI sequence
- `output` *(optional)* — file path (relative to repo root) for a markdown transcript
- `memory_key` *(optional)* — key to write the final response to in memory
- `project` *(optional)* — project namespace for the memory write
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
│   │       ├── db/          # SQLite shared store
│   │       ├── lib/google.ts
│   │       └── tools/       # memory, search, files, api, perplexity, google
│   ├── cli/                 # Trident CLI
│   │   └── src/
│   │       ├── index.ts     # CLI entry point
│   │       ├── commands/    # parallel, chain, memory, sessions, route, google
│   │       └── lib/         # db, context, output, synthesis, config
│   ├── watcher/             # data/docs/ → memory indexer (chokidar)
│   ├── scheduler/           # node-cron based scheduled chains
│   ├── ui-server/           # Express + SSE API for the dashboard
│   └── ui/                  # React + Vite dashboard
├── data/
│   ├── docs/                # Drop project files here — all AIs can read
│   ├── trident.db           # Auto-created shared SQLite store
│   ├── watcher-state.json   # Watcher's per-file index state (gitignored)
│   ├── scheduler-state.json # Last-run state for each schedule (gitignored)
│   └── google-token.json    # OAuth token (gitignored)
├── trident.config.json      # Routing modes
├── schedules.json           # Scheduled chains
├── credentials.json         # Google OAuth client (gitignored — you provide)
├── .env                     # Your API keys (gitignored)
└── .env.example
```

---

## Adding Project Context

To make all AIs aware of a project:

```bash
# Option 1: Drop files in data/docs/<project>/
cp my-project-notes.md data/docs/my-project/notes.md
trident watch --once                            # auto-indexes facts into memory

# Option 2: Write key facts to shared memory directly
trident memory set architecture "React frontend, Node backend, PostgreSQL" --project my-project
trident memory set goals "Build X by Y" --project my-project

# Option 3: Inject into a query
trident parallel "How should we proceed?" --project my-project
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
