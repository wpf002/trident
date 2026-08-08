// Spine tools — let Claude query and extend the accumulated claim store
// mid-session, so a session doesn't start cold.
//
// Deliberate constraint: nothing here resolves a conflict. spine_assert reports
// what it collided with, spine_check previews it, and a locked invariant makes
// the write fail loudly. Resolution stays a human decision.

import { createSpine, InvariantViolationError } from "@trident/spine";

export const spineTools = [
  {
    name: "spine_check",
    description:
      "Check whether a claim would conflict with what Trident already believes, " +
      "WITHOUT writing anything. Call this before asserting something you're not " +
      "sure about, or when you want to know if the user's request contradicts a " +
      "prior decision. Returns the conflicting claims and whether any is a locked " +
      "invariant (which would make an assert fail).",
    inputSchema: {
      type: "object",
      properties: {
        statement: { type: "string", description: "The claim to test." },
        canonical_form: {
          type: "string",
          description:
            "The KEY this claim is about, e.g. 'auth.token.expiry'. Conflict detection " +
            "compares claims sharing a key — omit it and conflicts will NOT be found.",
        },
        scope: { type: "string", description: "Scope/namespace, e.g. a project name. Default: trident." },
      },
      required: ["statement"],
    },
  },
  {
    name: "spine_assert",
    description:
      "Record a claim that should persist beyond this session, with the provenance " +
      "that produced it. Runs the conflict check on write: conflicts are RECORDED " +
      "and returned, never auto-resolved. If it collides with a locked invariant the " +
      "call fails and nothing is written.",
    inputSchema: {
      type: "object",
      properties: {
        statement: { type: "string", description: "The claim, in plain language." },
        canonical_form: {
          type: "string",
          description: "The KEY this claim is about. Supply it or conflicts won't be detected.",
        },
        scope: { type: "string", description: "Scope/namespace. Default: trident." },
        session_id: { type: "string", description: "Session this came from (session_runs.id)." },
        models_consulted: {
          type: "array",
          items: { type: "string" },
          description: "Which models produced this, e.g. ['claude','gpt'].",
        },
        verdict: { type: "string", description: "Verdict from the session, if any." },
        confidence: { type: "number", description: "Confidence 0-100, if scored." },
        raw_response_ref: { type: "string", description: "Pointer into the session replay payload." },
        supersedes: { type: "string", description: "Claim id this explicitly replaces." },
      },
      required: ["statement"],
    },
  },
  {
    name: "spine_recall",
    description:
      "Recall what Trident already believes — stored claims, open questions, or " +
      "recorded conflicts. Call this at the START of work on a topic so you build on " +
      "prior sessions instead of starting cold. Filter by scope to stay in one project.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "Limit to one scope/project." },
        kind: {
          type: "string",
          enum: ["claims", "questions", "conflicts"],
          description: "What to recall. Default: claims.",
        },
        key: {
          type: "string",
          description: "Optional canonical_form to filter claims to a single subject.",
        },
      },
    },
  },
  {
    name: "spine_ask",
    description:
      "Record an open question — something unresolved that a future session should " +
      "pick up. Questions are stored rows, not absent answers, so they survive the session.",
    inputSchema: {
      type: "object",
      properties: {
        statement: { type: "string", description: "The open question." },
        scope: { type: "string", description: "Scope/namespace. Default: trident." },
      },
      required: ["statement"],
    },
  },
  {
    name: "spine_history",
    description:
      "Show a claim's lineage (what it superseded), the conflicts it's involved in, " +
      "and the questions it answers. Use it to explain why Trident believes something.",
    inputSchema: {
      type: "object",
      properties: {
        claim_id: { type: "string", description: "The claim id, e.g. clm_ab12cd34ef56." },
      },
      required: ["claim_id"],
    },
  },
];

const DEFAULT_SCOPE = "trident";

