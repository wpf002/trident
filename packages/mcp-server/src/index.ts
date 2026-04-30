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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const allTools = [
  ...searchTools,
  ...fileTools,
  ...apiTools,
  ...perplexityTools,
  ...googleTools,
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
