// Per-token pricing for cost ceiling enforcement.
// These numbers are budgeting estimates — the agent uses them to know when
// it's burning money, not to settle an invoice. Adjust as model prices move.
// USD per 1M tokens.

interface ModelPrice {
  input_per_million: number;
  output_per_million: number;
}

// Match patterns — first match wins. Specific keys before generic suffixes.
const PRICES: Array<[RegExp, ModelPrice]> = [
  [/^claude-opus-4/i, { input_per_million: 15, output_per_million: 75 }],
  [/^claude-sonnet-4/i, { input_per_million: 3, output_per_million: 15 }],
  [/^claude-haiku-4/i, { input_per_million: 0.8, output_per_million: 4 }],
  [/^claude-3-7-sonnet/i, { input_per_million: 3, output_per_million: 15 }],
  [/^claude-3-5-sonnet/i, { input_per_million: 3, output_per_million: 15 }],
  [/^claude-3-5-haiku/i, { input_per_million: 0.8, output_per_million: 4 }],
  [/^claude-3-opus/i, { input_per_million: 15, output_per_million: 75 }],
  [/^gpt-4o-mini/i, { input_per_million: 0.15, output_per_million: 0.6 }],
  [/^gpt-4o/i, { input_per_million: 2.5, output_per_million: 10 }],
  [/^gpt-4/i, { input_per_million: 30, output_per_million: 60 }],
  [/^sonar-reasoning/i, { input_per_million: 1, output_per_million: 5 }],
  [/^sonar-pro/i, { input_per_million: 1, output_per_million: 1 }],
  [/^sonar/i, { input_per_million: 1, output_per_million: 1 }],
];

const FALLBACK_PRICE: ModelPrice = { input_per_million: 3, output_per_million: 15 };

export function priceFor(model: string): ModelPrice {
  for (const [re, price] of PRICES) {
    if (re.test(model)) return price;
  }
  return FALLBACK_PRICE;
}

export function computeCost(
  model: string,
  usage: { input_tokens: number; output_tokens: number } | undefined
): number {
  if (!usage) return 0;
  const p = priceFor(model);
  const inCost = (usage.input_tokens / 1_000_000) * p.input_per_million;
  const outCost = (usage.output_tokens / 1_000_000) * p.output_per_million;
  return Math.round((inCost + outCost) * 1_000_000) / 1_000_000;
}
