# Trident — Application Security Assessment

**Repository:** `trident` — "Multi-AI orchestration layer with shared MCP context"
**Assessed:** 2026-05-29
**Method:** Read-only static review of all 63 tracked files (~5,400 LOC), `npm audit`, git-history secret scan, and a multi-agent fan-out pass. Findings are code-backed with file:line. No code was modified.
**Stack (verified from files):** TypeScript monorepo, npm workspaces, ESM, Node ≥18. Six packages: `core` (AI client primitives), `cli` (Commander CLI), `mcp-server` (stdio MCP server + tools), `scheduler` (node-cron daemon), `ui-server` (Express API + serves built UI), `ui` (React + Vite). Deployed to **Railway** via `nixpacks.toml` (start command runs `ui-server`). SQLite (`better-sqlite3`) for persistence. Secrets via `.env`/dotenv. Google Workspace via OAuth (`credentials.json` + `data/google-token.json`).

---

## Executive Summary

This is a personal/single-tenant AI orchestration tool. The dominant risk is that its **public-facing Express server (`ui-server`) has no authentication, an open CORS policy, and no rate limiting**, while it is configured to be deployed publicly on Railway and to spend the operator's paid LLM API keys on every request. Layered on top, the **MCP server wires private Google data (Gmail/Drive/Calendar) together with untrusted-content ingestion and an outbound HTTP channel** — the classic prompt-injection "lethal trifecta." Dependency hygiene is mediocre (1 high + 12 moderate CVEs). On the positive side: **no secrets are committed to code or git history**, **all SQL is parameterized**, input is validated at most boundaries, the file/API tools use allowlists, and the React renderer does not allow raw HTML.

### Findings by severity

| Severity | Count |
|----------|-------|
| Critical | 1 |
| High     | 4 |
| Medium   | 6 |
| Low      | 5 |
| Info / Code-health | 8 |
| **Total** | **24** |

### Top 5 must-fix

1. **[CRITICAL] `ui-server` is a fully unauthenticated, CORS-open, public API** (`packages/ui-server/src/index.ts`) — anyone who can reach the Railway URL can read every stored prompt/response, wipe all history, and run queries that bill the operator's Anthropic/OpenAI/Perplexity accounts.
2. **[HIGH] No rate limiting or spend cap on `/api/query/stream`** — unbounded, unauthenticated paid-LLM invocation = financial DoS.
3. **[HIGH] Prompt-injection "lethal trifecta" in the MCP server** — `web_search`/`file_read`/`api_fetch` ingest attacker-controllable content into a model that can also read Gmail/Drive/Calendar and POST outbound via `api_fetch`.
4. **[HIGH] Over-privileged Google OAuth scope `gmail.modify`** — write/delete access to the user's mailbox is requested but never used (read-only would suffice).
5. **[HIGH] Vulnerable dependencies** — `fast-uri` (HIGH, path traversal/host confusion) plus 12 moderate CVEs; run `npm audit fix`.

---

## Part 1 — Scope & Attack Surface

### 1.1 Entry-point inventory

