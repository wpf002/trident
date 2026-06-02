// Session store now lives in @trident/core (single source of truth for schema,
// indexes, and pragmas). Re-exported here so existing `../lib/db.js` imports
// keep working.
export {
  getDb,
  logSessionRun,
  listSessionRuns,
  listSessionSummaries,
  getSessionRun,
  clearSessionRuns,
} from "@trident/core";
export type {
  SessionRunResponse,
  SessionRunRecord,
  SessionRunInput,
} from "@trident/core";
