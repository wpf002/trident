# Trident

Multi-AI orchestration layer. Connects Claude, ChatGPT, and Perplexity to a single MCP server — shared docs, shared tools, parallel and chained query modes, a web dashboard, scheduled jobs, and synthesis/scoring.

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
| **Web UI** | Dark dashboard at `http://localhost:4242` — query interface with live streaming, session history |
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

That writes a token to `data/google-token.json` (gitignored, `0600`). The MCP tools `gmail_search`, `gdrive_search`, and `gcal_upcoming` are now usable from Claude/ChatGPT. The token grants **read-only** access to Gmail, Drive, and Calendar.

---

## Security & Deployment Hardening

The `ui-server` (the web UI's API) talks to your SQLite history and spends your paid LLM API keys. It is safe to run **bound to localhost** with no extra config, but **must be locked down before you expose it on a network** (e.g. Railway). Configure these via environment variables (see `.env.example`):

| Variable | Purpose | When to set |
|---|---|---|
| `TRIDENT_API_TOKEN` | Requires `Authorization: Bearer <token>` on every `/api` route; the UI shows a one-time token gate. | **Always, before any public/network deployment.** |
| `HOST` | Interface to bind. Defaults to `0.0.0.0`. | Set `127.0.0.1` if the server should only be reachable locally. |
| `TRIDENT_ALLOWED_ORIGINS` | Comma-separated CORS allowlist. Empty = block all cross-origin browser access. | Only if a browser on a **different** origin must call the API. |
| `TRIDENT_TOKEN_KEY` | Encrypts the Google OAuth token at rest with AES-256-GCM. Without it the token is plaintext but `0600`. | Recommended wherever the disk/backups aren't fully trusted. |

Generate strong values:

```bash
openssl rand -hex 32      # use for TRIDENT_API_TOKEN
openssl rand -hex 32      # use a different one for TRIDENT_TOKEN_KEY
```

**Deploying to Railway (or any public host):**

1. In the service **Variables**, set `TRIDENT_API_TOKEN` (required) and `TRIDENT_TOKEN_KEY` (recommended). Do **not** commit these.
2. Leave `HOST` at the default so the platform can route to it; the bearer token — not localhost binding — is what protects a public deployment.
3. The server logs a startup warning if it is bound publicly with **no** token set, and emits structured `[audit]` log lines for auth failures, history clears, queries, and rate-limit hits.
4. Rate limiting is on by default (300 req / 15 min globally, 30 / 15 min on the paid query route).

**If you set `TRIDENT_TOKEN_KEY` after already logging in:** re-run `trident google login` once so the stored token is re-written in encrypted form (existing plaintext tokens are still read for backward compatibility).

> **Note (read-only scopes):** if you authorized Google before this hardening, the old token may still carry the broader `gmail.modify` scope. Re-run `trident google login` to re-consent with read-only scopes, or revoke the old grant at <https://myaccount.google.com/permissions>.

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

## Rift — disagreement as an error signal

**Status: Phase 1 (capture). This is a measurement instrument, not a feature.**

Trident already runs multiple models in parallel and scores them. When they
disagree, it resolves the disagreement and throws it away. Rift keeps it.

### The hypothesis under test

> Disagreement across independently-queried models predicts whether an answer is
> wrong better than any individual model's self-reported confidence.

If it holds, disagreement entropy becomes a routing signal in Trident, a risk
gate downstream, and a confidence surface for other apps. If it doesn't, Rift is
killed and the kill is written down.

**No routing behavior is built until the scoring has run on real resolved data at
the preregistered sample size.** Phases 1–6 are measurement; Phase 7 is the only
phase that changes how Trident behaves, and it is gated on the Phase 6 verdict.

### What Rift stores

Five tables, all `rift_`-prefixed, in Trident's existing SQLite database:

| Table | Holds |
|---|---|
| `rift_queries` | One row per studied run — domain, answer type, prompt, `asked_at`, isolation flag, exclusion reason |
| `rift_model_responses` | Per-model answer, parsed value, latency, token cost, and the conditions it ran under |
| `rift_divergence` | The 0–1 disagreement metric, which method produced it, and how many models participated |
| `rift_resolutions` | Ground truth, its source, and **when the determining event occurred** |
| `rift_scoring` | Per-model correctness once truth is known |

Rift **reads** Trident's `session_runs` and never writes to it. The link is a soft
reference by id, deliberately not a SQL foreign key, so Rift can never block,
cascade into, or delay a Trident query.

### Resolved design decisions

Six issues surfaced during Phase 0 where the spec was unimplementable as
written or would have produced a misleading result. Each is settled in code:

| Issue | Decision |
|---|---|
| Leakage guard had nothing to compare against | Added `Resolution.event_at` (NOT NULL) — a resolution that can't state when its event occurred can't be recorded |
| Nowhere to log held-fixed conditions | Added `prompt_hash`, `system_prompt_hash`, `sampling_params` per response |
| "Same temperature" is impossible across providers — Trident sets none, and Claude Opus 5 rejects `temperature` outright | Policy is **identical across models within a query**, not equal to a global constant. All-unset satisfies it; the check still catches a future provider that starts sending params |
| Trident's confidence is a **judge** pass, not self-report — and the judge is one of the measured models | Split into two columns: `stated_confidence` (true self-report, NULL unless elicited) and `judge_confidence` + `judge_model` (free but circular, and labeled as such in every report) |
| BOOLEAN entropy at n=3 is effectively binary (3-0 → 0.0, 2-1 → 0.918) | `PREFERRED_PARTICIPANTS = 4`; Trident has four providers, so the third level is free. `MIN_PARTICIPANTS = 3` is the hard floor |
| Clustering 3–4 points for OPEN is degenerate, and embeddings cost money | Mean pairwise embedding dispersion (no free parameters), **opt-in** via `RIFT_ENABLE_OPEN_DIVERGENCE=1` so §9's zero-added-cost holds by default |

**The confidence baseline needs stating plainly in every report:** the free
comparator is a Claude judge scoring all four models, including itself. That is
circular. It is usable as a baseline only if labeled as judge-derived, never as
self-reported confidence. Eliciting genuine self-reports changes the prompt and
costs output tokens — available, but off by default.

### Predictive vs. static questions

The leakage guard applies to **predictive** queries only — those that declare
`resolves_after`. For §5's "verifiable facts" category, the truth-determining
event necessarily predates the ask (the capital of France was settled long ago),
so a blanket guard would have excluded the entire category the spec wants for
early volume. Static questions are still studied, but they measure **recall**,
not **prediction**, and are stratified separately — never pooled with forecasts.

### Methodological guards (why the result would mean anything)

- **Independence** — only parallel-mode runs enter the study set. Chained runs have
  contaminated disagreement by construction and are excluded (`CHAINED`).
- **No leakage** — a resolution records `event_at`, the time the truth-determining
  event actually happened. Any resolution whose event predates `asked_at` is
  rejected. This is the easiest way to accidentally produce a beautiful,
  meaningless result.
- **Held-fixed conditions** — prompt, system prompt, and sampling params are
  recorded per response and compared across models within a query, so the
  exclusion rule is evaluated rather than assumed.
- **Two predictors stay separate** — stated confidence is never folded into the
  divergence metric. They are the competitors in the evaluation.
- **Correlated error is a first-class result** — these models share training data
  and can agree confidently while all being wrong. The rate of
  *low-divergence-but-wrong* outcomes is reported prominently, not as a footnote.
  If that rate is high the signal is unusable regardless of the headline number.

### Divergence is computed per answer type

Never compare divergence values across answer types. Every query records which
method produced its number.

| Answer type | Method |
|---|---|
| `BOOLEAN` / `CATEGORICAL` | Normalized Shannon entropy over the answer distribution |
| `NUMERIC` | Median absolute deviation over the median (not SD/mean — too fragile at n=3) |
| `ORDINAL` | Kendall's W, inverted so higher means more disagreement |
| `OPEN` | Embedding dispersion. A model-as-judge is **never** the primary method — using a model to measure model disagreement is circular |

### Running the migration

```bash
npm run build:rift
npm run test:rift          # 50 tests: migration, §3 guards, capture
```

```ts
import Database from "better-sqlite3";
import { migrate, rollback, appliedMigrations } from "@trident/rift";

const db = new Database("data/trident.db");
migrate(db);               // apply pending migrations (idempotent)
appliedMigrations(db);     // => [1]
rollback(db, 0);           // fully reverse — leaves zero trace
```

The migration is reversible, per-version. `rollback(db, 1)` reverses only v2;
`rollback(db, 0)` drops every `rift_` object including the migration ledger,
restoring the database to its exact pre-migration schema. Verified against a
copy of the live database with session records present.

The §3 guards are exported and unit-tested:

```ts
import { assessEligibility, assertNoLeakage, STUDY_POLICY } from "@trident/rift";

assessEligibility({ mode, answerType, responses });  // => ExclusionReason | null
assertNoLeakage(query, resolution);                  // throws LeakageError
```

### Capture (Phase 1)

Capture is installed once at boot and records every Trident session:

```ts
import { installCapture } from "@trident/rift";
installCapture();     // already wired into ui-server and the CLI
```

It is registered as an observer on Trident's session writes, runs on the next
tick, and swallows every error — a Trident query is never blocked, delayed, or
failed by Rift (§9). Anything a silent failure drops is recovered by the sweep:

```bash
trident rift status      # capture stats, study set, exclusions, progress to n≥500
trident rift backfill    # capture sessions Rift hasn't recorded yet
```

**Chained runs are captured, not dropped** — recorded with
`exclusion_reason = 'CHAINED'` so the excluded population stays auditable.

**Rift never classifies with a model.** Inferring domain or answer type would
cost inference (§9) and make the study's own classification model-dependent.
Untagged runs default to `GENERAL`/`OPEN`. Tag explicitly at query time:

```jsonc
// metadata on a Trident session
{ "rift": { "domain": "RACING", "answerType": "CATEGORICAL",
            "resolvesAfter": "2026-03-02T00:00:00Z", "studyable": true } }
```

### Preregistration

[`packages/rift/HYPOTHESIS.md`](packages/rift/HYPOTHESIS.md) is **sealed**. It
fixes the outcome variable, the primary metric (AUROC of divergence predicting
`plurality_wrong`), the baselines, the per-domain minimum sample sizes, the
numeric tolerances, and the exact conditions under which the hypothesis is
rejected — all before any data is scored. It is never revised after seeing
results; it is superseded by a new file, with the old one kept.

It also carries the **correlated-error veto**: if >20% of the lowest-divergence
tercile is wrong, the signal is declared unusable for gating *regardless of
AUROC*.

### Recording a resolution

*Phase 3 — not yet built.* Manual resolution will be `trident rift resolve`;
automated resolvers run on a daemon against `resolves_after`, fastest-clock-first
(sports and racing daily, then verifiable facts, then financial forecasts).

### Reading the scoring output

*Phase 4 — not yet built.* Each scoring run emits a signed report artifact: AUC,
Brier score, and log loss for divergence vs. mean stated confidence vs.
most-confident-model vs. a constant baseline, with reliability diagrams,
stratified by domain and answer type, and the low-divergence-but-wrong rate.

### Storage note

SQLite, matching the rest of Trident. The Postgres path is a straightforward
port — no SQLite-specific features are used beyond `datetime('now')` defaults —
but it is not taken yet.

---

## License

MIT