| # | Entry point | File:line | Trust boundary | Input | Guard |
|---|-------------|-----------|----------------|-------|-------|
| HTTP | `GET /api/sessions` | `ui-server/src/index.ts:35` | **Public (Railway)** | none | **none** |
| HTTP | `DELETE /api/sessions` (wipes all) | `ui-server/src/index.ts:39` | Public | none | **none** |
| HTTP | `GET /api/sessions/:id` | `ui-server/src/index.ts:44` | Public | path param | **none** |
| HTTP/SSE | `POST /api/query/stream` (spends paid API keys) | `ui-server/src/index.ts:142` | Public | JSON body | `parseQuery` validates **shape only** (`:111`) — no authn/rate limit |
| HTTP | static UI + `GET *` SPA fallback | `ui-server/src/index.ts:314-322` | Public | path | express.static |
| MCP tool | `web_search` (Tavily) | `mcp-server/src/tools/search.ts:34` | LLM-driven | query | API-key presence |
| MCP tool | `file_read` / `file_list` | `mcp-server/src/tools/files.ts:72` | LLM-driven | rel path | extension allowlist + path check (buggy, see M2) |
| MCP tool | `api_fetch` | `mcp-server/src/tools/api.ts:60` | LLM-driven | URL/method/headers/body | domain allowlist (see M1) |
| MCP tool | `perplexity_search` | `mcp-server/src/tools/perplexity.ts:38` | LLM-driven | query/system | API-key presence |
| MCP tool | `gmail_search` / `gdrive_search` / `gcal_upcoming` | `mcp-server/src/tools/google.ts:218` | LLM-driven, **private data** | query | OAuth token |
| Cron | scheduled chain runner | `scheduler/src/index.ts:426` (daemon), `:380` (run) | Local config (`schedules.json`) | cron + prompt | `validateSchedule` (`:54`) |
| CLI | `parallel`/`chain`/`route`/`sessions`/`config`/`google` | `cli/src/index.ts` | Local operator | argv | per-command |
| OAuth callback | loopback HTTP server during `trident google login` | `cli/src/commands/google.ts:76-107` | localhost, transient | `?code` | accepts any caller (no `state`, see L3) |

MCP transport is **stdio** (`mcp-server/src/index.ts:92`) — local trust by design; the risk there is content-driven (prompt injection), not network exposure.

### 1.2 Sensitive data flows

- **LLM API keys** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, `TAVILY_API_KEY`): enter via `.env`→`process.env`, read at call sites (`core/src/clients.ts:53,130`; `tools/search.ts:42`; `tools/perplexity.ts:46`). Sent only to their respective vendor APIs over TLS. **Never logged or persisted.** Good.
- **Google OAuth tokens** (`access_token` + long-lived `refresh_token`): obtained in `cli/src/commands/google.ts:152`, written **plaintext** to `data/google-token.json` (`:44`), reloaded in `mcp-server/src/lib/google.ts:68-81`. Used to call Gmail/Drive/Calendar. See M3.
- **Google client secret**: read from `credentials.json` (`lib/google.ts:49`) plaintext at repo root. Gitignored. See M3.
- **Prompts & model responses**: persisted **plaintext** in SQLite `session_runs.prompt` / `.responses` (`ui-server/src/db.ts:118`; `mcp-server/src/db/index.ts:84`; `scheduler/src/index.ts:159`). Exposed wholesale via the unauthenticated `GET /api/sessions` (C1). These can contain whatever the user typed — potentially PII/secrets. See C1, M3.
- **Gmail/Drive/Calendar content**: read on demand by the Google tools and returned to the driving LLM; calendar `description`/attendee emails, Drive owner emails, Gmail subjects/senders/snippets all flow into model context (`tools/google.ts:123-216`).

### 1.3 Third-party / outbound integrations

| Service | Where | Auth | Notes |
|---------|-------|------|-------|
| Anthropic API | `core/src/clients.ts:63` | `ANTHROPIC_API_KEY` | TLS, SDK |
| OpenAI API | `core/src/clients.ts:139` | `OPENAI_API_KEY` | TLS, SDK |
| Perplexity | `clients.ts:200`, `tools/perplexity.ts:69` | `PERPLEXITY_API_KEY` | Bearer |
| Tavily | `tools/search.ts:68` | `TAVILY_API_KEY` | Bearer |
| Google Gmail/Drive/Calendar | `tools/google.ts` | OAuth2 | private data |
| Generic `api_fetch` allowlist | `tools/api.ts:3-13` | caller headers | NewsAPI, Polygon.io, Finnhub, OpenWeather, ExchangeRate, CoinGecko, GitHub, Hacker News, NYTimes |

**No payment-card data is handled.** Market/financial feeds (Polygon, Finnhub) are public market data, not cardholder data → **no PCI-DSS scope**.

### 1.4 Software Bill of Materials (direct deps)

