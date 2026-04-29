import { callClaude } from "./clients.js";
import { SessionRunResponse } from "./db.js";

const AI_LABELS: Record<string, string> = {
  claude: "Claude",
  gpt: "ChatGPT",
  perplexity: "Perplexity",
};

function aiLabel(ai: string): string {
  return AI_LABELS[ai] ?? ai.toUpperCase();
}

function formatResponsesForSynthesis(prompt: string, responses: SessionRunResponse[]): string {
  const sections = responses.map((r, i) => {
    if (r.error) {
      return `### Response ${i + 1} — ${aiLabel(r.ai)} (errored)\n\n[Error: ${r.error}]`;
    }
    return `### Response ${i + 1} — ${aiLabel(r.ai)}\n\n${r.content}`;
  });

  return [
    `The user asked the following prompt to multiple AIs in parallel:`,
    "",
    `> ${prompt.replace(/\n/g, "\n> ")}`,
    "",
    `Here are their responses:`,
    "",
    ...sections,
  ].join("\n");
}

const DIFF_SYSTEM_PROMPT = `You are an analyst comparing multiple AI responses to the same prompt. Produce a structured comparison with three sections, in this order, using these exact markdown headings:

## Agreement
Bullet points covering substantive claims, facts, or recommendations all responses share.

## Disagreement
Bullet points covering points where the responses differ in conclusions, emphasis, or recommendations. Identify *which AI* says what.

## Factual Conflicts
Bullet points flagging any claims that directly contradict each other (one AI says X, another says not-X) or that look factually incorrect. If you cannot verify a claim, mark it as "unverifiable" rather than guessing. If there are no factual conflicts, write "None identified."

Be concise and concrete. Do not include any other sections, preamble, or postscript.`;

export async function runDiffSynthesis(
  prompt: string,
  responses: SessionRunResponse[]
): Promise<{ content: string; error?: string; duration_ms: number }> {
  const usable = responses.filter((r) => !r.error && r.content.trim().length > 0);
  if (usable.length < 2) {
    return {
      content: "",
      error: "Need at least 2 successful responses to synthesize a diff.",
      duration_ms: 0,
    };
  }

  const userMessage = formatResponsesForSynthesis(prompt, responses);
  const start = Date.now();
  const result = await callClaude(
    [{ role: "user", content: userMessage }],
    DIFF_SYSTEM_PROMPT,
    { tier: "utility" }
  );
  return {
    content: result.content,
    error: result.error,
    duration_ms: Date.now() - start,
  };
}

// ─── Confidence scoring ──────────────────────────────────────────────────────

const CONFIDENCE_SYSTEM_PROMPT = `You are evaluating multiple AI responses to a single prompt. Return ONLY a JSON object — no markdown, no explanation, no fences — with exactly this shape:

{
  "scores": [
    { "ai": "<ai name as given>", "confidence": <0-100 integer>, "rationale": "<one sentence>" }
  ],
  "agreement": "low" | "medium" | "high",
  "consensus": ["<short bullet>", "..."],
  "disagreement": ["<short bullet>", "..."]
}

Rules:
- "scores" must include one entry per response, in the same order they were given.
- "confidence" reflects how well-supported, specific, and accurate the response appears (0 = clearly unreliable, 100 = clearly authoritative).
- "agreement" reflects how aligned the responses are with each other overall.
- "consensus" lists 1-5 bullets the responses share. "disagreement" lists 1-5 bullets where they differ. Either may be empty.
- Do not invent AI names; use the names exactly as given.`;

export interface ConfidenceScore {
  ai: string;
  confidence: number;
  rationale: string;
}

export interface ConfidenceReport {
  scores: ConfidenceScore[];
  agreement: "low" | "medium" | "high";
  consensus: string[];
  disagreement: string[];
}

function parseConfidenceReport(raw: string): ConfidenceReport {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  const parsed = JSON.parse(text) as Partial<ConfidenceReport>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Confidence report is not an object");
  }
  if (!Array.isArray(parsed.scores)) {
    throw new Error("Confidence report missing 'scores' array");
  }
  if (parsed.agreement !== "low" && parsed.agreement !== "medium" && parsed.agreement !== "high") {
    throw new Error(`Invalid agreement value: ${String(parsed.agreement)}`);
  }
  const scores = parsed.scores.map((s, i) => {
    if (!s || typeof s !== "object") throw new Error(`scores[${i}] is not an object`);
    const ai = (s as ConfidenceScore).ai;
    const confidence = (s as ConfidenceScore).confidence;
    const rationale = (s as ConfidenceScore).rationale;
    if (typeof ai !== "string") throw new Error(`scores[${i}].ai must be a string`);
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
      throw new Error(`scores[${i}].confidence must be a number`);
    }
    if (typeof rationale !== "string") throw new Error(`scores[${i}].rationale must be a string`);
    return {
      ai,
      confidence: Math.max(0, Math.min(100, Math.round(confidence))),
      rationale,
    };
  });
  const consensus = Array.isArray(parsed.consensus)
    ? parsed.consensus.filter((c): c is string => typeof c === "string")
    : [];
  const disagreement = Array.isArray(parsed.disagreement)
    ? parsed.disagreement.filter((c): c is string => typeof c === "string")
    : [];
  return { scores, agreement: parsed.agreement, consensus, disagreement };
}

export async function runConfidenceScoring(
  prompt: string,
  responses: SessionRunResponse[]
): Promise<{ report?: ConfidenceReport; error?: string; duration_ms: number; raw?: string }> {
  const usable = responses.filter((r) => !r.error && r.content.trim().length > 0);
  if (usable.length < 2) {
    return { error: "Need at least 2 successful responses to score.", duration_ms: 0 };
  }

  const userMessage = formatResponsesForSynthesis(prompt, responses);
  const start = Date.now();
  const result = await callClaude(
    [{ role: "user", content: userMessage }],
    CONFIDENCE_SYSTEM_PROMPT,
    { tier: "utility" }
  );
  const duration = Date.now() - start;

  if (result.error) {
    return { error: result.error, duration_ms: duration };
  }

  try {
    const report = parseConfidenceReport(result.content);
    return { report, duration_ms: duration, raw: result.content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `Failed to parse confidence report: ${message}`,
      duration_ms: duration,
      raw: result.content,
    };
  }
}
