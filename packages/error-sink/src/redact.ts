// Strips obvious secrets before a report reaches any transport (CL-6496):
// a key that looks like a credential is replaced outright, and every
// string value -- messages, stack traces, anything nested in `extra` --
// is scanned for bearer tokens and authorization-header fragments.
// Heuristic, not a full secret-scanning engine: the bar is "never ships
// an obvious secret", not "catches every possible one".
const SECRET_KEY_PATTERN =
  /token|secret|password|passwd|api[-_]?key|apikey|credential|authorization|cookie/i;

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /bearer\s+\S+/gi,
  /authorization\s*:\s*\S+/gi,
  /\b(sk|pk|rk|ghp|gho|ghu|ghs)-[a-z0-9]{8,}\b/gi,
];

export function redactText(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }
  return redacted;
}

function redactValue(key: string, value: unknown): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return "[redacted]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(key, entry));
  }
  if (value !== null && typeof value === "object") {
    return redactRecord(value as Record<string, unknown>);
  }
  return value;
}

function redactRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    redacted[key] = redactValue(key, value);
  }
  return redacted;
}

export function redactExtra(
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (extra === undefined) return undefined;
  return redactRecord(extra);
}
