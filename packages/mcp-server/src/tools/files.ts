import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.resolve(__dirname, "../../../../data/docs");

// Ensure docs dir exists
if (!fs.existsSync(DOCS_DIR)) {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
}

const ALLOWED_EXTENSIONS = [
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".ts",
  ".js",
  ".py",
  ".env.example",
];

// True only when `resolved` is DOCS_DIR itself or strictly inside it. Uses
// path.relative so a sibling like `<root>/data/docs-secrets` cannot pass the
// way a naive startsWith(DOCS_DIR) prefix check would.
function isInsideDocs(resolved: string): boolean {
  const rel = path.relative(DOCS_DIR, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isSafePath(requestedPath: string): boolean {
  return isInsideDocs(path.resolve(DOCS_DIR, requestedPath));
}

export const fileTools = [
  {
    name: "file_list",
    description:
      "List files available in the Trident shared documents directory. These are project docs and context files you can read.",
    inputSchema: {
      type: "object",
      properties: {
        subdirectory: {
          type: "string",
          description:
            "Optional subdirectory to list (relative to the docs root)",
        },
      },
    },
  },
  {
    name: "file_read",
    description:
      "Read a file from the Trident shared documents directory. Supports text files: .md, .txt, .json, .csv, .yaml, .ts, .js, .py, etc.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path to the file (e.g. 'BHIS/architecture.md')",
        },
        max_chars: {
          type: "number",
          description:
            "Optional max characters to read (default: 50000). Use for large files.",
        },
      },
      required: ["path"],
    },
  },
];

export function handleFileTool(
  name: string,
  args: Record<string, unknown>
): string {
  switch (name) {
    case "file_list": {
      const subdir = args.subdirectory as string | undefined;
      const targetDir = subdir
        ? path.resolve(DOCS_DIR, subdir)
        : DOCS_DIR;

      if (!isInsideDocs(targetDir)) {
        return JSON.stringify({ error: "Access denied: path outside docs directory" });
      }

      if (!fs.existsSync(targetDir)) {
        return JSON.stringify({ error: `Directory not found: ${subdir ?? "/"}` });
      }

      function walkDir(dir: string, base: string): string[] {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const files: string[] = [];
        for (const entry of entries) {
          const relPath = path.join(base, entry.name);
          if (entry.isDirectory()) {
            files.push(...walkDir(path.join(dir, entry.name), relPath));
          } else {
            const ext = path.extname(entry.name).toLowerCase();
            if (ALLOWED_EXTENSIONS.includes(ext) || !ext) {
              files.push(relPath);
            }
          }
        }
        return files;
      }

      const files = walkDir(targetDir, subdir ?? "");
      return JSON.stringify({ docs_directory: DOCS_DIR, files });
    }

    case "file_read": {
      const filePath = args.path as string;
      const maxChars = (args.max_chars as number | undefined) ?? 50000;

      if (!isSafePath(filePath)) {
        return JSON.stringify({
          error: "Access denied: path outside docs directory",
        });
      }

      const fullPath = path.resolve(DOCS_DIR, filePath);
      if (!fs.existsSync(fullPath)) {
        return JSON.stringify({ error: `File not found: ${filePath}` });
      }

      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) {
        return JSON.stringify({ error: `Not a file: ${filePath}` });
      }

      const ext = path.extname(filePath).toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(ext) && ext !== "") {
        return JSON.stringify({
          error: `Unsupported file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`,
        });
      }

      let content = fs.readFileSync(fullPath, "utf-8");
      const truncated = content.length > maxChars;
      if (truncated) {
        content = content.slice(0, maxChars);
      }

      return JSON.stringify({
        path: filePath,
        size_bytes: stat.size,
        truncated,
        content,
      });
    }

    default:
      throw new Error(`Unknown file tool: ${name}`);
  }
}
