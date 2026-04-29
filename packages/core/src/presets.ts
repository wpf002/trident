import { AIName } from "./clients.js";

export interface ChainPreset {
  order: AIName[];
  description: string;
  systemPrompts?: Partial<Record<AIName, string>>;
}

export const CHAIN_PRESETS: Record<string, ChainPreset> = {
  "draft-refine-verify": {
    order: ["claude", "gpt", "perplexity"],
    description: "Claude drafts → GPT refines → Perplexity fact-checks with live search",
    systemPrompts: {
      claude: "You are drafting an initial response. Be thorough and well-structured.",
      gpt: "You are refining a draft. Improve clarity, flow, and completeness. The previous draft is provided as context.",
      perplexity:
        "You are fact-checking and enriching a refined response with current, accurate information. Flag anything outdated or incorrect.",
    },
  },
  "research-analyze-summarize": {
    order: ["perplexity", "claude", "gpt"],
    description: "Perplexity researches → Claude analyzes → GPT summarizes",
    systemPrompts: {
      perplexity: "Research this topic thoroughly using your web access. Provide sources.",
      claude: "Analyze the research provided. Extract key insights and identify patterns.",
      gpt: "Create a concise, actionable summary of the analysis. Bullet key takeaways.",
    },
  },
  "attack-defend-judge": {
    order: ["gpt", "claude", "perplexity"],
    description: "GPT argues for → Claude argues against → Perplexity judges",
    systemPrompts: {
      gpt: "Argue strongly in FAVOR of the proposition provided. Steel-man the position.",
      claude: "Argue strongly AGAINST the proposition provided. Steel-man the opposition.",
      perplexity: "Judge both arguments fairly using evidence and reasoning. Provide a balanced verdict.",
    },
  },
};
