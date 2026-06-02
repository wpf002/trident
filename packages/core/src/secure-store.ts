import fs from "fs";
import path from "path";
import crypto from "crypto";

// Secure-at-rest JSON storage for sensitive files (OAuth tokens, etc).
//
// - Files are always written with 0600 permissions (owner read/write only).
// - When TRIDENT_TOKEN_KEY is set, contents are encrypted with AES-256-GCM
//   using a key derived from it. This protects backups / snapshots / other
//   local accounts that can read the file but not the process environment.
// - Reads transparently handle both encrypted and legacy plaintext files, so
//   enabling a key does not orphan an existing token (it re-encrypts on next
//   write).

const ENC_ALG = "aes-256-gcm";
const ENC_MARKER = "trident-enc-v1";

interface EncryptedEnvelope {
  __trident: typeof ENC_MARKER;
  alg: typeof ENC_ALG;
  iv: string; // base64
  tag: string; // base64
  ct: string; // base64
}

function deriveKey(secret: string): Buffer {
  // 32-byte key from an arbitrary-length secret.
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

function getKey(): Buffer | null {
  const secret = process.env.TRIDENT_TOKEN_KEY?.trim();
  return secret ? deriveKey(secret) : null;
}

function isEnvelope(value: unknown): value is EncryptedEnvelope {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).__trident === ENC_MARKER
  );
}

/** Serialize + (optionally) encrypt + write `obj` to `filePath` with 0600 perms. */
export function writeSecretFile(filePath: string, obj: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const plaintext = JSON.stringify(obj, null, 2);
  const key = getKey();

  let payload: string;
  if (key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ENC_ALG, key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope: EncryptedEnvelope = {
      __trident: ENC_MARKER,
      alg: ENC_ALG,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ct: ct.toString("base64"),
    };
    payload = JSON.stringify(envelope, null, 2);
  } else {
    payload = plaintext;
  }

  fs.writeFileSync(filePath, payload, { encoding: "utf8", mode: 0o600 });
  // Tighten perms even if the file pre-existed with looser bits.
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best-effort on platforms without chmod semantics */
  }
}

/**
 * Read + (if needed) decrypt a secret file. Returns null if the file is absent.
 * Throws if the file is encrypted but TRIDENT_TOKEN_KEY is unset/wrong.
 */
export function readSecretFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupt / unreadable
  }

  if (!isEnvelope(parsed)) {
    return parsed as T; // legacy plaintext
  }

  const key = getKey();
  if (!key) {
    throw new Error(
      "Token file is encrypted but TRIDENT_TOKEN_KEY is not set. Set it to the key used to encrypt it."
    );
  }
  const decipher = crypto.createDecipheriv(
    ENC_ALG,
    key,
    Buffer.from(parsed.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(parsed.ct, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(pt.toString("utf8")) as T;
}

/** True when at-rest encryption is active (a key is configured). */
export function tokenEncryptionEnabled(): boolean {
  return getKey() !== null;
}
