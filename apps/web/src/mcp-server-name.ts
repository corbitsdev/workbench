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

/** RFC 3492 Punycode decoding, kept inline because no punycode package ships
 * in the browser bundle this module runs in. A URL parser already handed us an
 * ASCII `xn--…` label, so a decoding failure (unreachable) falls back to the
 * raw label rather than throwing — the label a caller sees is never worse than
 * the codepoint garble it replaces. */
function decodePunycodeLabel(label: string): string {
  if (!label.startsWith("xn--")) return label;
  const base = 36;
  const tmin = 1;
  const tmax = 26;
  const skew = 38;
  const damp = 700;
  const initialBias = 72;
  const initialN = 128;
  const digitFor = (code: number): number => {
    if (code >= 48 && code <= 57) return code - 22; // 0-9
    if (code >= 65 && code <= 90) return code - 65; // A-Z
    if (code >= 97 && code <= 122) return code - 97; // a-z
    throw new Error("not a punycode digit");
  };
  const adapt = (delta: number, numPoints: number, first: boolean): number => {
    let d = first ? Math.floor(delta / damp) : delta >> 1;
    d += Math.floor(d / numPoints);
    let k = 0;
    while (d > Math.floor(((base - tmin) * tmax) / 2)) {
      d = Math.floor(d / (base - tmin));
      k += base;
    }
    return k + Math.floor(((base - tmin + 1) * d) / (d + skew));
  };
  try {
    const payload = label.slice(4);
    const hyphen = payload.lastIndexOf("-");
    let output = hyphen > 0 ? payload.slice(0, hyphen) : "";
    const tail = hyphen > 0 ? payload.slice(hyphen + 1) : payload;
    let n = initialN;
    let i = 0;
    let bias = initialBias;
    let pos = 0;
    while (pos < tail.length) {
      const oldi = i;
      let w = 1;
      for (let k = base; ; k += base) {
        const digit = digitFor(tail.charCodeAt(pos));
        pos += 1;
        i += digit * w;
        const threshold = k <= bias ? tmin : k >= bias + tmax ? tmax : k - bias;
        if (digit < threshold) break;
        w *= base - threshold;
      }
      const outputLength = output.length;
      bias = adapt(i - oldi, outputLength + 1, oldi === 0);
      n += Math.floor(i / (outputLength + 1));
      i %= outputLength + 1;
      output = output.slice(0, i) + String.fromCodePoint(n) + output.slice(i);
      i += 1;
    }
    return output;
  } catch {
    return label;
  }
}

/** The host label that names the server: the first label, unless it is a
 * generic prefix with a more distinctive label behind it. Bare hosts and
 * literal IPs come back whole. Null when there is no host at all. */
function distinctiveHostLabel(hostname: string): string | null {
  const bare = hostname.replace(/^www\./i, "");
  if (bare === "") return null;
  // `new URL().hostname` reports an IPv6 literal bracketed (`[::1]`); the
  // loopback one is a local server a name can mean, so it reads as
  // "localhost" instead of collapsing to a degenerate slug like "1".
  if (bare === "[::1]" || bare === "::1") return "localhost";
  if (!bare.includes(".") || /^[\d.]+$/.test(bare) || bare.includes(":")) return bare;
  const labels = bare.split(".");
  const first = labels[0] ?? "";
  if (GENERIC_HOST_LABELS.has(first.toLocaleLowerCase()) && labels.length > 1) {
    return labels[1] ?? first;
  }
  return first;
}

function humanizeHostLabel(label: string): string | null {
  // A URL parser hands international host names back as Punycode (`xn--…`),
  // which would otherwise read as codepoint garble once split into words;
  // decode before humanizing so the label is meaningful.
  const readable = decodePunycodeLabel(label);
  const words = readable
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
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

/** A typed name that is really a pasted URL, read back as a display name:
 * the name field never saves a URL silently — the form says where the paste
 * belongs and saves the extracted suggestion instead. Null when the typed
 * text is not a URL at all. */
export function redirectUrlName(typed: string, existingNames: readonly string[]): string | null {
  const extracted = displayNameFromUrl(typed);
  if (extracted === null) return null;
  return dedupeMcpName(extracted, existingNames);
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
