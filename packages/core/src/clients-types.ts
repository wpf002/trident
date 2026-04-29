// Shared type-only declarations to avoid circular imports between
// clients.ts (runtime, depends on models.ts) and models.ts (compile-time
// type reference).

export type AIName = "claude" | "gpt" | "perplexity";

export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface AIResponse {
  ai: AIName;
  content: string;
  error?: string;
  duration_ms: number;
  model?: string;
  usage?: TokenUsage;
}
