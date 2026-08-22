import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { readSecretFile, writeSecretFile, tokenEncryptionEnabled } from "./secure-store.js";
import { providers, type ProviderSpec } from "./providers.js";

// User-managed API keys.
//
// Keys entered in Settings are stored encrypted at rest (AES-256-GCM when
// TRIDENT_TOKEN_KEY is set) with 0600 permissions, and applied to the process
// environment so the existing clients pick them up with no changes.
//
// Precedence: a key saved in Settings overrides the same key from .env.
// Deleting a saved key falls back to whatever .env provided, so a user can
// experiment in the UI without losing their file-based setup.
//
// A raw key value NEVER leaves this module — callers only ever get a mask.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.TRIDENT_DATA_DIR
  ? path.resolve(process.env.TRIDENT_DATA_DIR)
  : path.resolve(__dirname, "../../../data");
const KEYS_PATH = path.join(DATA_DIR, "api-keys.json");

interface StoredKey {
  value: string;
  updatedAt: string;
}
type KeyFile = Record<string, StoredKey>;

/**
 * Whatever the environment provided before we touched it. Captured once at
 * module load so deleting a Settings key can restore the .env value instead of
 * leaving the provider dead until restart.
 */
const envBaseline: Record<string, string | undefined> = {};
let baselineCaptured = false;

function captureBaseline(): void {
  if (baselineCaptured) return;
  for (const p of providers().values()) {
    if (!(p.apiKeyEnv in envBaseline)) envBaseline[p.apiKeyEnv] = process.env[p.apiKeyEnv];
  }
  baselineCaptured = true;
}

function readFileSafe(): KeyFile {
  try {
    return readSecretFile<KeyFile>(KEYS_PATH) ?? {};
  } catch {
    // Encrypted with a key we no longer have, or corrupt. Never throw at
    // startup over this — the app still works with .env keys.
    return {};
  }
}

function writeFileSafe(data: KeyFile): void {
  writeSecretFile(KEYS_PATH, data);
}

/** `sk-ant-…9f2a` — enough to recognise a key, not enough to use it. */
export function maskKey(value: string): string {
  const v = value.trim();
  if (v.length <= 12) return "••••••••";
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}

export type KeySource = "settings" | "environment" | "none";

export interface KeyStatus {
  /** Provider id, e.g. "claude". */
  id: string;
  label: string;
  /** The env var this provider reads. */
  apiKeyEnv: string;
  source: KeySource;
  /** Masked preview, or null when no key is configured. */
  masked: string | null;
  /** When it was saved in Settings. Null for env-provided keys. */
  updatedAt: string | null;
  builtIn: boolean;
}

function statusFor(p: ProviderSpec, file: KeyFile): KeyStatus {
  captureBaseline();
  const stored = file[p.id];
  if (stored?.value) {
    return {
      id: p.id,
      label: p.label,
      apiKeyEnv: p.apiKeyEnv,
      source: "settings",
      masked: maskKey(stored.value),
      updatedAt: stored.updatedAt,
      builtIn: p.builtIn,
    };
  }
  const fromEnv = envBaseline[p.apiKeyEnv];
  if (fromEnv && fromEnv.trim()) {
    return {
      id: p.id,
      label: p.label,
      apiKeyEnv: p.apiKeyEnv,
      source: "environment",
      masked: maskKey(fromEnv),
      updatedAt: null,
      builtIn: p.builtIn,
    };
  }
  return {
    id: p.id,
    label: p.label,
    apiKeyEnv: p.apiKeyEnv,
    source: "none",
    masked: null,
    updatedAt: null,
    builtIn: p.builtIn,
  };
}

/** Status for every registered provider. Masked values only. */
export function listKeyStatus(): KeyStatus[] {
  const file = readFileSafe();
  return [...providers().values()].map((p) => statusFor(p, file));
}

export function getKeyStatus(providerId: string): KeyStatus | null {
  const p = providers().get(providerId);
  if (!p) return null;
  return statusFor(p, readFileSafe());
}

/**
 * Save a key and apply it immediately, so it works without a restart.
 * Throws on an unknown provider or an empty value.
 */
export function setApiKey(providerId: string, value: string): KeyStatus {
  const p = providers().get(providerId);
  if (!p) throw new Error(`Unknown provider: ${providerId}`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Key cannot be empty");

  captureBaseline();
  const file = readFileSafe();
  file[providerId] = { value: trimmed, updatedAt: new Date().toISOString() };
  writeFileSafe(file);
  process.env[p.apiKeyEnv] = trimmed;
  return statusFor(p, file);
}

/**
 * Remove a saved key. The provider falls back to its .env value if there was
 * one, otherwise it becomes unconfigured.
 */
export function deleteApiKey(providerId: string): KeyStatus {
  const p = providers().get(providerId);
  if (!p) throw new Error(`Unknown provider: ${providerId}`);

  captureBaseline();
  const file = readFileSafe();
  delete file[providerId];
  writeFileSafe(file);

  const fallback = envBaseline[p.apiKeyEnv];
  if (fallback && fallback.trim()) process.env[p.apiKeyEnv] = fallback;
  else delete process.env[p.apiKeyEnv];

  return statusFor(p, file);
}

/**
 * Load saved keys into the environment. Call once at startup, before anything
 * makes a provider call.
 */
export function applyStoredKeys(): void {
  captureBaseline();
  const file = readFileSafe();
  for (const p of providers().values()) {
    const stored = file[p.id];
    if (stored?.value) process.env[p.apiKeyEnv] = stored.value;
  }
}

/** Whether the key file exists, and whether it's encrypted at rest. */
export function keystoreInfo(): { path: string; exists: boolean; encrypted: boolean } {
  return {
    path: KEYS_PATH,
    exists: fs.existsSync(KEYS_PATH),
    encrypted: tokenEncryptionEnabled(),
  };
}
