export interface SessionResponse {
  ai: string;
  content: string;
  error?: string;
  duration_ms: number;
  started_at: string;
  finished_at: string;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
  citations?: string[];
}

export interface SessionRun {
  id: string;
  mode: "parallel" | "chain";
  prompt: string;
  project: string | null;
  ais: string[];
  responses: SessionResponse[];
  duration_ms: number;
  preset: string | null;
  system_prompt: string | null;
  metadata: Record<string, unknown> | null;
  started_at: string;
  finished_at: string;
  created_at: string;
}

export type AIName = "claude" | "gpt" | "perplexity";

export const AI_LABELS: Record<string, string> = {
  claude: "Claude",
  gpt: "ChatGPT",
  perplexity: "Perplexity",
};

export function aiLabel(ai: string): string {
  return AI_LABELS[ai] ?? ai.toUpperCase();
}
