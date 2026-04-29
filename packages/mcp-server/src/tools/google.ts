import { google } from "googleapis";
import { getAuthorizedClient, GoogleAuthError } from "../lib/google.js";

export const googleTools = [
  {
    name: "gmail_search",
    description:
      "Search Gmail threads for the authorized user using a Gmail query string (e.g. 'from:foo@bar.com is:unread newer_than:7d'). " +
      "Returns matching threads with subject, sender, snippet, and thread ID. Requires one-time setup via 'trident google login'.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Gmail search query. Same syntax as Gmail's search box.",
        },
        max_results: {
          type: "number",
          description: "Max threads to return (default: 10, max: 50)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "gdrive_search",
    description:
      "Search Google Drive files for the authorized user. Accepts a free-text query that is matched against name and full text. " +
      "Returns files with name, mimeType, id, modifiedTime, and webViewLink.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text search term (matched against file name and full text)",
        },
        max_results: {
          type: "number",
          description: "Max files to return (default: 10, max: 50)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "gcal_upcoming",
    description:
      "Get upcoming events from the authorized user's primary Google Calendar for the next N days. " +
      "Returns events with summary, start time, end time, attendees, and description.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "Number of days ahead to look (default: 7, max: 60)",
        },
        max_results: {
          type: "number",
          description: "Max events to return (default: 25, max: 100)",
        },
        calendar_id: {
          type: "string",
          description: "Calendar ID (default: 'primary')",
        },
      },
    },
  },
];

function errorPayload(err: unknown): string {
  if (err instanceof GoogleAuthError) {
    return JSON.stringify({ error: err.message, setup_command: "trident google login" });
  }
  const message = err instanceof Error ? err.message : String(err);
  return JSON.stringify({ error: message });
}

async function gmailSearch(args: Record<string, unknown>): Promise<string> {
  const query = args.query as string;
  if (!query || typeof query !== "string") {
    return JSON.stringify({ error: "query is required" });
  }
  const maxResults = Math.min((args.max_results as number | undefined) ?? 10, 50);

  const auth = await getAuthorizedClient();
  const gmail = google.gmail({ version: "v1", auth });

  const list = await gmail.users.threads.list({
    userId: "me",
    q: query,
    maxResults,
  });

  const threads = list.data.threads ?? [];
  const detailed = await Promise.all(
    threads.map(async (t) => {
      if (!t.id) return null;
      const thread = await gmail.users.threads.get({
        userId: "me",
        id: t.id,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "Date"],
      });
      const firstMessage = thread.data.messages?.[0];
      const headers = firstMessage?.payload?.headers ?? [];
      const find = (name: string) =>
        headers.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? null;
      return {
        thread_id: t.id,
        subject: find("Subject"),
        from: find("From"),
        date: find("Date"),
        snippet: thread.data.messages?.[0]?.snippet ?? null,
        message_count: thread.data.messages?.length ?? 0,
      };
    })
  );

  return JSON.stringify({
    query,
    count: detailed.filter(Boolean).length,
    threads: detailed.filter(Boolean),
  });
}

async function gdriveSearch(args: Record<string, unknown>): Promise<string> {
  const query = args.query as string;
  if (!query || typeof query !== "string") {
    return JSON.stringify({ error: "query is required" });
  }
  const maxResults = Math.min((args.max_results as number | undefined) ?? 10, 50);

  const auth = await getAuthorizedClient();
  const drive = google.drive({ version: "v3", auth });

  // Drive API requires escaping single quotes in the q parameter.
  const escaped = query.replace(/'/g, "\\'");
  const q = `(name contains '${escaped}' or fullText contains '${escaped}') and trashed = false`;

  const result = await drive.files.list({
    q,
    pageSize: maxResults,
    fields: "files(id, name, mimeType, modifiedTime, webViewLink, owners(emailAddress, displayName), size)",
    orderBy: "modifiedTime desc",
  });

  const files = (result.data.files ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    webViewLink: f.webViewLink,
    owners: f.owners?.map((o) => ({ email: o.emailAddress, name: o.displayName })) ?? [],
    size: f.size,
  }));

  return JSON.stringify({ query, count: files.length, files });
}

async function gcalUpcoming(args: Record<string, unknown>): Promise<string> {
  const daysRaw = args.days as number | undefined;
  const days = Math.min(Math.max(daysRaw ?? 7, 1), 60);
  const maxResults = Math.min((args.max_results as number | undefined) ?? 25, 100);
  const calendarId = (args.calendar_id as string | undefined) ?? "primary";

  const auth = await getAuthorizedClient();
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const result = await calendar.events.list({
    calendarId,
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    maxResults,
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = (result.data.items ?? []).map((e) => ({
    id: e.id,
    summary: e.summary,
    description: e.description,
    location: e.location,
    start: e.start?.dateTime ?? e.start?.date ?? null,
    end: e.end?.dateTime ?? e.end?.date ?? null,
    attendees: e.attendees?.map((a) => ({ email: a.email, name: a.displayName, response: a.responseStatus })) ?? [],
    htmlLink: e.htmlLink,
    organizer: e.organizer?.email ?? null,
  }));

  return JSON.stringify({
    calendar_id: calendarId,
    range: { from: now.toISOString(), to: future.toISOString(), days },
    count: events.length,
    events,
  });
}

export async function handleGoogleTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    switch (name) {
      case "gmail_search":
        return await gmailSearch(args);
      case "gdrive_search":
        return await gdriveSearch(args);
      case "gcal_upcoming":
        return await gcalUpcoming(args);
      default:
        throw new Error(`Unknown google tool: ${name}`);
    }
  } catch (err) {
    return errorPayload(err);
  }
}
