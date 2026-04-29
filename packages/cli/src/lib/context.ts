import { getDb } from "./db.js";

export interface MemoryEntry {
  project: string;
  key: string;
  value: string;
  source: string | null;
  updated_at: string;
}

export function loadProjectMemory(project: string): MemoryEntry[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT project, key, value, source, updated_at FROM memory WHERE project = ? ORDER BY key"
    )
    .all(project) as MemoryEntry[];
  return rows;
}

const MAX_VALUE_CHARS = 4000;
const MAX_TOTAL_CHARS = 24000;

export function buildProjectContextBlock(project: string): string | null {
  const entries = loadProjectMemory(project);
  if (entries.length === 0) return null;

  const lines: string[] = [
    `## Project Context: ${project}`,
    "",
    `The following ${entries.length} memory entries are scoped to project "${project}".`,
    "Treat them as authoritative background facts about the project.",
    "",
  ];

  let total = lines.join("\n").length;

  for (const entry of entries) {
    const truncatedValue =
      entry.value.length > MAX_VALUE_CHARS
        ? entry.value.slice(0, MAX_VALUE_CHARS) + "\n…[truncated]"
        : entry.value;
    const block = [
      `### ${entry.key}`,
      truncatedValue,
      "",
    ].join("\n");
    if (total + block.length > MAX_TOTAL_CHARS) {
      lines.push(`_…${entries.length - lines.length} additional entries omitted (context budget reached)._`);
      break;
    }
    lines.push(block);
    total += block.length;
  }

  return lines.join("\n");
}

export function injectProjectContext(
  systemPrompt: string | undefined,
  project: string | undefined
): string | undefined {
  if (!project) return systemPrompt;
  const block = buildProjectContextBlock(project);
  if (!block) return systemPrompt;
  if (!systemPrompt) return block;
  return `${block}\n\n---\n\n${systemPrompt}`;
}
