import { z } from "zod";
import { memoryWrite, memoryRead, memoryList, memoryDelete, getProjects } from "../db/index.js";

export const memoryTools = [
  {
    name: "memory_write",
    description:
      "Write a key-value pair to the shared Trident memory store. Use this to share information with other AIs or persist context across sessions. Optionally scoped to a project.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "The key to store the value under (e.g. 'project_goals', 'user_preference_tone')",
        },
        value: {
          type: "string",
          description: "The value to store. Can be plain text, JSON, or markdown.",
        },
        project: {
          type: "string",
          description: "Optional project namespace. Defaults to 'global'.",
        },
        source: {
          type: "string",
          description: "Optional: which AI is writing this (e.g. 'claude', 'gpt', 'perplexity')",
        },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "memory_read",
    description:
      "Read a value from the shared Trident memory store by key. Optionally scoped to a project.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "The key to retrieve",
        },
        project: {
          type: "string",
          description: "Optional project namespace. Defaults to 'global'.",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "memory_list",
    description:
      "List all keys in the shared Trident memory store. Optionally filter by project.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Optional project namespace to filter by.",
        },
      },
    },
  },
  {
    name: "memory_delete",
    description: "Delete a key from the shared Trident memory store.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "The key to delete",
        },
        project: {
          type: "string",
          description: "Optional project namespace. Defaults to 'global'.",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "memory_projects",
    description: "List all project namespaces currently in the memory store.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

export function handleMemoryTool(
  name: string,
  args: Record<string, unknown>
): string {
  switch (name) {
    case "memory_write": {
      const key = args.key as string;
      const value = args.value as string;
      const project = (args.project as string | undefined) ?? "global";
      const source = args.source as string | undefined;
      memoryWrite(key, value, project, source);
      return JSON.stringify({
        success: true,
        message: `Written: [${project}] ${key}`,
      });
    }

    case "memory_read": {
      const key = args.key as string;
      const project = (args.project as string | undefined) ?? "global";
      const result = memoryRead(key, project);
      if (!result) {
        return JSON.stringify({ found: false, key, project });
      }
      return JSON.stringify({ found: true, ...result });
    }

    case "memory_list": {
      const project = args.project as string | undefined;
      const entries = memoryList(project);
      return JSON.stringify({
        count: entries.length,
        entries,
      });
    }

    case "memory_delete": {
      const key = args.key as string;
      const project = (args.project as string | undefined) ?? "global";
      const deleted = memoryDelete(key, project);
      return JSON.stringify({ success: deleted, key, project });
    }

    case "memory_projects": {
      const projects = getProjects();
      return JSON.stringify({ projects });
    }

    default:
      throw new Error(`Unknown memory tool: ${name}`);
  }
}
