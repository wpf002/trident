import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AIName, DEFAULT_ORDER } from "./clients.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, "../../../../trident.config.json");

export interface TridentConfig {
  routing: Record<string, AIName[]>;
}

const FALLBACK_CONFIG: TridentConfig = {
  routing: {
    research: ["perplexity", "claude", "gpt"],
    code: ["claude", "gpt", "perplexity"],
    summarize: ["gpt", "claude", "perplexity"],
    default: ["claude", "gpt", "perplexity"],
  },
};

const VALID_AIS: ReadonlySet<string> = new Set(["claude", "gpt", "perplexity"]);

function validateRouting(routing: unknown): Record<string, AIName[]> {
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) {
    throw new Error("routing must be an object mapping mode names to AI arrays");
  }
  const out: Record<string, AIName[]> = {};
  for (const [mode, ais] of Object.entries(routing as Record<string, unknown>)) {
    if (!Array.isArray(ais) || ais.length === 0) {
      throw new Error(`routing.${mode} must be a non-empty array of AI names`);
    }
    for (const ai of ais) {
      if (typeof ai !== "string" || !VALID_AIS.has(ai)) {
        throw new Error(
          `routing.${mode} contains invalid AI "${String(ai)}". Allowed: ${[...VALID_AIS].join(", ")}`
        );
      }
    }
    out[mode] = ais as AIName[];
  }
  if (!out.default || out.default.length === 0) {
    out.default = DEFAULT_ORDER;
  }
  return out;
}

export function loadConfig(): TridentConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return FALLBACK_CONFIG;
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { routing?: unknown };
    const routing = validateRouting(parsed.routing ?? FALLBACK_CONFIG.routing);
    return { routing };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load trident.config.json: ${message}`);
  }
}

export function resolveMode(mode: string): AIName[] {
  const config = loadConfig();
  const order = config.routing[mode];
  if (!order) {
    const available = Object.keys(config.routing).join(", ");
    throw new Error(`Unknown routing mode "${mode}". Available: ${available}`);
  }
  return order;
}

export function listModes(): Array<{ mode: string; order: AIName[] }> {
  const config = loadConfig();
  return Object.entries(config.routing).map(([mode, order]) => ({ mode, order }));
}

export const CONFIG_PATH_RESOLVED = CONFIG_PATH;
