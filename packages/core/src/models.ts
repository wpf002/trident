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
    premium: "sonar-reasoning",
    main: "sonar-pro",
    utility: "sonar",
  },
  gemini: {
    premium: "gemini-2.5-pro",
    main: "gemini-2.5-flash",
    utility: "gemini-2.5-flash-lite",
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

export function modelFor(ai: AIName, tier: ModelTier = "main"): string {
  const override = process.env[ENV_KEYS[ai][tier]];
  return override && override.trim().length > 0 ? override.trim() : DEFAULTS[ai][tier];
}

export function listModels(): Array<{ ai: AIName; tier: ModelTier; model: string }> {
  const out: Array<{ ai: AIName; tier: ModelTier; model: string }> = [];
  for (const ai of ["claude", "gpt", "perplexity", "gemini"] as AIName[]) {
    for (const tier of ["premium", "main", "utility"] as ModelTier[]) {
      out.push({ ai, tier, model: modelFor(ai, tier) });
    }
  }
  return out;
}
