import { type } from "arktype";
import { MailboxRefSchema, type MailboxRef } from "./mailbox";

/** MIME header carrying structured MailboxRef[] as JSON (CL-3507 / CL-3521). */
export const WORKBENCH_REFS_MIME_HEADER = "X-Workbench-Refs";

const MailboxRefArray = MailboxRefSchema.array();

/**
 * Serialize refs for the X-Workbench-Refs MIME header. Rejects values that
 * would break header framing (CR/LF) or fail MailboxRefSchema.
 */
export function encodeWorkbenchRefsHeaderValue(refs: MailboxRef[]): string {
  const parsed = MailboxRefArray(refs);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid mailbox refs: ${parsed.summary}`);
  }
  if (parsed.length === 0) {
    throw new Error("mailbox refs must be non-empty when encoding a header");
  }
  const json = JSON.stringify(parsed);
  if (/[\r\n]/.test(json)) {
    throw new Error("encoded mailbox refs must not contain CR or LF");
  }
  return json;
}

/**
 * Parse the X-Workbench-Refs header value from a stored frame. Returns
 * undefined when absent, empty, or invalid (degrades like the jsonb column).
 */
export function parseWorkbenchRefsHeaderValue(
  raw: string | undefined | null,
): MailboxRef[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const parsed = MailboxRefArray(json);
  if (parsed instanceof type.errors) return undefined;
  return parsed.length > 0 ? parsed : undefined;
}

/** Header map keys are normalized to lowercase by the MIME parser. */
export function parseWorkbenchRefsFromHeaderMap(
  headers: Map<string, string>,
): MailboxRef[] | undefined {
  return parseWorkbenchRefsHeaderValue(
    headers.get(WORKBENCH_REFS_MIME_HEADER.toLowerCase()),
  );
}
