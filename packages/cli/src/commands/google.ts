import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import http from "http";
import crypto from "crypto";
import chalk from "chalk";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { readSecretFile, writeSecretFile, tokenEncryptionEnabled } from "@trident/core";

// PKCE (RFC 7636) + CSRF state for the OAuth authorization-code flow.
function makePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const CREDENTIALS_PATH = path.join(REPO_ROOT, "credentials.json");
const TOKEN_PATH = path.join(REPO_ROOT, "data", "google-token.json");

const SCOPES = [
  // Read-only least privilege: the tools only ever read mail/drive/calendar.
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];

interface InstalledCredentials {
  installed?: { client_id: string; client_secret: string; redirect_uris: string[] };
  web?: { client_id: string; client_secret: string; redirect_uris: string[] };
}

function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `credentials.json not found at ${CREDENTIALS_PATH}\n` +
        "  1. Go to https://console.cloud.google.com/apis/credentials\n" +
        "  2. Create OAuth 2.0 Client ID (Application type: Desktop app)\n" +
        "  3. Download JSON, save as credentials.json at the repo root."
    );
  }
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8")) as InstalledCredentials;
  const block = raw.installed ?? raw.web;
  if (!block) throw new Error("credentials.json missing 'installed' or 'web' block");
  return block;
}

function saveToken(token: unknown) {
  // Written 0600, and AES-256-GCM-encrypted when TRIDENT_TOKEN_KEY is set.
  writeSecretFile(TOKEN_PATH, token);
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

async function loopbackFlow(
  redirectUri: string,
  authUrl: string,
  expectedState: string
): Promise<string> {
  const url = new URL(redirectUri);
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(
      `Loopback flow expected http://localhost:<port>, got ${redirectUri}. ` +
        "Use a Desktop app credential or fall back to the manual flow."
    );
  }
  const port = url.port ? parseInt(url.port, 10) : 80;

  console.log(chalk.gray("\n  Open this URL in your browser:\n"));
  console.log("  " + chalk.cyan(authUrl) + "\n");
  console.log(chalk.gray(`  Waiting for redirect to ${redirectUri}…\n`));

  return new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url ?? "/", redirectUri);
        const code = u.searchParams.get("code");
        const error = u.searchParams.get("error");
        const state = u.searchParams.get("state");
        if (error) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`OAuth error: ${error}`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("No authorization code in callback.");
          return;
        }
        // CSRF protection: reject a callback whose state doesn't match what we sent.
        if (state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("State mismatch — possible CSRF. Authorization rejected.");
          server.close();
          reject(new Error("OAuth state mismatch — authorization rejected."));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Trident — Google authorization complete.</h2><p>You can close this tab.</p></body></html>");
        server.close();
        resolve(code);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Internal error: ${message}`);
        server.close();
        reject(err);
      }
    });
    server.on("error", reject);
    server.listen(port, url.hostname);
  });
}

export async function googleLogin() {
  let creds;
  try {
    creds = loadCredentials();
  } catch (err) {
    console.error(chalk.red("\n  " + (err instanceof Error ? err.message : String(err)) + "\n"));
    process.exitCode = 1;
    return;
  }

  const redirectUri = creds.redirect_uris[0];
  const client = new OAuth2Client({
    clientId: creds.client_id,
    clientSecret: creds.client_secret,
    redirectUri,
  });

  console.log("\n" + chalk.bold.white("  Trident — Google OAuth setup"));
  console.log(chalk.gray(`  Scopes: ${SCOPES.join(", ")}`));

  // PKCE verifier/challenge + CSRF state, shared across both flows.
  const { codeVerifier, codeChallenge } = makePkce();
  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });

  let code: string;
  try {
    if (redirectUri.startsWith("http://localhost") || redirectUri.startsWith("http://127.0.0.1")) {
      code = await loopbackFlow(redirectUri, authUrl, state);
    } else {
      console.log(chalk.gray("\n  Open this URL, complete consent, and paste the code shown:\n"));
      console.log("  " + chalk.cyan(authUrl) + "\n");
      code = await ask("  Authorization code: ");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`\n  Auth flow failed: ${message}\n`));
    process.exitCode = 1;
    return;
  }

  try {
    // Completes PKCE — the verifier must match the challenge sent above.
    const { tokens } = await client.getToken({ code, codeVerifier });
    saveToken(tokens);
    console.log(
      chalk.green(
        `\n  ✓ Token saved to ${TOKEN_PATH}` +
          (tokenEncryptionEnabled() ? " (encrypted)" : " (0600; set TRIDENT_TOKEN_KEY to encrypt at rest)")
      )
    );
    if (!tokens.refresh_token) {
      console.log(
        chalk.yellow(
          "  ⚠ No refresh_token returned. You may need to revoke prior consent at https://myaccount.google.com/permissions and re-run this command."
        )
      );
    }
    console.log(chalk.gray("\n  The MCP tools (gmail_search, gdrive_search, gcal_upcoming) are now usable.\n"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`\n  Failed to exchange code for tokens: ${message}\n`));
    process.exitCode = 1;
  }
}

export function googleStatus() {
  console.log("\n" + chalk.bold.white("  Trident — Google integration status\n"));
  const credsExists = fs.existsSync(CREDENTIALS_PATH);
  const tokenExists = fs.existsSync(TOKEN_PATH);
  console.log(`  ${credsExists ? chalk.green("✓") : chalk.red("✗")}  credentials.json  ${chalk.gray(CREDENTIALS_PATH)}`);
  console.log(`  ${tokenExists ? chalk.green("✓") : chalk.red("✗")}  token             ${chalk.gray(TOKEN_PATH)}`);
  if (tokenExists) {
    try {
      const token = (readSecretFile<{ expiry_date?: number; scope?: string }>(TOKEN_PATH)) ?? {};
      if (token.expiry_date) {
        const expiresAt = new Date(token.expiry_date).toISOString();
        const expired = token.expiry_date < Date.now();
        console.log(`  ${chalk.gray("Expires:")}  ${expired ? chalk.red(expiresAt + " (expired)") : chalk.gray(expiresAt)}`);
      }
      if (token.scope) console.log(`  ${chalk.gray("Scopes: ")}  ${chalk.gray(token.scope)}`);
    } catch (err) {
      console.log(chalk.red(`  Could not read token: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  if (!credsExists || !tokenExists) {
    console.log(chalk.gray("\n  Run 'trident google login' to complete setup.\n"));
  } else {
    console.log();
  }
}
