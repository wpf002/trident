// Prophet forecasting tool — lets the AIs call the Prophet service mid-chain
// (the numbers counterpart to perplexity_search). Talks to the Prophet HTTP API
// directly, matching the other tools' fetch style. Base URL: PROPHET_URL.

const DEFAULT_PROPHET_URL = "https://prophet-api-production.up.railway.app";

export const prophetTools = [
  {
    name: "prophet_forecast",
    description:
      "Forecast a time series with the Prophet service (LightGBM + conformal " +
      "prediction intervals). Use when you need a numeric projection of a future " +
      "value — e.g. demand, volume, revenue — for a series the service was trained " +
      "on. Returns point forecasts and optional lo/hi interval bounds. Call " +
      "prophet_models first if you don't know the available series/models.",
    inputSchema: {
      type: "object",
      properties: {
        series_id: {
          type: "string",
          description: "Identifier of the series to forecast (e.g. a ticker like 'NVDA').",
        },
        horizon: {
          type: "number",
          description: "Number of future steps to forecast (1..model's calibrated horizon).",
        },
        level: {
          type: "array",
          items: { type: "number" },
          description: "Optional confidence levels for prediction intervals, e.g. [80, 95].",
        },
        model: {
          type: "string",
          description: "Optional model name (see prophet_models). Omit for the default.",
        },
      },
      required: ["series_id", "horizon"],
    },
  },
  {
    name: "prophet_models",
    description:
      "List the models the Prophet service can forecast with, plus each model's " +
      "frequency, horizon, and number of series. Call this to discover what's available.",
    inputSchema: { type: "object", properties: {} },
  },
];

function prophetUrl(): string {
  return (process.env.PROPHET_URL ?? DEFAULT_PROPHET_URL).replace(/\/+$/, "");
}

export async function handleProphetTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    if (name === "prophet_models") {
      const res = await fetch(`${prophetUrl()}/models`, {
        headers: { accept: "application/json" },
      });
      return await passthrough(res);
    }

    if (name === "prophet_forecast") {
      const seriesId = args.series_id;
      const horizon = args.horizon;
      if (typeof seriesId !== "string" || typeof horizon !== "number") {
        return JSON.stringify({ error: "series_id (string) and horizon (number) are required." });
      }
      const body = {
        series_id: seriesId,
        horizon,
        level: args.level,
        model: args.model,
      };
      const res = await fetch(`${prophetUrl()}/forecast`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      return await passthrough(res);
    }

    throw new Error(`Unknown prophet tool: ${name}`);
  } catch (err) {
    return JSON.stringify({ error: `Prophet request failed: ${(err as Error).message}` });
  }
}

async function passthrough(res: Response): Promise<string> {
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      detail = (JSON.parse(text) as { detail?: string }).detail ?? text;
    } catch {
      /* keep raw text */
    }
    return JSON.stringify({ error: `Prophet returned ${res.status}: ${detail}` });
  }
  return text;
}
