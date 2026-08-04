import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { modelFor, ModelTier } from "./models.js";
import type { AIMessage, AIName, AIResponse } from "./clients-types.js";

export type { AIMessage, AIName, AIResponse } from "./clients-types.js";
export type { ModelTier } from "./models.js";

export const VALID_AIS: ReadonlySet<AIName> = new Set<AIName>(["claude", "gpt", "perplexity", "gemini"]);
export const DEFAULT_ORDER: AIName[] = ["claude", "gpt", "perplexity", "gemini"];
export const AI_LABELS: Record<AIName, string> = {
  claude: "Claude",
  gpt: "ChatGPT",
  perplexity: "Perplexity",
  gemini: "Gemini",
};

/** Human label for an AI name, falling back to upper-case for unknown values. */
export function aiLabel(ai: string): string {
  return (AI_LABELS as Record<string, string>)[ai] ?? ai.toUpperCase();
}

// ─── Call options ────────────────────────────────────────────────────────────

export interface CallOptions {
  /** Streams text chunks as they arrive. When omitted, the call is non-streaming. */
  tokens?: (chunk: string) => void;
  /** Aborts the call when the signal fires. */
  signal?: AbortSignal;
  /** Choose a model tier (utility / main / premium). Default: "main". */
  tier?: ModelTier;
  /** Override the resolved model name entirely. Wins over `tier`. */
  model?: string;
  /**
   * Override max output tokens. When unset, defaults to a generous per-tier
   * value (see resolveMaxTokens) so long answers aren't truncated mid-sentence.
   * Set TRIDENT_MAX_OUTPUT_TOKENS to change the global default.
   */
  maxTokens?: number;
}

// Per-provider hard ceiling on output tokens. Requests are clamped to these so
// a high default/override never trips a provider "max_tokens too large" error.
// Conservative values that current flagship models all support.
const MAX_OUTPUT_TOKENS: Record<AIName, number> = {
  claude: 16384,
  gpt: 16384,
  perplexity: 8192,
  gemini: 16384,
};

/** Back-compat alias — older code passed only `{ tokens, signal }`. */
export type StreamOptions = CallOptions;

function resolveModel(ai: AIName, opts: CallOptions | undefined): string {
  if (opts?.model && opts.model.trim().length > 0) return opts.model;
  return modelFor(ai, opts?.tier ?? "main");
}

function resolveMaxTokens(ai: AIName, opts: CallOptions | undefined): number {
  let n: number;
  if (typeof opts?.maxTokens === "number" && opts.maxTokens > 0) {
    // Explicit per-call override wins.
    n = opts.maxTokens;
  } else {
    const envDefault = Number.parseInt(process.env.TRIDENT_MAX_OUTPUT_TOKENS ?? "", 10);
    if (Number.isFinite(envDefault) && envDefault > 0) {
      n = envDefault;
    } else {
      // Generous defaults so full-length answers don't get cut off. Utility is
      // for internal/structured calls (routing, diff, scoring) — still ample.
      n = opts?.tier === "utility" ? 4096 : 16384;
    }
  }
  // Never exceed what the provider allows.
  return Math.min(n, MAX_OUTPUT_TOKENS[ai]);
}

// Pull source URLs out of a provider response/chunk. Perplexity returns a
// non-standard top-level `citations: string[]` (older) or `search_results:
// [{url}]` (newer); other providers return neither.
function extractCitations(obj: unknown): string[] | undefined {
  const o = obj as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return undefined;
  if (Array.isArray(o.citations)) {
    const urls = o.citations.filter((c): c is string => typeof c === "string");
    if (urls.length) return urls;
  }
  if (Array.isArray(o.search_results)) {
    const urls = (o.search_results as unknown[])
      .map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>).url : undefined))
      .filter((u): u is string => typeof u === "string");
    if (urls.length) return urls;
  }
  return undefined;
}

// ─── Claude ──────────────────────────────────────────────────────────────────

