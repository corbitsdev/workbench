/** How long ago a timestamp was, in the compact form the chat surfaces
 * use for activity: "just now", "12m ago", "3h ago", "5d ago". An
 * absent or unparseable timestamp renders as nothing rather than a
 * placeholder date. */
export function formatRelativeActivity(iso: string | null): string {
  if (iso === null) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const deltaMs = Date.now() - date.getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