export async function handleSpineTool(name: string, args: Record<string, unknown>): Promise<string> {
  const spine = createSpine();
  const scope = (args.scope as string) || DEFAULT_SCOPE;

  switch (name) {
    case "spine_check": {
      const { conflicts } = spine.check({
        statement: args.statement as string,
        canonical_form: args.canonical_form as string | undefined,
        scope,
      });
      return JSON.stringify(
        {
          conflicts: conflicts.map((c) => ({
            claim_id: c.claim.id,
            statement: c.claim.statement,
            canonical_form: c.claim.canonical_form,
            locked: c.locked,
            reason: c.reason,
          })),
          would_raise: conflicts.some((c) => c.locked),
          note:
            conflicts.length === 0
              ? "No conflicts. Nothing was written."
              : "Dry run — nothing written. Spine does not resolve conflicts.",
        },
        null,
        2
      );
    }

    case "spine_assert": {
      try {
        const { claim, conflicts } = spine.assert({
          statement: args.statement as string,
          canonical_form: args.canonical_form as string | undefined,
          scope,
          supersedes: args.supersedes as string | undefined,
          provenance: {
            session_id: (args.session_id as string) ?? "mcp",
            models_consulted: (args.models_consulted as string[]) ?? [],
            verdict: (args.verdict as string) ?? null,
            confidence: typeof args.confidence === "number" ? (args.confidence as number) : null,
            raw_response_ref: (args.raw_response_ref as string) ?? null,
          },
        });
        return JSON.stringify(
          {
            claim_id: claim.id,
            statement: claim.statement,
            canonical_form: claim.canonical_form,
            scope: claim.scope,
            status: claim.status,
            conflicts: conflicts.map((c) => ({ conflict_id: c.id, with_claim: c.claim_a, reason: c.reason })),
            note: conflicts.length
              ? "Conflicts were RECORDED, not resolved. Both claims remain live — surface this to the user."
              : "Stored with no conflicts.",
          },
          null,
          2
        );
      } catch (err) {
        if (err instanceof InvariantViolationError) {
          return JSON.stringify(
            {
              error: "invariant_violation",
              message: err.message,
              invariant: {
                claim_id: err.invariant.id,
                statement: err.invariant.statement,
                canonical_form: err.invariant.canonical_form,
              },
              written: false,
              note:
                "Nothing was written and the invariant is unchanged. Do not retry or work around this — " +
                "tell the user their claim contradicts a locked invariant and let them decide.",
            },
            null,
            2
          );
        }
        throw err;
      }
    }

    case "spine_recall": {
      const kind = (args.kind as string) || "claims";
      if (kind === "questions") {
        const qs = spine.openQuestions(args.scope as string | undefined);
        return JSON.stringify({ open_questions: qs }, null, 2);
      }
      if (kind === "conflicts") {
        const cs = spine.conflicts(args.scope as string | undefined);
        return JSON.stringify({ conflicts: cs, note: "Unresolved by design." }, null, 2);
      }
      let claims = spine.listClaims(args.scope as string | undefined);
      if (args.key) claims = claims.filter((c) => c.canonical_form === args.key);
      return JSON.stringify(
        {
          claims: claims.map((c) => ({
            claim_id: c.id,
            statement: c.statement,
            canonical_form: c.canonical_form,
            scope: c.scope,
            status: c.status,
            locked: c.locked,
            provenance: c.provenance,
          })),
        },
        null,
        2
      );
    }

    case "spine_ask": {
      const q = spine.ask({ statement: args.statement as string, scope });
      return JSON.stringify({ question_id: q.id, statement: q.statement, scope: q.scope, status: "open" }, null, 2);
    }

    case "spine_history": {
      const h = spine.history(args.claim_id as string);
      return JSON.stringify(
        {
          claim: { claim_id: h.claim.id, statement: h.claim.statement, status: h.claim.status, locked: h.claim.locked },
          lineage: h.lineage.map((c) => ({ claim_id: c.id, statement: c.statement, status: c.status })),
          conflicts: h.conflicts,
          answers_questions: h.answers,
        },
        null,
        2
      );
    }

    default:
      throw new Error(`Unknown spine tool: ${name}`);
  }
}
