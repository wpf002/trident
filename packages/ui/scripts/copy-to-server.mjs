import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "..", "dist");
const DEST = path.resolve(__dirname, "..", "..", "ui-server", "static");

if (!fs.existsSync(SRC)) {
  console.error(`UI build not found at ${SRC} — did 'vite build' fail?`);
  process.exit(1);
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.cpSync(SRC, DEST, { recursive: true });
console.log(`Copied UI bundle to ${DEST}`);