| Package | Direct deps (version range) |
|---------|------------------------------|
| `core` | `@anthropic-ai/sdk ^0.27.0`, `openai ^4.56.0` |
| `cli` | + `commander ^12.1.0`, `chalk ^5.3.0`, `ora ^8.0.1`, `dotenv ^16.4.5`, `nanoid ^5.0.7`, `better-sqlite3 ^12.9.0`, `google-auth-library ^9.14.0` |
| `mcp-server` | `@modelcontextprotocol/sdk ^1.0.0`, `better-sqlite3 ^12.9.0`, `dotenv`, `googleapis ^144.0.0`, `google-auth-library ^9.14.0`, `zod ^3.22.4` |
| `scheduler` | `node-cron ^3.0.3`, `better-sqlite3`, `nanoid`, `chalk`, `dotenv` |
| `ui-server` | `express ^4.19.2`, `cors ^2.8.5`, `better-sqlite3`, `dotenv`, `nanoid` |
| `ui` | `react ^18.3.1`, `react-dom`, `react-markdown ^9.0.1`, `remark-gfm`, `remark-math`, `rehype-katex ^7.0.0`, `katex ^0.16.9`; dev: `vite ^5.4.0` |

**Pinning hygiene:** all deps use caret (`^`) ranges — not pinned, but a `package-lock.json` is committed (integrity preserved on `npm ci`). All versions are floating, so a fresh `npm install` may pull newer patch/minor builds.

**`npm audit`: 13 vulnerabilities (1 high, 12 moderate)** — see H3 / M4 for details.

---

## Part 2 — Security Findings

### Sensitive Data Protection

**Good:** No secrets in code or committed configs; `.env.example` contains only placeholders (`.env.example:2-4`); `.env`, `credentials.json`, `data/google-token.json`, `data/*.db` are all gitignored (`.gitignore`). Git history is **clean** — verified across all 21 commits that no real `.env`, `credentials.json`, token, or live API key was ever committed (the file-pattern hit on commit `26b0397` was source files only). Secrets are loaded from env/files, never hardcoded, and never written to logs (`cli/src/commands/google.ts:175,184` log only the token *path* and scope names, not values).

**Missing / Broken:**

#### [MEDIUM] M3 — Credentials and conversation data stored unencrypted at rest
- **Files:** `cli/src/commands/google.ts:41-45` (writes `google-token.json`), `mcp-server/src/lib/google.ts:77-81`, `tools/api.ts`/db writers; SQLite at `mcp-server/src/db/index.ts:8`, `ui-server/src/db.ts:10`.
- **Risk:** `data/google-token.json` holds a long-lived Google **`refresh_token`** in plaintext; `credentials.json` holds the OAuth **client secret**; the SQLite DB stores every prompt and model response in plaintext. Anyone with read access to the host/disk/backup (or a path-traversal/file-read bug — see M2) gains persistent access to the user's Gmail/Drive/Calendar and full conversation history.
- **Fix:** Encrypt the token file at rest (e.g. OS keychain via `keytar`, or age/libsodium with a key from env), restrict file perms to `0600`, and consider field-level encryption or at minimum disk encryption + restricted DB file perms. Document that the host must be trusted.

### Access Control & Authentication

**Missing / Broken:**

#### [CRITICAL] C1 — `ui-server` HTTP API has no authentication, open CORS, and is deployed publicly
- **File:** `packages/ui-server/src/index.ts:30` (`app.use(cors())` — reflects/allows any origin), `:35-51` (sessions routes), `:142` (query route); `railway.json:6` deploys this as the public start command.
- **Risk:** Every endpoint is reachable by anyone who knows the Railway URL, with **no token, session, or origin restriction**:
  - `GET /api/sessions` / `GET /api/sessions/:id` → exfiltrate all stored prompts + AI responses (potential PII/secrets).
  - `DELETE /api/sessions` → **destroy all history** with one unauthenticated request (`:39`).
  - `POST /api/query/stream` → spend the operator's paid API keys at will.
  Open CORS (`cors()` with no options) additionally lets **any website the operator visits** silently issue these requests from the victim's browser (CSRF-style, no preflight obstacle for simple reads).
