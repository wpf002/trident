import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { OAuth2Client } from "google-auth-library";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const CREDENTIALS_PATH = path.join(REPO_ROOT, "credentials.json");
const TOKEN_PATH = path.join(REPO_ROOT, "data", "google-token.json");

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];

export const TOKEN_PATH_RESOLVED = TOKEN_PATH;
export const CREDENTIALS_PATH_RESOLVED = CREDENTIALS_PATH;

interface InstalledCredentials {
  installed?: { client_id: string; client_secret: string; redirect_uris: string[] };
  web?: { client_id: string; client_secret: string; redirect_uris: string[] };
}

interface SavedToken {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string;
  token_type?: string | null;
  expiry_date?: number | null;
  id_token?: string | null;
}

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

function loadCredentials(): { client_id: string; client_secret: string; redirect_uri: string } {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new GoogleAuthError(
      `credentials.json not found at ${CREDENTIALS_PATH}. ` +
        `Download an OAuth 2.0 Client ID JSON from Google Cloud Console (Desktop app) and save it there.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8")) as InstalledCredentials;
  const block = raw.installed ?? raw.web;
  if (!block) {
    throw new GoogleAuthError(
      "credentials.json is missing the 'installed' or 'web' block — re-export the file from Google Cloud."
    );
  }
  const { client_id, client_secret, redirect_uris } = block;
  if (!client_id || !client_secret || !redirect_uris || redirect_uris.length === 0) {
    throw new GoogleAuthError("credentials.json is missing client_id, client_secret, or redirect_uris.");
  }
  return { client_id, client_secret, redirect_uri: redirect_uris[0] };
}

export function buildOAuthClient(): OAuth2Client {
  const { client_id, client_secret, redirect_uri } = loadCredentials();
  return new OAuth2Client({ clientId: client_id, clientSecret: client_secret, redirectUri: redirect_uri });
}

export function loadSavedToken(): SavedToken | null {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8")) as SavedToken;
  } catch {
    return null;
  }
}

export function saveToken(token: SavedToken) {
  const dir = path.dirname(TOKEN_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2), "utf-8");
}

export async function getAuthorizedClient(): Promise<OAuth2Client> {
  const token = loadSavedToken();
  if (!token) {
    throw new GoogleAuthError(
      `No Google token found at ${TOKEN_PATH}. Run 'trident google login' to authorize.`
    );
  }
  const client = buildOAuthClient();
  client.setCredentials(token);
  client.on("tokens", (refreshed) => {
    if (refreshed.refresh_token || refreshed.access_token) {
      const merged = { ...loadSavedToken(), ...refreshed };
      try {
        saveToken(merged);
      } catch {
        // Best-effort token refresh persistence — failures here are non-fatal.
      }
    }
  });
  return client;
}
