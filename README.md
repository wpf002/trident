# Trident

Multi-AI orchestration layer with shared context. Connects Claude, ChatGPT, and Perplexity to a single MCP server — shared memory, shared docs, shared tools, parallel and chained query modes.

---

## What It Does

| Feature | Description |
|---|---|
| **Shared Memory** | Any AI can read/write to a SQLite store scoped by project |
| **Shared Docs** | Drop files in `data/docs/` — all AIs can read them via MCP |
| **Web Search** | Tavily integration exposed as an MCP tool |
| **External APIs** | Allowlisted API fetcher (news, finance, weather, etc.) |
| **Parallel Mode** | Fire one prompt at all three AIs, compare side-by-side |
| **Chain Mode** | Output of AI #1 → input to AI #2 → input to AI #3 |
| **Chain Presets** | Built-in workflows: draft-refine-verify, research-analyze-summarize, attack-defend-judge |

---

## Requirements

- Node.js 18+
- npm 8+
- API keys: Anthropic, OpenAI, Perplexity, Tavily (optional but recommended)

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/trident.git
cd trident
cp .env.example .env
# Fill in your API keys in .env
npm install
npm run build
```

### 2. Link the CLI globally

```bash
cd packages/cli
npm link
cd ../..
```

### 3. Connect the MCP server to Claude

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

### 4. Connect to ChatGPT

In ChatGPT Desktop → Settings → Extensions → Add MCP Server:
- Name: `Trident`
- Command: `node /absolute/path/to/trident/packages/mcp-server/dist/index.js`

---

## CLI Usage

```bash
# Check all API keys are configured
trident status

# Parallel: all three AIs answer the same prompt
trident parallel "What are the tradeoffs between RAG and fine-tuning?"

# Parallel with specific AIs only
trident parallel "Summarize this topic" --ais claude,gpt

# Chain: claude drafts, gpt refines, perplexity fact-checks
trident chain "Write an overview of MCP architecture" --preset draft-refine-verify

# Chain with custom order
trident chain "Is Rust worth learning in 2025?" --order perplexity,claude,gpt

# Show intermediate AI outputs during a chain
trident chain "Analyze this topic" --show-intermediate

# List chain presets
trident presets

# Memory: list all entries
trident memory list

# Memory: filter by project
trident memory list --project BHIS

# Memory: write a value
trident memory set project_goal "Build a church analytics dashboard" --project BHIS

# Memory: read a value
trident memory get project_goal --project BHIS

# Memory: delete
trident memory delete project_goal --project BHIS

# Memory: list all project namespaces
trident memory projects
```

---

## Chain Presets

| Preset | Order | Use Case |
|---|---|---|
| `draft-refine-verify` | Claude → GPT → Perplexity | Writing with live fact-check |
| `research-analyze-summarize` | Perplexity → Claude → GPT | Research to actionable summary |
| `attack-defend-judge` | GPT → Claude → Perplexity | Debate and verdict |

---

## Project Structure

```
trident/
├── packages/
│   ├── mcp-server/          # MCP server (Claude + ChatGPT connect here)
│   │   └── src/
│   │       ├── index.ts     # Server entry point
│   │       ├── db/          # SQLite shared store
│   │       └── tools/       # memory, search, files, api
│   └── cli/                 # Trident CLI
│       └── src/
│           ├── index.ts     # CLI entry point
│           ├── commands/    # parallel, chain, memory
│           └── lib/         # AI client wrappers
├── data/
│   ├── docs/                # Drop project files here — all AIs can read
│   └── trident.db           # Auto-created shared memory store
├── .env                     # Your API keys (gitignored)
└── .env.example
```

---

## Adding Project Context

To make all AIs aware of a project:

```bash
# Option 1: Drop files in data/docs/
cp my-project-notes.md data/docs/my-project/notes.md

# Option 2: Write key facts to shared memory
trident memory set architecture "React frontend, Node backend, PostgreSQL" --project my-project
trident memory set goals "Build X by Y" --project my-project
```

Then in Claude, ChatGPT, or via CLI — any AI can call `file_read` or `memory_read` to access that context.

---

## Extending

**Add an external API domain:** Edit `packages/mcp-server/src/tools/api.ts` → add to `ALLOWED_DOMAINS`.

**Add a chain preset:** Edit `packages/cli/src/commands/chain.ts` → add to `CHAIN_PRESETS`.

**Add a new MCP tool:** Create a file in `packages/mcp-server/src/tools/`, register it in `src/index.ts`.

---

## License

MIT
