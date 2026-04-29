export const searchTools = [
  {
    name: "web_search",
    description:
      "Search the web for current information using Tavily. Returns summarized results with sources. Use for news, live data, research, and anything that may have changed recently.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        max_results: {
          type: "number",
          description: "Max number of results to return (default: 5, max: 10)",
        },
        search_depth: {
          type: "string",
          enum: ["basic", "advanced"],
          description:
            "Search depth. 'basic' is faster, 'advanced' digs deeper (default: basic)",
        },
        include_domains: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of domains to restrict search to",
        },
      },
      required: ["query"],
    },
  },
];

export async function handleSearchTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  if (name !== "web_search") {
    throw new Error(`Unknown search tool: ${name}`);
  }

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return JSON.stringify({
      error:
        "TAVILY_API_KEY not set. Add it to your .env file to enable web search.",
    });
  }

  const query = args.query as string;
  const maxResults = (args.max_results as number | undefined) ?? 5;
  const searchDepth =
    (args.search_depth as "basic" | "advanced" | undefined) ?? "basic";
  const includeDomains = args.include_domains as string[] | undefined;

  const body: Record<string, unknown> = {
    query,
    max_results: Math.min(maxResults, 10),
    search_depth: searchDepth,
    include_answer: true,
    include_raw_content: false,
  };

  if (includeDomains && includeDomains.length > 0) {
    body.include_domains = includeDomains;
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return JSON.stringify({ error: `Tavily API error: ${errorText}` });
  }

  const data = (await response.json()) as {
    answer?: string;
    results: Array<{
      title: string;
      url: string;
      content: string;
      score: number;
      published_date?: string;
    }>;
  };

  return JSON.stringify({
    answer: data.answer,
    results: data.results.map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score,
      published_date: r.published_date,
    })),
  });
}
