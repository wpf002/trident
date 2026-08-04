import { AIName } from "./clients-types.js";

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
  council: {
    order: ["claude", "gpt", "gemini", "perplexity"],
    description: "Claude drafts → ChatGPT refines → Gemini adds a fresh angle → Perplexity fact-checks",
    systemPrompts: {
      claude: "You are drafting an initial response. Be thorough and well-structured.",
      gpt: "You are refining the draft above. Improve clarity, flow, and completeness.",
      gemini:
        "You have a refined answer above. Add a genuinely different perspective: an angle, consideration, or approach the others missed. Don't just restate — expand the thinking.",
      perplexity:
        "You are fact-checking and enriching the answer above with current, accurate information. Flag anything outdated or incorrect, and cite sources.",
    },
  },
  "research-analyze-synthesize": {
    order: ["perplexity", "claude", "gemini"],
    description: "Perplexity researches → Claude analyzes → Gemini synthesizes the final answer",
    systemPrompts: {
      perplexity: "Research this topic thoroughly using your web access. Establish the facts and cite sources.",
      claude: "Analyze the research above. Extract the key insights, tensions, and what actually matters.",
      gemini:
        "You have research and analysis above. Synthesize everything into a single, clear, standalone final answer for the reader. Lead with the takeaway, keep it well-organized, and don't lose the important nuance.",
    },
  },
  "gemini-draft-refine-verify": {
    order: ["gemini", "claude", "perplexity"],
    description: "Gemini drafts fast → Claude sharpens the reasoning → Perplexity fact-checks",
    systemPrompts: {
      gemini: "Give a fast, broad first draft. Cover the main points and structure — get everything on the table.",
      claude:
        "Sharpen the draft above: tighten the reasoning, fix weak spots and gaps, and improve structure and clarity. Keep what works.",
      perplexity:
        "Fact-check and enrich the response above with current, accurate information. Flag anything outdated or wrong, and cite sources.",
    },
  },
  "triangulate": {
    order: ["gemini", "gpt", "claude"],
    description: "Three models cross-check each other: Gemini → ChatGPT → Claude, each building on the last",
    systemPrompts: {
      gemini: "Give your best, well-reasoned answer to the request. Be thorough and clear.",
      gpt: "An answer is above. Independently pressure-test it: confirm what's right, correct what's wrong, and add anything missing.",
      claude:
        "You have two prior takes above. Reconcile them into the strongest single answer — resolve any disagreements, keep the best of each, and state the final conclusion with confidence.",
    },
  },
  "gemini-debate-judge": {
    order: ["gemini", "claude", "gpt"],
    description: "Gemini argues for → Claude argues against → ChatGPT judges the debate",
    systemPrompts: {
      gemini: "Argue strongly in FAVOR of the proposition provided. Steel-man the position with the best case for it.",
      claude: "Argue strongly AGAINST the proposition provided. Steel-man the opposition with the best case against it.",
      gpt: "Judge both arguments above fairly using evidence and reasoning. Weigh the strongest points on each side and deliver a clear verdict.",
    },
  },
};