- **Fix:** Put the API behind authentication (a shared bearer token / session cookie with `HttpOnly; Secure; SameSite=Strict`, or front it with an auth proxy). Lock CORS to an explicit allowlist of trusted origins (`cors({ origin: [...] })`) and disable credentials unless needed. If the tool is meant to be single-user/local-only, bind to `127.0.0.1` and do **not** expose it on Railway.

#### [HIGH] H2 — No rate limiting / spend protection on the paid-query endpoint
- **File:** `packages/ui-server/src/index.ts:142-310` (`/api/query/stream`).
- **Risk:** Each call fans out to up to three paid LLM providers (and optional diff/score synthesis calls, `:236-275`). With no auth (C1) and no rate limit, an attacker can loop the endpoint to run up an unbounded bill or exhaust provider quotas (financial denial of service). There is also no per-request token/cost ceiling beyond `max_tokens`.
- **Fix:** Add `express-rate-limit` (or equivalent) on `/api/query/*`, enforce auth (C1), and add a global/daily spend or request budget.

#### [HIGH] H4 — Over-privileged Google OAuth scope (`gmail.modify`)
- **Files:** `mcp-server/src/lib/google.ts:11-16` and `cli/src/commands/google.ts:14-19` both request `gmail.modify`.
- **Risk:** `gmail.modify` grants read **and write/delete/label** of the user's mailbox, but the only Gmail code path is read-only (`threads.list`/`threads.get`, `tools/google.ts:103-117`). The excess privilege means any abuse (prompt injection — H1, token theft — M3, or a future bug) can *alter or delete email*, not just read it. Violates least privilege.
- **Fix:** Drop to `gmail.readonly`. Re-consent. Only request `gmail.modify` if/when a write feature actually ships.

**Note on IDOR:** the app is single-tenant with no user model, so per-user object scoping does not apply; session IDs are `nanoid(12)` (unguessable). The real exposure is the *complete absence* of access control (C1), not an object-reference bug.

### Input Handling & Injection

**Good:** Every SQL statement uses `better-sqlite3` prepared statements with `?` placeholders — **no SQL injection** (`ui-server/src/db.ts:101,108,120`; `mcp-server/src/db/index.ts:85,157-165`; `scheduler/src/index.ts:160`). Request bodies are shape-validated (`parseQuery`, `ui-server/src/index.ts:111-140`), schedules are validated (`validateSchedule`, `scheduler/src/index.ts:54`), config is validated (`cli/src/lib/config.ts:24`). The React renderer (`ui/src/components/MarkdownView.tsx`) uses `react-markdown` v9 **without `rehype-raw`**, so raw HTML in model output is not rendered → **XSS is well-mitigated**; links get `rel="noreferrer noopener"` (`:35`). No `dangerouslySetInnerHTML`, no `eval` (the only `new Function` is a documented lazy-`import` shim, `tools/google.ts:8`). Drive query single-quotes are escaped (`tools/google.ts:153`).

**Broken / Needs attention:**

