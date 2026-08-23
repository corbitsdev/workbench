/**
 * Person-facing inference copy. HTTP status, raw provider dumps, and
 * JSON error objects never belong on the timeline, in a sidebar preview,
 * or next to the composer — DESIGN.md Honesty is one consumer sentence.
 */

const HTTP_STATUS_MARK = /\[HTTP\s+\d+\]/i;
const TRAILING_HTTP_DUMP = /\s*\[HTTP\s+\d+\]:[\s\S]*$/i;

export const CONSUMER_INFERENCE_FAILURE_NOTICE =
  "This didn't go through. Try again, or check the connection in Settings.";

function isProviderJsonDump(raw: string): boolean {
  const trimmed = raw.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  return /"error"/i.test(trimmed);
}

function needsSanitization(raw: string): boolean {
  return HTTP_STATUS_MARK.test(raw) || isProviderJsonDump(raw);
}

/** Drop HTTP status and raw provider text; keep a classified preamble when present. */
export function consumerFacingInferenceText(raw: string): string {
  if (!needsSanitization(raw)) return raw;
  const stripped = raw.replace(TRAILING_HTTP_DUMP, "").trim();
  if (stripped.length > 0 && !needsSanitization(stripped)) return stripped;
  return CONSUMER_INFERENCE_FAILURE_NOTICE;
}
