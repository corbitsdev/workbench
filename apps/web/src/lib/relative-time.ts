/**
 * Relative time derived from an ISO timestamp: "just now", "5m", "2h", "3d"
 * while recent, then a short absolute date ("Apr 3") once older than a week.
 * Pure so it can be unit-tested; `now` is injectable for determinism.
 */
export function formatRelativeTime(
  iso: string,
  now: number = Date.now(),
): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diffMs = Math.max(0, now - t);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
