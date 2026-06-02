// Synthesis prompts/logic now live in @trident/core (single source shared with
// the UI server). Re-exported so existing `../lib/synthesis.js` imports work.
export {
  formatResponsesForSynthesis,
  DIFF_SYSTEM_PROMPT,
  CONFIDENCE_SYSTEM_PROMPT,
  parseConfidenceReport,
  runDiffSynthesis,
  runConfidenceScoring,
} from "@trident/core";
export type {
  SynthesisResponse,
  ConfidenceScore,
  ConfidenceReport,
} from "@trident/core";
