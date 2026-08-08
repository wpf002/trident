import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { captureBacklog, captureSessionRun } from "./capture.js";
import { migrate } from "./schema.js";

// Phase 1 exit criterion: every parallel Trident run produces a Query and
// ModelResponse rows. Plus §9: capture can never break a Trident write.

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE session_runs (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL, prompt TEXT NOT NULL, project TEXT,
      ais TEXT NOT NULL, responses TEXT, duration_ms INTEGER NOT NULL DEFAULT 0,
      preset TEXT, system_prompt TEXT, metadata TEXT,
      started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  migrate(d);
  return d;
}

const resp = (ai: string, content: string, over: Record<string, unknown> = {}) => ({
  ai,
  content,
  duration_ms: 100,
  started_at: "2026-03-01T12:00:00Z",
  finished_at: "2026-03-01T12:00:01Z",
  model: `${ai}-model`,
  usage: { input_tokens: 10, output_tokens: 20 },
  ...over,
});

const run = (over: Record<string, unknown> = {}) =>
  ({
    id: "sesn_1",
    mode: "parallel" as const,
    prompt: "who wins race 4",
    project: null,
    ais: ["claude", "gpt", "perplexity", "gemini"],
    responses: [resp("claude", "Alpha"), resp("gpt", "Alpha"), resp("perplexity", "Beta"), resp("gemini", "Alpha")],
    duration_ms: 1000,
    preset: null,
    system_prompt: "be terse",
    metadata: null,
    started_at: "2026-03-01T12:00:00Z",
    finished_at: "2026-03-01T12:00:05Z",
    ...over,
  }) as never;

describe("capture — Phase 1 exit criterion", () => {
  it("a parallel run produces a Query and ModelResponse rows", () => {
    const d = db();
    const res = captureSessionRun(d, run());

    expect(res.captured).toBe(true);
    expect(res.nResponses).toBe(4);

    const q = d.prepare("SELECT * FROM rift_queries WHERE session_id='sesn_1'").get() as Record<string, unknown>;
    expect(q).toBeTruthy();
    expect(q.isolation_verified).toBe(1); // §3 independence verified from mode
    expect(q.exclusion_reason).toBeNull(); // in the study set
    expect(q.prompt).toBe("who wins race 4");

    const rs = d.prepare("SELECT * FROM rift_model_responses WHERE query_id=?").all(q.id) as Record<
      string,
      unknown
    >[];
    expect(rs).toHaveLength(4);
    expect(rs.map((r) => r.model).sort()).toEqual([
      "claude-model",
      "gemini-model",
      "gpt-model",
      "perplexity-model",
    ]);
  });

  it("records held-fixed conditions identically across models", () => {
    const d = db();
    captureSessionRun(d, run());
    const rs = d.prepare("SELECT prompt_hash, system_prompt_hash, sampling_params FROM rift_model_responses").all() as {
      prompt_hash: string;
      system_prompt_hash: string;
      sampling_params: string;
    }[];

    expect(new Set(rs.map((r) => r.prompt_hash)).size).toBe(1);
    expect(new Set(rs.map((r) => r.system_prompt_hash)).size).toBe(1);
    expect(new Set(rs.map((r) => r.sampling_params)).size).toBe(1);
    expect(rs[0].sampling_params).toBe("{}"); // Trident sets none
  });

  it("captures token cost and latency for the zero-added-cost audit", () => {
    const d = db();
    captureSessionRun(d, run());
    const r = d.prepare("SELECT token_cost, latency_ms FROM rift_model_responses LIMIT 1").get() as {
      token_cost: number;
      latency_ms: number;
    };
    expect(r.token_cost).toBe(30);
    expect(r.latency_ms).toBe(100);
  });
});

describe("capture — isolation and exclusion", () => {
  it("marks a chained run excluded rather than dropping it", () => {
    const d = db();
    const res = captureSessionRun(d, run({ id: "sesn_chain", mode: "chain" }));

    expect(res.captured).toBe(true); // recorded, not discarded
    expect(res.exclusionReason).toBe("CHAINED");

    const q = d.prepare("SELECT * FROM rift_queries WHERE session_id='sesn_chain'").get() as Record<
      string,
      unknown
    >;
    expect(q.isolation_verified).toBe(0);
    expect(q.exclusion_reason).toBe("CHAINED");
  });

  it("excludes a run where a model errored", () => {
    const d = db();
    const res = captureSessionRun(
      d,
      run({
        id: "sesn_err",
        responses: [resp("claude", "A"), resp("gpt", "A"), resp("perplexity", "", { error: "429" }), resp("gemini", "B")],
      })
    );
    expect(res.exclusionReason).toBe("RESPONSE_ERROR");
  });

  it("excludes a run below the participant floor", () => {
    const d = db();
    const res = captureSessionRun(
      d,
      run({ id: "sesn_two", responses: [resp("claude", "A"), resp("gpt", "B")] })
    );
    expect(res.exclusionReason).toBe("INSUFFICIENT_PARTICIPANTS");
  });
});

