export const perplexityTools = [
  {
    name: "perplexity_search",
    description:
      "Run a query against the Perplexity online model (llama-3.1-sonar-large-128k-online). " +
      "Use this when you (Claude or ChatGPT) need live, web-grounded information with citations. " +
      "Returns the assistant's response text plus any citations Perplexity surfaced.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The user-facing question or research prompt to send to Perplexity.",
        },
        system: {
          type: "string",
          description:
            "Optional system prompt that steers Perplexity's response (tone, focus, output format).",
        },
        max_tokens: {
          type: "number",
          description: "Optional cap on response length (default: 2048, max: 4096).",
        },
      },
      required: ["query"],
    },
  },
];

interface PerplexityResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  citations?: string[];
  error?: { message?: string };
}

export async function handlePerplexityTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  if (name !== "perplexity_search") {
    throw new Error(`Unknown perplexity tool: ${name}`);
  }

  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    return JSON.stringify({
      error:
        "PERPLEXITY_API_KEY not set. Add it to your .env file to enable perplexity_search.",
    });
  }

  const query = args.query as string;
  if (!query || typeof query !== "string") {
    return JSON.stringify({ error: "query is required and must be a string" });
  }

  const system = (args.system as string | undefined) ?? undefined;
  const requestedMax = args.max_tokens as number | undefined;
  const maxTokens = Math.min(requestedMax ?? 2048, 4096);

  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: query });

  let response: Response;
  try {
    response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-sonar-large-128k-online",
        messages,
        max_tokens: maxTokens,
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: `Perplexity request failed: ${message}` });
  }

  if (!response.ok) {
    const text = await response.text();
    return JSON.stringify({
      error: `Perplexity API error (${response.status}): ${text}`,
    });
  }

  const data = (await response.json()) as PerplexityResponse;

  if (data.error) {
    return JSON.stringify({ error: data.error.message ?? "Unknown Perplexity error" });
  }

  const content = data.choices?.[0]?.message?.content ?? "";
  const citations = data.citations ?? [];

  return JSON.stringify({
    content,
    citations,
    model: "llama-3.1-sonar-large-128k-online",
  });
}
