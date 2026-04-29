// Allowlist of safe external API base URLs
// Add domains you want to permit. Blocks arbitrary fetching.
const ALLOWED_DOMAINS: string[] = [
  "newsapi.org",
  "api.polygon.io",
  "finnhub.io",
  "api.openweathermap.org",
  "api.exchangerate-api.com",
  "api.coingecko.com",
  "api.github.com",
  "hacker-news.firebaseio.com",
  "api.nytimes.com",
];

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_DOMAINS.some(
      (domain) =>
        parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

export const apiTools = [
  {
    name: "api_fetch",
    description:
      "Fetch data from external APIs. Currently allows: NewsAPI, Polygon.io (stocks), Finnhub, OpenWeatherMap, ExchangeRate-API, CoinGecko, GitHub API, Hacker News, NYTimes API. Returns raw JSON response.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Full URL including query params (e.g. 'https://hacker-news.firebaseio.com/v0/topstories.json')",
        },
        method: {
          type: "string",
          enum: ["GET", "POST"],
          description: "HTTP method (default: GET)",
        },
        headers: {
          type: "object",
          description: "Optional HTTP headers as key-value pairs",
          additionalProperties: { type: "string" },
        },
        body: {
          type: "string",
          description: "Optional JSON body string for POST requests",
        },
      },
      required: ["url"],
    },
  },
];

export async function handleApiTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  if (name !== "api_fetch") {
    throw new Error(`Unknown API tool: ${name}`);
  }

  const url = args.url as string;

  if (!isAllowedUrl(url)) {
    return JSON.stringify({
      error: `Domain not in allowlist. Allowed domains: ${ALLOWED_DOMAINS.join(", ")}. Edit packages/mcp-server/src/tools/api.ts to add more.`,
    });
  }

  const method = (args.method as "GET" | "POST" | undefined) ?? "GET";
  const headers = (args.headers as Record<string, string> | undefined) ?? {};
  const body = args.body as string | undefined;

  const fetchOptions: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  };

  if (method === "POST" && body) {
    fetchOptions.body = body;
  }

  const response = await fetch(url, fetchOptions);
  const text = await response.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  return JSON.stringify({
    status: response.status,
    ok: response.ok,
    data: parsed,
  });
}