describe("capture — tagging", () => {
  it("honours an explicit rift tag in metadata", () => {
    const d = db();
    captureSessionRun(
      d,
      run({
        id: "sesn_tag",
        metadata: {
          source: "ui",
          rift: { domain: "RACING", answerType: "CATEGORICAL", resolvesAfter: "2026-03-02T00:00:00Z" },
        },
      })
    );
    const q = d.prepare("SELECT * FROM rift_queries WHERE session_id='sesn_tag'").get() as Record<string, unknown>;
    expect(q.domain).toBe("RACING");
    expect(q.answer_type).toBe("CATEGORICAL");
    expect(q.resolves_after).toBe("2026-03-02T00:00:00Z");
  });

  it("defaults to GENERAL/OPEN rather than inferring — inference would cost a model call", () => {
    const d = db();
    captureSessionRun(d, run({ id: "sesn_untagged" }));
    const q = d.prepare("SELECT * FROM rift_queries WHERE session_id='sesn_untagged'").get() as Record<
      string,
      unknown
    >;
    expect(q.domain).toBe("GENERAL");
    expect(q.answer_type).toBe("OPEN");
    expect(q.resolves_after).toBeNull();
  });

  it("respects an explicit unstudyable flag", () => {
    const d = db();
    const res = captureSessionRun(d, run({ id: "sesn_uns", metadata: { rift: { studyable: false } } }));
    expect(res.exclusionReason).toBe("UNSTUDYABLE");
  });
});

describe("capture — judge confidence is stored separately from self-report", () => {
  it("stores judge scores in judge_confidence, never stated_confidence", () => {
    const d = db();
    captureSessionRun(
      d,
      run({
        id: "sesn_conf",
        metadata: {
          confidence: {
            scores: [
              { ai: "claude", confidence: 80, rationale: "x" },
              { ai: "gpt", confidence: 60, rationale: "y" },
            ],
            agreement: "medium",
            consensus: [],
            disagreement: [],
          },
        },
      })
    );

    const rows = d
      .prepare("SELECT model, stated_confidence, judge_confidence, judge_model FROM rift_model_responses")
      .all() as { model: string; stated_confidence: number | null; judge_confidence: number | null; judge_model: string | null }[];

    // Self-report is never populated from a judge pass.
    expect(rows.every((r) => r.stated_confidence === null)).toBe(true);

    const claude = rows.find((r) => r.model === "claude-model")!;
    expect(claude.judge_confidence).toBe(80);
    expect(claude.judge_model).toBeTruthy(); // circularity is auditable per row

    // Models the judge didn't score stay null rather than being invented.
    expect(rows.find((r) => r.model === "gemini-model")!.judge_confidence).toBeNull();
  });
});

describe("capture — idempotency", () => {
  it("re-capturing the same session is a no-op", () => {
    const d = db();
    expect(captureSessionRun(d, run()).captured).toBe(true);
    const second = captureSessionRun(d, run());

    expect(second.captured).toBe(false);
    expect(second.skipped).toBe("ALREADY_CAPTURED");
    expect(d.prepare("SELECT COUNT(*) c FROM rift_queries").get()).toEqual({ c: 1 });
    expect(d.prepare("SELECT COUNT(*) c FROM rift_model_responses").get()).toEqual({ c: 4 });
  });

  it("the unique index makes double-capture impossible even under a race", () => {
    const d = db();
    captureSessionRun(d, run());
    expect(() =>
      d
        .prepare(
          `INSERT INTO rift_queries (id, session_id, domain, answer_type, prompt, asked_at)
           VALUES ('qry_other','sesn_1','GENERAL','OPEN','p','2026-03-01T12:00:00Z')`
        )
        .run()
    ).toThrow();
  });
});

describe("capture — backlog sweep", () => {
  it("captures sessions recorded before Rift existed", () => {
    const d = db();
    const ins = d.prepare(
      `INSERT INTO session_runs (id, mode, prompt, ais, responses, started_at, finished_at)
       VALUES (?,?,?,?,?,?,?)`
    );
    for (let i = 0; i < 3; i++) {
      ins.run(
        `sesn_old_${i}`,
        "parallel",
        `q${i}`,
        JSON.stringify(["claude", "gpt", "perplexity"]),
        JSON.stringify([resp("claude", "A"), resp("gpt", "A"), resp("perplexity", "B")]),
        "2026-03-01T12:00:00Z",
        "2026-03-01T12:00:05Z"
      );
    }

    const sweep = captureBacklog(d);
    expect(sweep.scanned).toBe(3);
    expect(sweep.captured).toBe(3);
    expect(d.prepare("SELECT COUNT(*) c FROM rift_queries").get()).toEqual({ c: 3 });
  });

  it("is idempotent — a second sweep finds nothing", () => {
    const d = db();
    d.prepare(
      `INSERT INTO session_runs (id, mode, prompt, ais, responses, started_at, finished_at)
       VALUES ('s1','parallel','q',?,?,'2026-03-01T12:00:00Z','2026-03-01T12:00:05Z')`
    ).run(JSON.stringify(["claude"]), JSON.stringify([resp("claude", "A")]));

    expect(captureBacklog(d).captured).toBe(1);
    expect(captureBacklog(d)).toEqual({ scanned: 0, captured: 0, alreadyCaptured: 0 });
  });

  it("a malformed historical row does not stop the sweep", () => {
    const d = db();
    const ins = d.prepare(
      `INSERT INTO session_runs (id, mode, prompt, ais, responses, started_at, finished_at)
       VALUES (?,?,?,?,?,?,?)`
    );
    ins.run("s_bad", "parallel", "q", "not-json{{", "also-not-json", "2026-03-01T12:00:00Z", "2026-03-01T12:00:05Z");
    ins.run(
      "s_good",
      "parallel",
      "q",
      JSON.stringify(["claude"]),
      JSON.stringify([resp("claude", "A")]),
      "2026-03-01T12:00:00Z",
      "2026-03-01T12:00:05Z"
    );

    const sweep = captureBacklog(d);
    expect(sweep.scanned).toBe(2);
    expect(sweep.captured).toBe(1); // the good one still lands
  });
});
