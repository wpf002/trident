import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { AIName } from "./clients-types.js";
import type { ModelTier } from "./models.js";

// Provider registry.
//
// Adding a backend should be configuration, not a code change in eight files.
// Every provider that speaks the OpenAI chat-completions dialect — xAI/Grok,
// Groq, DeepSeek, Mistral, Together, OpenRouter, a local Ollama or LM Studio —
// works by adding an entry here or in trident.providers.json. Nothing else in
// the codebase needs to know it exists.
//
// Anthropic is the one built-in that does NOT use that dialect; it has its own
// SDK path in clients.ts. That's why `transport` exists.

export type ProviderTransport = "anthropic" | "openai-compatible";

export interface ProviderSpec {
  /** Stable id used everywhere: session records, CLI flags, API payloads. */
  id: string;
  /** Human label for UI and CLI. */
  label: string;
  transport: ProviderTransport;
  /** Env var holding the API key. Missing key = this provider errors, others still run. */
  apiKeyEnv: string;
  /** Base URL for openai-compatible transports. Undefined = OpenAI default. */
  baseURL?: string;
  /** Model id per tier. */
  models: Record<ModelTier, string>;
  /** Hard ceiling on output tokens for this provider. */
  maxOutputTokens: number;
  /** Hex colour for UI tags / CLI output. */
  color: string;
  /** False for providers loaded from config — used for messaging only. */
  builtIn: boolean;
}

const BUILT_INS: ProviderSpec[] = [
  {
    id: "claude",
    label: "Claude",
    transport: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    models: { premium: "claude-opus-5", main: "claude-sonnet-4-6", utility: "claude-haiku-4-5-20251001" },
    maxOutputTokens: 16384,
    color: "#D4A017",
    builtIn: true,
  },
  {
    id: "gpt",
    label: "ChatGPT",
    transport: "openai-compatible",
    apiKeyEnv: "OPENAI_API_KEY",
    models: { premium: "gpt-4o", main: "gpt-4o-mini", utility: "gpt-4o-mini" },
    maxOutputTokens: 16384,
    color: "#10A37F",
    builtIn: true,
  },
  {
    id: "perplexity",
    label: "Perplexity",
    transport: "openai-compatible",
    apiKeyEnv: "PERPLEXITY_API_KEY",
    baseURL: "https://api.perplexity.ai",
    models: { premium: "sonar-reasoning-pro", main: "sonar-pro", utility: "sonar" },
    maxOutputTokens: 8192,
    color: "#6C63FF",
    builtIn: true,
  },
  {
    id: "gemini",
    label: "Gemini",
    transport: "openai-compatible",
    apiKeyEnv: "GEMINI_API_KEY",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: { premium: "gemini-pro-latest", main: "gemini-flash-latest", utility: "gemini-flash-lite-latest" },
    maxOutputTokens: 16384,
    color: "#5B9BFF",
    builtIn: true,
  },
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

/** Where custom providers come from, in precedence order. */
function customConfigSources(): string[] {
  const out: string[] = [];
  if (process.env.TRIDENT_PROVIDERS_FILE) out.push(path.resolve(process.env.TRIDENT_PROVIDERS_FILE));
  out.push(path.join(REPO_ROOT, "trident.providers.json"));
  return out;
}

function isTier(v: unknown): v is Record<ModelTier, string> {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.premium === "string" && typeof o.main === "string" && typeof o.utility === "string";
}

/**
 * Validate a config entry. Invalid providers are skipped, never thrown —
 * a typo in a custom provider must not stop Trident from starting.
 */
function parseProvider(raw: unknown): ProviderSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id.trim()) return null;
  if (typeof o.apiKeyEnv !== "string" || !o.apiKeyEnv.trim()) return null;
  if (!isTier(o.models)) return null;
  const transport: ProviderTransport = o.transport === "anthropic" ? "anthropic" : "openai-compatible";
  if (transport === "openai-compatible" && typeof o.baseURL !== "string") return null;
  return {
    id: o.id.trim(),
    label: typeof o.label === "string" && o.label.trim() ? o.label.trim() : o.id.trim(),
    transport,
    apiKeyEnv: o.apiKeyEnv.trim(),
    baseURL: typeof o.baseURL === "string" ? o.baseURL : undefined,
    models: o.models,
    maxOutputTokens:
      typeof o.maxOutputTokens === "number" && o.maxOutputTokens > 0 ? o.maxOutputTokens : 8192,
    color: typeof o.color === "string" ? o.color : "#8da3c8",
    builtIn: false,
  };
}

function loadCustom(): ProviderSpec[] {
  const out: ProviderSpec[] = [];

  // Inline JSON wins — handy for containers with no writable filesystem.
  const inline = process.env.TRIDENT_PROVIDERS;
  if (inline && inline.trim()) {
    try {
      const parsed = JSON.parse(inline) as unknown;
      if (Array.isArray(parsed)) for (const p of parsed) { const s = parseProvider(p); if (s) out.push(s); }
    } catch {
      /* malformed env must not stop startup */
    }
  }

  for (const file of customConfigSources()) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as Record<string, unknown>)?.providers)
          ? ((parsed as Record<string, unknown>).providers as unknown[])
          : [];
      for (const p of list) { const s = parseProvider(p); if (s) out.push(s); }
      break; // first file that exists wins
    } catch {
      /* malformed file must not stop startup */
    }
  }
  return out;
}

let _registry: Map<string, ProviderSpec> | null = null;

/** All providers, built-in plus configured. Custom entries may override a built-in by id. */
export function providers(): Map<string, ProviderSpec> {
  if (_registry) return _registry;
  const m = new Map<string, ProviderSpec>();
  for (const p of BUILT_INS) m.set(p.id, p);
  for (const p of loadCustom()) m.set(p.id, p); // custom can override a built-in
  _registry = m;
  return m;
}

/** Re-read configuration. Tests use this; nothing else needs it. */
export function resetProviders(): void {
  _registry = null;
}

export function getProvider(id: string): ProviderSpec | undefined {
  return providers().get(id);
}

export function providerIds(): AIName[] {
  return [...providers().keys()] as AIName[];
}

/** Providers whose API key is actually present in the environment. */
export function configuredProviderIds(): AIName[] {
  return providerIds().filter((id) => {
    const p = providers().get(id);
    return !!p && !!process.env[p.apiKeyEnv];
  });
}
