# @trident/spine

Cross-session claim persistence and conflict checking.

Trident scores verdicts and confidence per session and stores session replay in
SQLite, but nothing accumulates — every session starts cold. Spine is the thin
layer that makes claims outlive a session and checks new claims against stored
ones.

## What it does

- **Persists claims** with the provenance that produced them (which session,
  which models, what verdict, what confidence, and a pointer back into the
  existing session replay).
- **Locks invariants.** A locked claim cannot be silently overwritten. A
  conflicting write against a locked claim **raises** — it does not merge and
  does not quietly win.
- **Checks for conflicts on write** against existing claims in the same scope,
  **records** what it found, and hands the conflict back to the caller.
- **Tracks open questions** as first-class rows, so "we don't know yet" is
  stored state rather than an absent answer.
- **Scopes everything**, so claims from different projects don't
  cross-contaminate.

## What it deliberately does NOT do

These are out of scope by design, not "not yet":

- **No auto-resolution.** A conflict produces a record. Spine never picks a
  winner, never merges, never averages confidence. Resolution is a human or
  caller decision.
- **No simulation, no memory tiers, no governance, no mental models, no
  hypothesis generation, no emergence detection.**
- **No relation taxonomy beyond `supersedes`, `conflicts_with`, `answers`.**
  Three relations. That's the whole vocabulary.
- **No semantic/NLP conflict detection.** Conflict detection is deterministic
  and key-based (see *How conflicts are detected*). It will not notice that
  "the sky is blue" and "the sky is red" disagree unless they share a
  `canonical_form`.

## Data model

```
Claim
  id              clm_xxxxxxxxxxxx
  statement       human-readable assertion  ("Auth tokens expire after 24h")
  canonical_form  the KEY being claimed about  ("auth.token.expiry")
  scope           namespace  ("trident", "project-x")
  status          open | held | superseded | refuted
  locked          0 | 1        — locked claims are invariants
  created_at      ISO 8601
  superseded_by   claim id | null

Provenance  (exactly one per claim)
  claim_id
  session_id        FK-ish into session_runs.id (existing replay table)
  models_consulted  string[]  (JSON)
  verdict           text | null
  confidence        0..100 | null
  raw_response_ref  pointer into the session replay payload

Question
  id            qst_xxxxxxxxxxxx
  statement     the open item
  scope
  opened_at
  resolves_to   claim id | null   — null means still open

Conflict  (a record, never a resolution)
  id            cfl_xxxxxxxxxxxx
  claim_a       existing claim
  claim_b       incoming claim
  scope
  reason        why it fired
  detected_at

Relation
  from_claim -> to_claim, type ∈ { supersedes, conflicts_with, answers }
```

### How conflicts are detected

`canonical_form` is the load-bearing field. It is **not** a normalized copy of
`statement` — it is the *key* identifying **what** is being claimed about.

Two claims conflict when, in the **same scope**, they share a
`canonical_form` but assert a **different `statement`**. That is: two different
answers to the same question.

```
scope=trident  canonical_form=auth.token.expiry  "Auth tokens expire after 24h"
scope=trident  canonical_form=auth.token.expiry  "Auth tokens expire after 1h"   ← conflict
scope=other    canonical_form=auth.token.expiry  "Auth tokens expire after 1h"   ← no conflict (different scope)
```

If you omit `canonical_form`, it defaults to a normalization of `statement`
(lowercased, whitespace collapsed, trailing punctuation stripped). That makes
identical restatements dedupe, but two genuinely competing claims will **not**
be detected — because without a shared key there is nothing to compare on.
This is deliberate and honest: spine does not guess at meaning. Supply a
`canonical_form` when you want conflict detection to work.

### Locked invariants

`lock(claimId)` marks a claim as an invariant. Afterwards, any `assert()` that
conflicts with it throws `InvariantViolationError`. The incoming claim is **not
written** and the invariant is **not modified**. To change an invariant you
must `unlock()` it first — an explicit, auditable act.

## API

```ts
import { createSpine } from "@trident/spine";

const spine = createSpine();            // shares the existing Trident SQLite DB

spine.assert({ statement, canonical_form?, scope, provenance, supersedes? })
spine.lock(claimId) / spine.unlock(claimId)
spine.check({ statement, canonical_form?, scope })   // dry run — writes nothing
spine.ask({ statement, scope })
spine.resolve(questionId, claimId)
spine.history(claimId)
```

`check()` is the same conflict engine `assert()` uses, without the write. Use it
to preflight.

## Storage

Spine shares the existing Trident SQLite database (`data/trident.db`, or
`TRIDENT_DATA_DIR`) so claims sit alongside the session replay they cite. It
adds only `spine_*`-prefixed tables and **never modifies `session_runs`**.
Migrations are tracked in `spine_migrations` and are idempotent.

To point spine at a different database (tests do this):

```ts
import Database from "better-sqlite3";
const spine = createSpine(new Database(":memory:"));
```

## Running it

```bash
npm run build --workspace=packages/spine   # compile
npm run test  --workspace=packages/spine   # vitest
```

From the repo root: `npm run build:spine`, `npm run test:spine`.

CLI:

```bash
trident spine assert "Auth tokens expire after 24h" --key auth.token.expiry --scope trident
trident spine lock <claim-id>
trident spine check "Auth tokens expire after 1h" --key auth.token.expiry --scope trident
trident spine ask "Do refresh tokens rotate?" --scope trident
```

MCP: the `spine_*` tools are exposed by `@trident/mcp-server` so Claude can
query accumulated claims mid-session.
