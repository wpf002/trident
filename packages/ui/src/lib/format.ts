// Format a duration in milliseconds as a human-readable seconds string.
// 0–9.9s shows one decimal, 10s+ rounds to whole seconds.
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = ms / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}