#### [HIGH] H1 — Prompt-injection "lethal trifecta" across MCP tools
- **Files:** untrusted-content sources `tools/search.ts` (`web_search`), `tools/files.ts` (`file_read`), `tools/api.ts` (`api_fetch`), `tools/perplexity.ts`; private-data sinks `tools/google.ts` (`gmail_search`/`gdrive_search`/`gcal_upcoming`); exfiltration channel `tools/api.ts:88-92` (`api_fetch` POST to any allowlisted domain, with caller-controlled body/headers).
- **Risk:** The same MCP session exposes (1) tools that pull in attacker-controllable text (a web page via Tavily, a file's contents, an API response, an email body), (2) tools that read the user's private Gmail/Drive/Calendar, and (3) an outbound POST primitive. A malicious instruction embedded in fetched content can steer the model to read private data and exfiltrate it (e.g. POST a summary to an attacker-controlled path on an allowlisted host such as `api.github.com` gists, or encode it into a request). This is the canonical lethal-trifecta exposure.
- **Fix:** Break the trifecta — e.g. require explicit per-tool user confirmation before Google/private-data tools run in a session that has also ingested external content; or isolate "read untrusted content" and "access private data" into separate sessions/servers; constrain `api_fetch` to GET-only and strip caller-supplied headers; add provenance/taint tracking. At minimum, document the risk prominently and default the Google tools off.

#### [MEDIUM] M1 — SSRF: `api_fetch` allowlist bypass via redirects and header passthrough
- **File:** `mcp-server/src/tools/api.ts:70-92`.
- **Risk:** `isAllowedUrl` validates only the *initial* URL's hostname. `fetch()` follows 3xx redirects by default, so an allowlisted host that returns a redirect to `http://169.254.169.254/...` (cloud metadata) or an internal address would be followed, defeating the allowlist. The tool also forwards arbitrary caller-supplied `headers` (`:77,82-85`) to the target, enabling header injection / auth-token smuggling. Combined with H1, this is an exfiltration/SSRF channel.
- **Fix:** Set `redirect: "manual"` (or cap and re-validate each hop against the allowlist), block requests resolving to private/loopback/link-local IP ranges (validate after DNS resolution to defeat rebinding), and restrict forwardable headers to a safe allowlist.

#### [MEDIUM] M2 — Path-traversal: prefix-match flaw in `file_read`/`file_list`
- **File:** `mcp-server/src/tools/files.ts:28-31` (`isSafePath` uses `resolved.startsWith(DOCS_DIR)`), also `:83`.
- **Risk:** `startsWith(DOCS_DIR)` is a string-prefix check without a trailing-separator guard. A sibling path such as `<repo>/data/docs-secrets/...` resolves to a string that *starts with* `<repo>/data/docs`, so it passes the check and escapes the intended `data/docs` jail. (Standard `../` traversal is correctly blocked because `path.resolve` normalizes it out of the prefix.) Lower likelihood since it needs a sibling directory named `docs*`, but it is a real containment bug, and `file_read` already exposes `.ts`/`.js`/`.json`/`.env.example` contents.
- **Fix:** Compare against `DOCS_DIR + path.sep` (and treat exact-equality separately), or use `path.relative(DOCS_DIR, resolved)` and reject when it starts with `..` or is absolute.

### Third-Party & Supply Chain

#### [HIGH] H3 — `fast-uri` high-severity CVE (transitive)
- **Source:** `npm audit`; `fast-uri <=3.1.1` — path traversal via percent-encoded dot segments (CWE-22, CVSS 7.5, GHSA-q3j6-qgpj-74h6) and host confusion (CWE-436, GHSA-v39h-62p7-jpjc). Pulled in transitively.
- **Fix:** `npm audit fix` (a patched `fast-uri` is available without a major bump); re-run audit to confirm.

#### [MEDIUM] M4 — Twelve moderate-severity dependency CVEs
- **Source:** `npm audit`. Highlights:
  - `esbuild <=0.24.2` (via `vite`) — dev server lets any website read responses (CWE-346). Dev-only, but fix bumps `vite` to a **major** version.
  - `express 4.21.0–4.22.1` (via `qs`) — fixable in range.
  - `googleapis <=149` / `googleapis-common` / `gaxios` (vulnerable `uuid`) — fix is `googleapis@173` (**major**).
  - `node-cron 3.0.2–3.0.3` (vulnerable `uuid`).
  - `express-rate-limit` and `hono` appear in the lockfile **transitively** (not in any `package.json`); confirm reachability before prioritizing — likely not exercised by app code.
- **Fix:** Run `npm audit fix` for in-range fixes; schedule the `vite`/`googleapis` major bumps with regression testing. Pin or add `overrides` for the `uuid`-driven advisories.

**Risky patterns:** `tools/google.ts:8` constructs a dynamic importer via `new Function` — documented and necessary (avoids tsc hang on googleapis' 49 MB of types) but worth noting as an audited exception; the specifier is a constant, so it is not an injection vector.

### Infrastructure & Config

**Good:** No `Dockerfile`/`compose` running as root (Railway/nixpacks build). No baked secrets in `nixpacks.toml`/`railway.json`. `bootstrap.sh` uses `set -e`, does not `curl|bash` or fetch remote code, and only copies `.env.example`→`.env` locally. Request body capped at 5 MB (`ui-server/src/index.ts:31`).

**Missing / Broken:**

#### [LOW] L1 — No security headers on the web server
- **File:** `ui-server/src/index.ts` (no `helmet`, no CSP, no HSTS, no `X-Content-Type-Options`).
- **Risk:** Missing defense-in-depth headers for the served React UI and API responses.
- **Fix:** Add `helmet()` with a Content-Security-Policy; enable HSTS (Railway terminates TLS at the edge).

#### [LOW] L2 — Verbose error messages returned to clients
- **Files:** `ui-server/src/index.ts:305` (persist error echoed to client), upstream raw error bodies surfaced in `tools/search.ts:79`, `tools/perplexity.ts:88-90`.
- **Risk:** Internal error detail / upstream API error text can leak implementation and occasionally sensitive context to callers.
- **Fix:** Return generic client messages; log details server-side only.

#### [LOW] L3 — OAuth loopback flow lacks `state`/PKCE
- **File:** `cli/src/commands/google.ts:65-107` — `generateAuthUrl` is called without a `state` parameter, and the local callback server resolves the first `?code` it receives from any caller.
- **Risk:** No CSRF protection on the authorization-code callback; no PKCE on the desktop flow. Localhost + interactive, so exploitability is low, but it deviates from OAuth 2.0 for Native Apps (RFC 8252) best practice.
- **Fix:** Generate a random `state`, pass it to `generateAuthUrl`, and verify it on callback; enable PKCE (`code_challenge`/`code_verifier`).

#### CI/CD
There is **no CI pipeline** (`.github/workflows` absent). No automated dependency scanning, secret scanning, lint, or test gate exists, and there is no branch-protection config in-repo to reference. (Tracked as Info-7.)

### Logging & Monitoring

**Good:** No secrets/tokens/PII are written to logs (verified — `console.*` near key/token/secret only prints paths and scope names). Scheduled runs record last-run status/error to `data/scheduler-state.json` (`scheduler/src/index.ts:455-470`).

**Missing:**

#### [MEDIUM] M5 — No audit trail or security-event logging for sensitive actions
- **Files:** `ui-server/src/index.ts` (no logging of who/where for `DELETE /api/sessions`, query invocations, or failed validations); `tools/files.ts`, `tools/api.ts`, `tools/google.ts` (no record of file reads, outbound fetches, or Gmail/Drive/Calendar access).
- **Risk:** With no authentication (C1) there is also no record of access — destructive deletes, key-spending queries, and private-data reads happen with zero audit trail. Detection/forensics are impossible.
- **Fix:** Add structured request logging (method, path, source IP, outcome) and an audit log for privileged tool use (Google data access, `file_read`, `api_fetch`, session deletion). Add alerting on anomalous spend/volume.

---

## Part 3 — Code Health & Architecture

### Dead / unused files (confidence)
- `packages/cli/src/lib/clients.ts` (9 lines) and `packages/ui-server/src/clients.ts` (10 lines) — thin re-export shims; verify they are still imported (medium confidence they are vestigial).
- `packages/ui/src/lib/format.ts` (7 lines) — confirm it is referenced by a component (low-medium confidence it may be unused).
- `packages/core/src/presets.ts` / `clients-types.ts` — referenced via `core/src/index.ts`; **not** dead (high confidence).
- `schedules.json` ships as `[]` (empty) — intentional template, not dead.

*(Confirm dead-code candidates with an import graph before deleting — this was a read-only pass.)*

### Stale / generated artifacts
- None committed: `dist/`, `*.tsbuildinfo`, `*.d.ts`, `*.js.map`, `packages/ui-server/static/` are all gitignored and absent from tracking. Clean.

### Poor coding practices
- **Empty/swallowed catches:** `mcp-server/src/lib/google.ts:96-100` (token-refresh persistence failure silently ignored) and `:72-74` (`loadSavedToken` returns null on any parse error — corrupt token is indistinguishable from missing). `scheduler/src/index.ts:108-110` similarly swallows state-parse errors.
- **`any` usage:** pervasive in `mcp-server/src/tools/google.ts` (`loadGoogle(): Promise<any>`, and `(t: any)`, `(h: any)`, `(f: any)`, `(e: any)` mappers at `:111,122,163,169,198,205`) — googleapis responses are untyped, weakening compile-time safety on data that flows into model context.
- **Module-load side effects / resource lifecycle:** `mcp-server/src/db/index.ts:15` opens the SQLite handle at import time and **never closes it**; no graceful shutdown. The DB connection is a module singleton (acceptable for a long-lived process, but undocumented).
- **Duplicated logic:** the `session_runs` schema and insert/parse logic are **re-implemented four times** — `ui-server/src/db.ts`, `mcp-server/src/db/index.ts`, `scheduler/src/index.ts:120-177`, and the cli db layer. Schema drift risk (e.g. `ui-server` lacks the indexes that `mcp-server` creates).
- **Duplicated client wrappers:** `core` exposes the canonical clients, yet `cli/src/lib/clients.ts` and `ui-server/src/clients.ts` add re-export shims — inconsistent indirection.

### Architecture
- **Layering:** `scheduler` and `ui-server` each reach directly into their own SQLite layer rather than sharing a single `@trident/core`-owned persistence module — business/persistence logic is duplicated across packages instead of centralized. Consolidating the DB layer into one package would remove the schema-drift hazard above.
- **Separation of concerns is otherwise reasonable:** `core` holds provider clients, tools are cleanly modular in `mcp-server`, and the CLI/UI are thin consumers.

### Test coverage
- **There are zero tests anywhere in the repo** (no `*.test.ts`, `*.spec.ts`, or test runner configured). Security- and money-critical paths with **no coverage**: the SSE query/spend path (`ui-server`), the allowlist logic in `api.ts`/`files.ts`, `parseQuery`/`validateSchedule` input validation, and the OAuth token lifecycle. (Info.)

---

## Part 4 — Risk Prioritization & Roadmap

### 4.1 Risk matrix

| ID | Finding | Severity | Exploitability | Blast radius | Priority |
|----|---------|----------|----------------|--------------|----------|
| C1 | Unauthenticated public API + open CORS | Critical | High (just hit the URL) | All data + key spend + wipe | **P0** |
| H2 | No rate limit / spend cap on query | High | High | Financial DoS | **P0** |
| H1 | MCP prompt-injection lethal trifecta | High | Medium (needs poisoned content) | Gmail/Drive/Calendar exfil | **P1** |
| H4 | `gmail.modify` over-privilege | High | Low alone (amplifies H1/M3) | Mailbox write/delete | **P1** |
| H3 | `fast-uri` HIGH CVE | High | Medium | Path traversal/host confusion | **P1** |
| M1 | `api_fetch` SSRF via redirects/headers | Medium | Medium | Internal/metadata access, exfil | **P1** |
| M3 | Plaintext tokens/creds/data at rest | Medium | Low (needs host access) | Persistent Google + history compromise | **P2** |
| M2 | `file_read` prefix-match traversal | Medium | Low (needs sibling dir) | Local file disclosure | **P2** |
| M4 | 12 moderate dependency CVEs | Medium | Low–Medium | Mixed (mostly dev/transitive) | **P2** |
| M5 | No audit trail for sensitive actions | Medium | n/a | Detection/forensics gap | **P2** |
| L1 | Missing security headers | Low | Low | Defense-in-depth | **P3** |
| L2 | Verbose errors to clients | Low | Low | Info leak | **P3** |
| L3 | OAuth flow lacks state/PKCE | Low | Low | CSRF on local callback | **P3** |

### 4.2 Standards mapping

| Finding | OWASP Top 10 (2021) | OWASP ASVS (v4) | NIST CSF |
|---------|---------------------|-----------------|----------|
| C1 | A01 Broken Access Control; A05 Misconfig | V1.4, V4.1, V13.1, V14.4 (CORS) | PR.AC, PR.PT |
| H2 | A04 Insecure Design | V11.1 (anti-automation) | PR.PT, DE.CM |
| H1 | A03 Injection (LLM/prompt); A04 | V5.1, V12/SSRF-adjacent | ID.RA, PR.DS |
| H4 | A01; A04 (least privilege) | V1.4.4, V4.1.3 | PR.AC-4 |
| H3/M4 | A06 Vulnerable & Outdated Components | V14.2 | ID.RA, ID.SC |
| M1 | A10 SSRF | V12.6 / V5.2.6 | PR.DS, PR.PT |
| M2 | A01 / path traversal | V12.3 | PR.DS |
| M3 | A02 Cryptographic Failures | V6.1, V8.1 | PR.DS-1 |
| M5 | A09 Logging & Monitoring Failures | V7.1, V7.2 | DE.CM, DE.AE, RS.AN |
| L1 | A05 Misconfiguration | V14.4 | PR.PT |
| L2 | A05 | V7.4.1 | PR.IP |
| L3 | A07 Auth Failures | V3.5, V51 (OAuth) | PR.AC |

**PCI-DSS:** Not applicable — no cardholder/payment data is processed. Market-data feeds are public reference data only. (Stated explicitly per scope request.)

**NIST CSF posture summary:** *Identify* — weak (no SBOM/asset/dependency monitoring, no tests). *Protect* — weak (no authN/authZ, plaintext secrets, over-broad scopes). *Detect* — absent (no logging/alerting). *Respond/Recover* — absent (no audit trail; `DELETE /api/sessions` is unauthenticated and unrecoverable).

### 4.3 Recommended remediation order

1. **P0 — Lock down `ui-server` (C1, H2).** Add authentication, restrict CORS to known origins, bind locally if it's single-user, add rate limiting + a spend cap on `/api/query/stream`. This single change neutralizes the largest blast radius (data theft, key abuse, history wipe). *Do this before any further public deployment.*
2. **P1 — Reduce Google blast radius (H4) and break the trifecta (H1, M1).** Drop to `gmail.readonly`; set `api_fetch` to GET-only with `redirect: "manual"`, IP-range blocking, and header allowlisting; gate private-data tools behind explicit confirmation when external content has been ingested.
3. **P1 — Patch dependencies (H3, then M4).** `npm audit fix` for the high + in-range moderates; schedule the `vite`/`googleapis` major bumps.
4. **P2 — Protect data at rest and add auditing (M3, M5, M2).** Encrypt/`0600` the token file, restrict DB perms, fix the `file_read` prefix check, and add structured request + privileged-action audit logging.
5. **P3 — Hardening polish (L1–L3).** `helmet` + CSP/HSTS, generic error responses, OAuth `state`/PKCE.
6. **Ongoing — Code health.** Consolidate the four duplicated SQLite layers into one `core`-owned module, replace `any` in the Google tools, stop swallowing errors silently, and add a CI pipeline with `npm audit`, lint, and a first test suite covering the query/spend, allowlist, and validation paths.

---

## Appendix — Verification notes & triaged-out items

Items investigated and found **not** to be vulnerabilities (so you can skip them):
- **Committed secrets / leaked keys in git history** — none. All 21 commits scanned; no `.env`, `credentials.json`, token file, or live API key ever committed. `.gitignore` correctly covers all secret artifacts.
- **SQL injection** — none; every query is parameterized via `better-sqlite3` prepared statements.
- **Stored/DOM XSS in the UI** — mitigated; `react-markdown` v9 runs without `rehype-raw`, so model output cannot inject HTML/script; no `dangerouslySetInnerHTML`.
- **`eval`/code injection** — the only `new Function` (`tools/google.ts:8`) is a constant-specifier dynamic-import shim, not attacker-influenced.
- **IDOR / object scoping** — not applicable (single-tenant, no user model); the issue is total absence of auth (C1), not per-object scoping.

*Assessment complete. Awaiting your direction on remediation — no changes have been made to the repository.*
