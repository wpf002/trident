import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AIResponse {
  ai: string;
  content: string;
  error?: string;
  duration_ms: number;
}

// ─── Claude ──────────────────────────────────────────────────────────────────

export async function callClaude(
  messages: AIMessage[],
  systemPrompt?: string
): Promise<AIResponse> {
  const start = Date.now();
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return {
      ai: "claude",
      content: "",
      error: "ANTHROPIC_API_KEY not set",
      duration_ms: 0,
    };
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    const text =
      response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("\n") ?? "";

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

// ─── GPT ─────────────────────────────────────────────────────────────────────

export async function callGPT(
  messages: AIMessage[],
  systemPrompt?: string
): Promise<AIResponse> {
  const start = Date.now();
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return {
      ai: "gpt",
      content: "",
      error: "OPENAI_API_KEY not set",
      duration_ms: 0,
    };
  }

  try {
    const client = new OpenAI({ apiKey });

    const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (systemPrompt) {
      allMessages.push({ role: "system", content: systemPrompt });
    }
    allMessages.push(
      ...messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }))
    );

    const response = await client.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 4096,
      messages: allMessages,
    });

    const text = response.choices[0]?.message?.content ?? "";
    return { ai: "gpt", content: text, duration_ms: Date.now() - start };
  } catch (err) {
    return {
      ai: "gpt",
      content: "",
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - start,
    };
  }
}

// ─── Perplexity ───────────────────────────────────────────────────────────────
// Perplexity uses an OpenAI-compatible API

export async function callPerplexity(
  messages: AIMessage[],
  systemPrompt?: string
): Promise<AIResponse> {
  const start = Date.now();
  const apiKey = process.env.PERPLEXITY_API_KEY;

  if (!apiKey) {
    return {
      ai: "perplexity",
      content: "",
      error: "PERPLEXITY_API_KEY not set",
      duration_ms: 0,
    };
  }

  try {
    const client = new OpenAI({
      apiKey,
      baseURL: "https://api.perplexity.ai",
    });

    const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (systemPrompt) {
      allMessages.push({ role: "system", content: systemPrompt });
    }
    allMessages.push(
      ...messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }))
    );

    const response = await client.chat.completions.create({
      model: "llama-3.1-sonar-large-128k-online",
      max_tokens: 4096,
      messages: allMessages,
    });

    const text = response.choices[0]?.message?.content ?? "";
    return {
      ai: "perplexity",
      content: text,
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      ai: "perplexity",
      content: "",
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - start,
    };
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export type AIName = "claude" | "gpt" | "perplexity";

export const AI_MAP: Record<
  AIName,
  (messages: AIMessage[], systemPrompt?: string) => Promise<AIResponse>
> = {
  claude: callClaude,
  gpt: callGPT,
  perplexity: callPerplexity,
};

export const DEFAULT_ORDER: AIName[] = ["claude", "gpt", "perplexity"];
