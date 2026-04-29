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
  "research-ideate-build": {
    order: ["perplexity", "gpt", "claude"],
    description: "Perplexity researches → ChatGPT ideates creatively → Claude builds the realistic plan",
    systemPrompts: {
      perplexity:
        "Research this topic or idea thoroughly. Find current facts, real-world context, existing solutions, market data, technical constraints, and obvious obstacles. Cite sources. Do not propose solutions yet — just establish the ground truth.",
      gpt:
        "Perplexity supplied research above. Now expand the creative space. Brainstorm three to five ambitious approaches, novel angles, or design directions. Don't filter for feasibility — push for original, interesting moves. Sketch each direction concretely enough that someone could imagine building it.",
      claude:
        "You have research from Perplexity and creative directions from ChatGPT above. Now produce the realistic build plan. Pick the strongest direction (or a hybrid), justify it briefly, then deliver: (1) what to build first, (2) the next 3-5 steps in order, (3) the key tradeoffs and risks, (4) what would have to be true for this to succeed. Be concrete and committal.",
    },
  },
};
