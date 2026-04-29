import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export type AIName = "claude" | "gpt" | "perplexity";

export const VALID_AIS: ReadonlySet<AIName> = new Set<AIName>(["claude", "gpt", "perplexity"]);

export const DEFAULT_ORDER: AIName[] = ["claude", "gpt", "perplexity"];

export const AI_LABELS: Record<AIName, string> = {
  claude: "Claude",
  gpt: "ChatGPT",
  perplexity: "Perplexity",
};

export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AIResponse {
  ai: AIName;
  content: string;
  error?: string;
  duration_ms: number;
}

// ─── Optional streaming hook ─────────────────────────────────────────────────
// Streaming clients accept a `tokens` callback that fires per text chunk. When
// no callback is given, behaves identically to the non-streaming clients.

export interface StreamOptions {
  tokens?: (chunk: string) => void;
  signal?: AbortSignal;
}

// ─── Claude ──────────────────────────────────────────────────────────────────

export async function callClaude(
  messages: AIMessage[],
  systemPrompt?: string,
  stream?: StreamOptions
): Promise<AIResponse> {
  const start = Date.now();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ai: "claude", content: "", error: "ANTHROPIC_API_KEY not set", duration_ms: 0 };
  }

  try {
    const client = new Anthropic({ apiKey });
    if (stream?.tokens) {
      let collected = "";
      const streamResp = client.messages.stream({
        model: "claude-opus-4-5",
        max_tokens: 4096,
        system: systemPrompt,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      });
      streamResp.on("text", (delta: string) => {
        collected += delta;
        stream.tokens!(delta);
      });
      await streamResp.finalMessage();
      return { ai: "claude", content: collected, duration_ms: Date.now() - start };
    }

    const response = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
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
  model: string,
  apiKeyEnv: string,
  messages: AIMessage[],
  systemPrompt?: string,
  stream?: StreamOptions
): Promise<AIResponse> {
  const start = Date.now();
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    return { ai, content: "", error: `${apiKeyEnv} not set`, duration_ms: 0 };
  }
  try {
    const client = new OpenAI({ apiKey, baseURL });
    const all: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (systemPrompt) all.push({ role: "system", content: systemPrompt });
    for (const m of messages) all.push({ role: m.role, content: m.content });

    if (stream?.tokens) {
      const streamResp = await client.chat.completions.create({
        model,
        max_tokens: 4096,
        messages: all,
        stream: true,
      });
      let collected = "";
      for await (const chunk of streamResp) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) {
          collected += delta;
          stream.tokens(delta);
        }
      }
      return { ai, content: collected, duration_ms: Date.now() - start };
    }

    const response = await client.chat.completions.create({
      model,
      max_tokens: 4096,
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

export const callGPT = (m: AIMessage[], s?: string, stream?: StreamOptions) =>
  callOpenAICompatible("gpt", undefined, "gpt-4o", "OPENAI_API_KEY", m, s, stream);

export const callPerplexity = (m: AIMessage[], s?: string, stream?: StreamOptions) =>
  callOpenAICompatible(
    "perplexity",
    "https://api.perplexity.ai",
    "llama-3.1-sonar-large-128k-online",
    "PERPLEXITY_API_KEY",
    m,
    s,
    stream
  );

export const AI_MAP: Record<
  AIName,
  (m: AIMessage[], s?: string, stream?: StreamOptions) => Promise<AIResponse>
> = {
  claude: callClaude,
  gpt: callGPT,
  perplexity: callPerplexity,
};
