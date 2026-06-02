// Centralized API access. Attaches the bearer token (if the user has stored one)
// to every request so the same-origin UI works against an auth-enabled server.

const TOKEN_KEY = "trident_api_token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore storage failures (private mode, etc.) */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** Thrown when the server rejects the request with 401. */
export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

/** fetch() wrapper that injects the stored bearer token and normalizes 401s. */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) throw new UnauthorizedError();
  return res;
}

/** Does the server require a token? Public, unauthenticated probe. */
export async function fetchAuthStatus(): Promise<{ authRequired: boolean }> {
  const res = await fetch("/api/auth/status");
  if (!res.ok) return { authRequired: false };
  return (await res.json()) as { authRequired: boolean };
}

/** Validate a candidate token against the authenticated check endpoint. */
export async function validateToken(token: string): Promise<boolean> {
  const res = await fetch("/api/auth/check", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok;
}
