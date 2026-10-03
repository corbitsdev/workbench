// Pre-fills the MCP "add a server by URL" name field: the server's own
// reported name first, the pasted URL's host when the server says nothing,
// and a plain fallback when the URL does not parse either. Every suggestion
// is trimmed, capped, and deduped against the workspace catalog, and stays
// editable in the form — a suggestion never overwrites what was typed.
import { type } from "arktype";

/** What `serverInfo` may carry a display name under. Discovery returns it
 * untyped (`Record<string, unknown>`), so anything else is ignored rather
 * than cast. `title` wins: it is the human-readable label, `name` the id. */
const ServerInfoShape = type({
  "name?": "string",
  "title?": "string",
});

export type McpNameSource = "server" | "url" | "fallback";

const FALLBACK_NAME = "MCP server";
const MAX_NAME_LENGTH = 60;

function cleanCandidate(value: string): string | null {
  const trimmed = value.trim().slice(0, MAX_NAME_LENGTH).trim();
  return trimmed === "" ? null : trimmed;
}

/** Host labels that name the protocol, not the server: skipped when reading a
 * display name or slug off a URL, so `mcp.linear.app` reads as `linear`. */
const GENERIC_HOST_LABELS = new Set([
  "api",
  "app",
  "apps",
  "gateway",
  "mcp",
  "proxy",
  "server",
  "servers",
]);

/** The host label that names the server: the first label, unless it is a
 * generic prefix with a more distinctive label behind it. Bare hosts and
 * literal IPs come back whole. Null when there is no host at all. */
function distinctiveHostLabel(hostname: string): string | null {
  const bare = hostname.replace(/^www\./i, "");
  if (bare === "") return null;
  if (!bare.includes(".") || /^[\d.]+$/.test(bare) || bare.includes(":")) return bare;
  const labels = bare.split(".");
  const first = labels[0] ?? "";
  if (GENERIC_HOST_LABELS.has(first.toLocaleLowerCase()) && labels.length > 1) {
    return labels[1] ?? first;
  }
  return first;
}

function humanizeHostLabel(label: string): string | null {
  const words = label
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word !== "");
  if (words.length === 0) return null;
  return words.map((word) => word.slice(0, 1).toLocaleUpperCase() + word.slice(1)).join(" ");
}

/** A display name read off a URL's host: `mcp.linear.app` reads as `Linear`.
 * Null when the URL is empty or does not parse — the caller falls back. */
export function displayNameFromUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;
  let hostname: string;
  try {
    hostname = new URL(trimmed).hostname;
  } catch {
    return null;
  }
  const label = distinctiveHostLabel(hostname);
  if (label === null) return null;
  // Literal IPs name themselves whole; anything else reads as words.
  if (/^[\d.]+$/.test(label) || label.includes(":")) return label;
  return humanizeHostLabel(label);
}

/** The storage slug a pasted URL's server is kept under: the host's
 * distinctive label, lowercased and dashed. Null when the URL is empty or
 * unparsable. */
export function handleFromUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;
  try {
    const label = distinctiveHostLabel(new URL(trimmed).hostname);
    if (label === null) return null;
    const slug = label
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug === "" ? null : slug;
  } catch {
    return null;
  }
}

/** A name no connected server already carries (case-insensitive): appends
 * ` 2`, ` 3`, … until it is unique. */
export function dedupeMcpName(base: string, existingNames: readonly string[]): string {
  const taken = new Set(existingNames.map((name) => name.trim().toLocaleLowerCase()));
  if (!taken.has(base.toLocaleLowerCase())) return base;
  let next = 2;
  while (taken.has(`${base} ${String(next)}`.toLocaleLowerCase())) next += 1;
  return `${base} ${String(next)}`;
}

/** The same dedupe for storage slugs, joined with a dash. */
export function dedupeMcpHandle(base: string, existingHandles: readonly string[]): string {
  const taken = new Set(existingHandles.map((handle) => handle.trim().toLocaleLowerCase()));
  if (!taken.has(base.toLocaleLowerCase())) return base;
  let next = 2;
  while (taken.has(`${base}-${String(next)}`.toLocaleLowerCase())) next += 1;
  return `${base}-${String(next)}`;
}

function serverReportedName(serverInfo: unknown): string | null {
  if (serverInfo === null || typeof serverInfo !== "object") return null;
  const parsed = ServerInfoShape(serverInfo);
  if (parsed instanceof type.errors) return null;
  if (parsed.title !== undefined) {
    const title = cleanCandidate(parsed.title);
    if (title !== null) return title;
  }
  if (parsed.name !== undefined) return cleanCandidate(parsed.name);
  return null;
}

/** The name the form should show for a pasted URL and, once looked up, the
 * server's self-reported `serverInfo`. Untrusted on both sides: each is
 * parsed, trimmed, and capped before it is ever displayed or stored. */
export function suggestMcpServerName(args: {
  readonly url: string;
  readonly serverInfo?: unknown;
  readonly existingNames?: readonly string[];
}): { readonly name: string; readonly source: McpNameSource } {
  const existing = args.existingNames ?? [];
  const fromServer = serverReportedName(args.serverInfo);
  if (fromServer !== null) return { name: dedupeMcpName(fromServer, existing), source: "server" };
  const fromUrl = displayNameFromUrl(args.url);
  if (fromUrl !== null) return { name: dedupeMcpName(fromUrl, existing), source: "url" };
  return { name: dedupeMcpName(FALLBACK_NAME, existing), source: "fallback" };
}