export async function callClaude(
  messages: AIMessage[],
  systemPrompt?: string,
  options?: CallOptions
): Promise<AIResponse> {
  const start = Date.now();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ai: "claude", content: "", error: "ANTHROPIC_API_KEY not set", duration_ms: 0 };
  }

  const model = resolveModel("claude", options);
  const max_tokens = resolveMaxTokens("claude", options);
  const apiMessages = messages.map((m) => ({ role: m.role, content: m.content }));

  try {
    const client = new Anthropic({ apiKey });
    if (options?.tokens) {
      let collected = "";
      const streamResp = client.messages.stream({
        model,
        max_tokens,
        system: systemPrompt,
        messages: apiMessages,
      });
      streamResp.on("text", (delta: string) => {
        collected += delta;
        options.tokens!(delta);
      });
      const final = await streamResp.finalMessage();
      return {
        ai: "claude",
        content: collected,
        duration_ms: Date.now() - start,
        model,
        usage: final.usage
          ? { input_tokens: final.usage.input_tokens, output_tokens: final.usage.output_tokens }
          : undefined,
      };
    }

    const response = await client.messages.create({
      model,
      max_tokens,
      system: systemPrompt,
      messages: apiMessages,
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n");

    return {
      ai: "claude",
      content: text,
      duration_ms: Date.now() - start,
      model,
      usage: response.usage
        ? { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens }
        : undefined,
    };
  } catch (err) {
    return {
      ai: "claude",
      content: "",
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - start,
    };
  }
}

// ─── OpenAI-compatible (GPT, Perplexity) ─────────────────────────────────────

async function callOpenAICompatible(
  ai: AIName,
  baseURL: string | undefined,
  apiKeyEnv: string,
  messages: AIMessage[],
  systemPrompt?: string,
  options?: CallOptions
): Promise<AIResponse> {
  const start = Date.now();
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    return { ai, content: "", error: `${apiKeyEnv} not set`, duration_ms: 0 };
  }

  const model = resolveModel(ai, options);
  const max_tokens = resolveMaxTokens(ai, options);

  try {
    const client = new OpenAI({ apiKey, baseURL });
    const all: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (systemPrompt) all.push({ role: "system", content: systemPrompt });
    for (const m of messages) all.push({ role: m.role, content: m.content });

    // Perplexity's streaming API (notably `sonar-pro`) drops structural
    // newlines and spaces at markdown boundaries — headings glue to body text
    // ("personasFrom"), `##` loses its space ("##1."), and list items run
    // together ("cattle- **Arrival"). The NON-streaming response is clean, so
    // we always fetch Perplexity whole and hand the UI the full text in a
    // single token() call (same code path, just no incremental reveal).
    const canStream = Boolean(options?.tokens) && ai !== "perplexity";

    if (canStream) {
      const streamResp = await client.chat.completions.create({
        model,
        max_tokens,
        messages: all,
        stream: true,
        // Most OpenAI-compatible providers (incl. OpenAI + Perplexity) honor
        // this and append a `.usage` object to the final chunk.
        stream_options: { include_usage: true },
      });
      let collected = "";
      let usage: { input_tokens: number; output_tokens: number } | undefined;
      let citations: string[] | undefined;
      for await (const chunk of streamResp) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) {
          collected += delta;
          options?.tokens?.(delta);
        }
        if (chunk.usage) {
          usage = {
            input_tokens: chunk.usage.prompt_tokens,
            output_tokens: chunk.usage.completion_tokens,
          };
        }
        // Perplexity attaches `citations` (a non-standard top-level field) to
        // its stream chunks; keep the latest non-empty list.
        const c = extractCitations(chunk);
        if (c) citations = c;
      }
      return { ai, content: collected, duration_ms: Date.now() - start, model, usage, citations };
    }

    const response = await client.chat.completions.create({
      model,
      max_tokens,
      messages: all,
    });
    const content = response.choices[0]?.message?.content ?? "";
    // When a token callback was supplied but we deliberately skipped streaming
    // (Perplexity), still feed the UI through the same path by emitting the
    // whole clean response as one delta.
    if (options?.tokens && content) options.tokens(content);
    return {
      ai,
      content,
      duration_ms: Date.now() - start,
      model,
      citations: extractCitations(response),
      usage: response.usage
        ? { input_tokens: response.usage.prompt_tokens, output_tokens: response.usage.completion_tokens }
        : undefined,
    };
  } catch (err) {
    return {
      ai,
      content: "",
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - start,
    };
  }
}

export const callGPT = (m: AIMessage[], s?: string, opts?: CallOptions) =>
  callOpenAICompatible("gpt", undefined, "OPENAI_API_KEY", m, s, opts);

export const callPerplexity = (m: AIMessage[], s?: string, opts?: CallOptions) =>
  callOpenAICompatible("perplexity", "https://api.perplexity.ai", "PERPLEXITY_API_KEY", m, s, opts);

// Gemini speaks an OpenAI-compatible dialect at this base URL, so it rides the
// same client as GPT/Perplexity — no separate SDK. Set GEMINI_API_KEY.
export const callGemini = (m: AIMessage[], s?: string, opts?: CallOptions) =>
  callOpenAICompatible(
    "gemini",
    "https://generativelanguage.googleapis.com/v1beta/openai",
    "GEMINI_API_KEY",
    m,
    s,
    opts
  );

export const AI_MAP: Record<
  AIName,
  (m: AIMessage[], s?: string, opts?: CallOptions) => Promise<AIResponse>
> = {
  claude: callClaude,
  gpt: callGPT,
  perplexity: callPerplexity,
  gemini: callGemini,
};
