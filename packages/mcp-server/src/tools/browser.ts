// Browser tools — stub for v2. Headless Chromium via Playwright will plug in
// here once the loop is exercised on backend tasks. The empty array keeps
// the registration site uniform; the handler is a clean error if invoked
// before implementation.

import type { ToolContext } from "../lib/builder-ctx.js";

export const browserTools: ReadonlyArray<{
  name: string;
  description: string;
  inputSchema: object;
}> = [];

export async function handleBrowserTool(
  name: string,
  _args: Record<string, unknown>,
  _ctx: ToolContext
): Promise<string> {
  return JSON.stringify({ error: `browser tool ${name} not implemented (v2)` });
}
