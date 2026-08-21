// Resolves the operator-configured Gotenberg endpoint (CL-6499). Gotenberg
// is an optional, self-hosted PDF-rendering service — the operator points
// us at it with one URL, exactly like any other pluggable external
// endpoint. Absence is a supported, ordinary state, not a config error: a
// bench with no `GOTENBERG_URL` set simply never gains the "render to
// PDF" capability, so callers must treat `null` as "capability absent"
// rather than retrying or logging a warning.
import { type } from "arktype";

const GotenbergUrl = type("string.url");

export type GotenbergConfig = {
  readonly baseUrl: string;
};

/**
 * Reads `GOTENBERG_URL` from the given env map. Returns `null` when unset
 * or blank — the expected shape for a bench that hasn't opted in. Throws
 * only when the operator set the variable to something that isn't a
 * parseable URL, since that's a genuine misconfiguration worth failing on
 * loudly rather than silently treating as "absent".
 */
export function resolveGotenbergConfig(
  env: Record<string, string | undefined>,
): GotenbergConfig | null {
  const raw = env.GOTENBERG_URL?.trim();
  if (raw === undefined || raw === "") return null;
  const parsed = GotenbergUrl(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`GOTENBERG_URL is not a valid URL: ${parsed.summary}`);
  }
  return { baseUrl: parsed.replace(/\/+$/, "") };
}
