import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { modelFor, ModelTier } from "./models.js";
import type { AIMessage, AIName, AIResponse } from "./clients-types.js";

export type { AIMessage, AIName, AIResponse } from "./clients-types.js";
export type { ModelTier } from "./models.js";

export const VALID_AIS: ReadonlySet<AIName> = new Set<AIName>(["claude", "gpt", "perplexity"]);
export const DEFAULT_ORDER: AIName[] = ["claude", "gpt", "perplexity"];
export const AI_LABELS: Record<AIName, string> = {
  claude: "Claude",
  gpt: "ChatGPT",
  perplexity: "Perplexity",
};

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
  /** Override max output tokens. Default: 4096 (256 for utility). */
  maxTokens?: number;
}

/** Back-compat alias — older code passed only `{ tokens, signal }`. */
export type StreamOptions = CallOptions;

function resolveModel(ai: AIName, opts: CallOptions | undefined): string {
  if (opts?.model && opts.model.trim().length > 0) return opts.model;
  return modelFor(ai, opts?.tier ?? "main");
}

function defaultMaxTokens(opts: CallOptions | undefined): number {
  if (typeof opts?.maxTokens === "number" && opts.maxTokens > 0) return opts.maxTokens;
  return opts?.tier === "utility" ? 1024 : 4096;
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
  const max_tokens = defaultMaxTokens(options);
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
      await streamResp.finalMessage();
      return { ai: "claude", content: collected, duration_ms: Date.now() - start };
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

    return { ai: "claude", content: text, duration_ms: Date.now() - start };
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
  const max_tokens = defaultMaxTokens(options);

  try {
    const client = new OpenAI({ apiKey, baseURL });
    const all: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (systemPrompt) all.push({ role: "system", content: systemPrompt });
    for (const m of messages) all.push({ role: m.role, content: m.content });

    if (options?.tokens) {
      const streamResp = await client.chat.completions.create({
        model,
        max_tokens,
        messages: all,
        stream: true,
      });
      let collected = "";
      for await (const chunk of streamResp) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) {
          collected += delta;
          options.tokens(delta);
        }
      }
      return { ai, content: collected, duration_ms: Date.now() - start };
    }

    const response = await client.chat.completions.create({
      model,
      max_tokens,
      messages: all,
    });
    return {
      ai,
      content: response.choices[0]?.message?.content ?? "",
      duration_ms: Date.now() - start,
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

export const AI_MAP: Record<
  AIName,
  (m: AIMessage[], s?: string, opts?: CallOptions) => Promise<AIResponse>
> = {
  claude: callClaude,
  gpt: callGPT,
  perplexity: callPerplexity,
};
