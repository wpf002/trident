// Backwards-compatible shim — implementations now live in @trident/core.
export {
  AI_MAP,
  AI_LABELS,
  callClaude,
  callGPT,
  callPerplexity,
  VALID_AIS,
} from "@trident/core";
export type { AIName, AIMessage, AIResponse, StreamOptions } from "@trident/core";
