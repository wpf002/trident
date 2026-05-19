#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { searchTools, handleSearchTool } from "./tools/search.js";
import { fileTools, handleFileTool } from "./tools/files.js";
import { apiTools, handleApiTool } from "./tools/api.js";
import { perplexityTools, handlePerplexityTool } from "./tools/perplexity.js";
import { googleTools, handleGoogleTool } from "./tools/google.js";
import { fsProjectTools, handleFsProjectTool } from "./tools/fs_project.js";
import { shellTools, handleShellTool } from "./tools/shell.js";
import { gitTools, handleGitTool } from "./tools/git.js";
import { pkgTools, handlePkgTool } from "./tools/pkg.js";
import { testTools, handleTestTool } from "./tools/test.js";
import { buildCtxTools, handleBuildCtxTool } from "./tools/build_ctx.js";
import { browserTools, handleBrowserTool } from "./tools/browser.js";
import { createDefaultToolContext } from "./lib/builder-ctx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const builderCtx = createDefaultToolContext();

const allTools = [
  ...searchTools,
  ...fileTools,
  ...apiTools,
  ...perplexityTools,
  ...googleTools,
  ...fsProjectTools,
  ...shellTools,
  ...gitTools,
  ...pkgTools,
  ...testTools,
  ...buildCtxTools,
  ...browserTools,
];

const server = new Server(
  {
    name: "trident",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List all available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: allTools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const safeArgs = (args ?? {}) as Record<string, unknown>;

  try {
    let result: string;

    if (searchTools.some((t) => t.name === name)) {
      result = await handleSearchTool(name, safeArgs);
    } else if (fileTools.some((t) => t.name === name)) {
      result = handleFileTool(name, safeArgs);
    } else if (apiTools.some((t) => t.name === name)) {
      result = await handleApiTool(name, safeArgs);
    } else if (perplexityTools.some((t) => t.name === name)) {
      result = await handlePerplexityTool(name, safeArgs);
    } else if (googleTools.some((t) => t.name === name)) {
      result = await handleGoogleTool(name, safeArgs);
    } else if (fsProjectTools.some((t) => t.name === name)) {
      result = await handleFsProjectTool(name, safeArgs, builderCtx);
    } else if (shellTools.some((t) => t.name === name)) {
      result = await handleShellTool(name, safeArgs, builderCtx);
    } else if (gitTools.some((t) => t.name === name)) {
      result = await handleGitTool(name, safeArgs, builderCtx);
    } else if (pkgTools.some((t) => t.name === name)) {
      result = await handlePkgTool(name, safeArgs, builderCtx);
    } else if (testTools.some((t) => t.name === name)) {
      result = await handleTestTool(name, safeArgs, builderCtx);
    } else if (buildCtxTools.some((t) => t.name === name)) {
      result = await handleBuildCtxTool(name, safeArgs, builderCtx);
    } else if (browserTools.some((t) => t.name === name)) {
      result = await handleBrowserTool(name, safeArgs, builderCtx);
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: result,
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: message }),
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Trident MCP Server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
