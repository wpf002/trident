// Model tiers — picked for cost/quality balance.
//
// Premium  — top-of-line, ~10× the cost of main. Use when accuracy matters
//            more than cost (e.g. user explicitly opts in via --premium).
// Main     — default user-facing tier. Strong quality at a fraction of premium.
// Utility  — cheap/fast. Used by internal calls (route detection, fact
//            extraction, synthesis, confidence scoring) where the call is
//            either short, structured, or behind the scenes.
//
// Override any model via env var, e.g. TRIDENT_CLAUDE_MAIN_MODEL=...

import { AIName } from "./clients-types.js";
import { getProvider, providerIds } from "./providers.js";

export type ModelTier = "premium" | "main" | "utility";

const DEFAULTS: Record<AIName, Record<ModelTier, string>> = {
  claude: {
    premium: "claude-opus-5",
    main: "claude-sonnet-4-6",
    utility: "claude-haiku-4-5-20251001",
  },
  gpt: {
    premium: "gpt-4o",
    main: "gpt-4o-mini",
    utility: "gpt-4o-mini",
  },
  perplexity: {
    premium: "sonar-reasoning-pro",
    main: "sonar-pro",
    utility: "sonar",
  },
  gemini: {
    // Use Google's "-latest" aliases: pinned versions (e.g. gemini-2.5-flash)
    // get gated to "not available to new users", but the aliases always point
    // at a live model. Premium (Pro) needs billing enabled on the Google
    // account — on the free tier it returns a 429 quota error.
    premium: "gemini-pro-latest",
    main: "gemini-flash-latest",
    utility: "gemini-flash-lite-latest",
  },
};

const ENV_KEYS: Record<AIName, Record<ModelTier, string>> = {
  claude: {
    premium: "TRIDENT_CLAUDE_PREMIUM_MODEL",
    main: "TRIDENT_CLAUDE_MAIN_MODEL",
    utility: "TRIDENT_CLAUDE_UTILITY_MODEL",
  },
  gpt: {
    premium: "TRIDENT_GPT_PREMIUM_MODEL",
    main: "TRIDENT_GPT_MAIN_MODEL",
    utility: "TRIDENT_GPT_UTILITY_MODEL",
  },
  perplexity: {
    premium: "TRIDENT_PERPLEXITY_PREMIUM_MODEL",
    main: "TRIDENT_PERPLEXITY_MAIN_MODEL",
    utility: "TRIDENT_PERPLEXITY_UTILITY_MODEL",
  },
  gemini: {
    premium: "TRIDENT_GEMINI_PREMIUM_MODEL",
    main: "TRIDENT_GEMINI_MAIN_MODEL",
    utility: "TRIDENT_GEMINI_UTILITY_MODEL",
  },
};

/** Env override key for a provider/tier, e.g. TRIDENT_GROK_MAIN_MODEL. */
function envKeyFor(ai: AIName, tier: ModelTier): string {
  const known = ENV_KEYS[ai as keyof typeof ENV_KEYS];
  if (known) return known[tier];
  return `TRIDENT_${String(ai).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${tier.toUpperCase()}_MODEL`;
}

export function modelFor(ai: AIName, tier: ModelTier = "main"): string {
  const override = process.env[envKeyFor(ai, tier)];
  if (override && override.trim().length > 0) return override.trim();
  const spec = getProvider(String(ai));
  if (spec) return spec.models[tier];
  return DEFAULTS[ai as keyof typeof DEFAULTS]?.[tier] ?? "";
}

export function listModels(): Array<{ ai: AIName; tier: ModelTier; model: string }> {
  const out: Array<{ ai: AIName; tier: ModelTier; model: string }> = [];
  for (const ai of providerIds()) {
    for (const tier of ["premium", "main", "utility"] as ModelTier[]) {
      out.push({ ai, tier, model: modelFor(ai, tier) });
    }
  }
  return out;
}
