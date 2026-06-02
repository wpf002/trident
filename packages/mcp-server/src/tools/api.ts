import dns from "dns";
import net from "net";

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

const MAX_REDIRECTS = 3;

function hostnameAllowed(hostname: string): boolean {
  return ALLOWED_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );
}

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Only http(s); blocks file:, gopher:, data:, etc.
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    return hostnameAllowed(parsed.hostname);
  } catch {
    return false;
  }
}

// Block addresses that point at the host's own network / cloud metadata.
function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    if (p[0] === 0 || p[0] === 127) return true; // 0.0.0.0/8, loopback
    if (p[0] === 10) return true; // 10/8
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 172.16/12
    if (p[0] === 192 && p[1] === 168) return true; // 192.168/16
    if (p[0] === 169 && p[1] === 254) return true; // link-local + 169.254.169.254 metadata
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT 100.64/10
    return false;
  }
  if (v === 6) {
    const a = ip.toLowerCase();
    if (a === "::1" || a === "::") return true; // loopback / unspecified
    if (a.startsWith("fe80")) return true; // link-local
    if (a.startsWith("fc") || a.startsWith("fd")) return true; // unique-local fc00::/7
    if (a.startsWith("::ffff:")) return isPrivateAddress(a.slice(7)); // IPv4-mapped
    return false;
  }
  return false;
}

// Resolve the hostname and reject if any resolved IP is internal. Defeats
// DNS-rebinding and allowlisted names that point at private space.
async function assertPublicHost(hostname: string): Promise<void> {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error(`blocked private address: ${hostname}`);
    return;
  }
  const addrs = await dns.promises.lookup(hostname, { all: true });
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) {
      throw new Error(`blocked: ${hostname} resolves to private address ${address}`);
    }
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
  const callerHeaders = (args.headers as Record<string, string> | undefined) ?? {};
  const body = args.body as string | undefined;

  // Drop hop-by-hop / spoofable headers; fetch sets Host/Content-Length itself.
  const DISALLOWED = new Set(["host", "content-length", "connection", "transfer-encoding"]);
  const safeHeaders: Record<string, string> = { "Content-Type": "application/json" };
  for (const [k, v] of Object.entries(callerHeaders)) {
    if (!DISALLOWED.has(k.toLowerCase())) safeHeaders[k] = v;
  }

  const fetchOptions: RequestInit = {
    method,
    headers: safeHeaders,
    // Follow redirects manually so each hop is re-validated against the allowlist.
    redirect: "manual",
  };
  if (method === "POST" && body) fetchOptions.body = body;

  let currentUrl = url;
  let response: Response;
  try {
    for (let hop = 0; ; hop++) {
      if (!isAllowedUrl(currentUrl)) {
        return JSON.stringify({
          error: `Domain not in allowlist. Allowed domains: ${ALLOWED_DOMAINS.join(", ")}. Edit packages/mcp-server/src/tools/api.ts to add more.`,
        });
      }
      await assertPublicHost(new URL(currentUrl).hostname);

      response = await fetch(currentUrl, fetchOptions);

      // Manual redirect: re-validate the next URL, cap hop count.
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        if (hop >= MAX_REDIRECTS) {
          return JSON.stringify({ error: `Too many redirects (>${MAX_REDIRECTS}).` });
        }
        currentUrl = new URL(response.headers.get("location")!, currentUrl).toString();
        continue;
      }
      break;
    }
  } catch (err) {
    return JSON.stringify({ error: `Request blocked or failed: ${err instanceof Error ? err.message : String(err)}` });
  }

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
