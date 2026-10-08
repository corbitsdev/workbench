// Strips obvious secrets before a report reaches any transport. Heuristic,
// not a full secret-scanning engine: the bar is "never ships an obvious
// secret", not "catches every possible one".
const SECRET_KEY_PATTERN =
  /token|secret|password|passwd|api[-_]?key|apikey|credential|authorization|cookie/i;

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /bearer\s+\S+/gi,
  /authorization\s*:\s*\S+/gi,
  // Provider key prefixes come in three shapes, matched by how distinctive the
  // separator + value run is so ordinary hyphenated words/paths are NOT eaten
  // (e.g. `pk-manifest.yaml`, `sk-parallel-copy` must stay intact):
  //  1. GitHub-family PATs are `_`-separated (`ghp_...`, `github_pat_11...`).
  //     Their short prefixes are not English words, so an 8+ base64-ish value
  //     after the `_` is enough. A hyphen (`ghp-garbage-collector`) is never a
  //     PAT, so `[-_]` here is deliberately just `_`.
  /\b(?:github_pat|ghp|gho|ghu|ghs)_[a-z0-9_]{8,}\b/gi,
  //  2. Segmented OpenAI-style keys (`sk-proj-...`, `pk-live-...`) put a known
  //     short sub-label (`live`/`proj`/`test`/...) right after the hyphen, and
  //     only then is the hyphen meaningful for masking.
  /\b(?:sk|pk|rk)-(?:live|proj|test|dev|prod|org|key|secret)\b[_-][a-z0-9_]{4,}\b/gi,
  //  3. Bare OpenAI-style keys (`sk-abcdefghijklmnop`) need a hyphen-free value
  //     run long enough that it cannot be an ordinary word (`sk-manifest` and
  //     `pk-abcdefgh` are 8 chars and MUST NOT redact; real keys are `sk-` +
  //     a long base64 run). `(?![-_])` stops a segment boundary from ending the
  //     match partway through a hyphenated word.
  /\b(?:sk|pk|rk)-[a-z0-9_]{9,}(?![-_])\b/gi,
  // A raw JWT (header.payload.signature) carries no keyword prefix at all,
  // but its base64url header always starts with the literal `eyJ` (base64
  // of `{"`), which is distinctive enough to key off heuristically.
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g,
  // Free-text `keyword + space + value` forms (`use password supersecret123`,
  // `api_key ABcdEf123456`, `secret hunter2-hunter2`) — the approval `title`
  // is free-form caller input so a bare keyword followed by a secret-shaped
  // run slips through the assignment/`=` paths. Two guards keep ordinary prose
  // intact: the value must run at least 8 `[a-z0-9_-]` chars (spares short
  // words like `sauce`/`ring`/`is`), and it must contain a digit, hyphen, or
  // underscore — the one case-insensitive-safe distinguishing signal (pure
  // `[A-Z0-9_-]` character classes are useless under `/i`, so `recovery` / a
  // pure-English word would otherwise be eaten). The value charset excludes
  // spaces/punctuation so the match stops at the end of the secret rather than
  // swallowing the rest of the sentence.
  /\b(?:password|passwd|secret|token|access_token|api[_-]?key)\s+(?=[a-z0-9_-]{8,}\b)[a-z0-9_-]*[\d_-][a-z0-9_-]*\b/gi,
];

// A value's character set once past `name=`: covers hex/base64/JWT-shaped
// tokens without running past the value into unrelated trailing text (a
// closing paren, a stack-frame's `:12:5)`, ...).
const ASSIGNMENT_VALUE = "[\\w.+/=%-]+";

// Covers `token=`/`access_token=`/... assignments in a URL or free-text
// message. Only the value is replaced so the rest stays readable.
const SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(access_token|refresh_token|id_token|api[-_]?key|apikey|secret|password|passwd|token|credential)(\\s*=\\s*)(${ASSIGNMENT_VALUE})`,
  "gi",
);

// `code`/`key` are ambiguous elsewhere (`code=404`, `key=user:1234:...`), so
// these two are scoped to right after a literal `?` or `&`.
const QUERY_PARAM_SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  `([?&])(code|key)(\\s*=\\s*)(${ASSIGNMENT_VALUE})`,
  "gi",
);

export function redactText(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }
  redacted = redacted.replace(
    SENSITIVE_ASSIGNMENT_PATTERN,
    (_match, name: string, separator: string) => `${name}${separator}[redacted]`,
  );
  redacted = redacted.replace(
    QUERY_PARAM_SENSITIVE_ASSIGNMENT_PATTERN,
    (_match, prefix: string, name: string, separator: string) =>
      `${prefix}${name}${separator}[redacted]`,
  );
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

function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
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
