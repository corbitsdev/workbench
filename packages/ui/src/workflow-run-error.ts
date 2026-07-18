/**
 * Classification/sanitization boundary for workflow step errors (CL-2660).
 *
 * A failed step's `lastError.message` is whatever the step threw — it can
 * carry internal identifiers (ins_/ses_ addresses), stack fragments, DB
 * constraint text, or internal hostnames. Nothing user-facing may render it
 * raw. `classifyRunError` maps the known-safe shapes (our tool packages'
 * uniform `"<Provider> API error: <status> …"` format, network-level fetch
 * failures) to plain-language messages — what happened and what to do next —
 * and defaults everything unrecognized to a generic-but-honest internal
 * message. The raw text is preserved on the result for operator surfaces and
 * logs; it must never reach an end-user panel.
 */
import type { RunState } from "@intx/workflow";

export type RunErrorKind =
  | "external-auth"
  | "external-rate-limit"
  | "external-unavailable"
  | "external-rejected"
  | "network"
  | "internal";

export interface ClassifiedRunError {
  kind: RunErrorKind;
  /** Plain-language message safe to render to end users. */
  userMessage: string;
  /** The original error text — operator surfaces and logs only. */
  raw: string;
}

const PROVIDER_API_ERROR =
  /^([A-Za-z][A-Za-z0-9]*(?: [A-Za-z0-9]+){0,2}) API error: (\d{3})/;

const ANY_API_ERROR = /\bAPI error: (\d{3})/;

const GENERIC_PROVIDER_LABEL = "An external service";

const NETWORK_PATTERNS = [
  /\bfetch failed\b/i,
  /\bECONN(REFUSED|RESET|ABORTED)\b/,
  /\bENOTFOUND\b/,
  /\bETIMEDOUT\b/,
  /\bEAI_AGAIN\b/,
  /\bsocket\b.*\b(closed|hang ?up|reset)\b/i,
  /\b(request|fetch|connect(?:ion)?|socket)\b.*\btimed out\b/i,
  /\bnetwork (error|request failed)\b/i,
];

const INTERNAL_MESSAGE =
  "Something went wrong inside this workflow run. Try running it again; if it keeps failing, contact your workspace admin.";

const NETWORK_MESSAGE =
  "A service this workflow depends on couldn't be reached. Try running it again in a moment.";

function classifyProviderError(
  provider: string,
  status: number,
  raw: string,
): ClassifiedRunError {
  const credentialRef =
    provider === GENERIC_PROVIDER_LABEL
      ? "credential's"
      : `${provider} credential's`;
  if (status === 401 || status === 403) {
    return {
      kind: "external-auth",
      userMessage: `${provider} declined the request (${status}). Check the connected ${credentialRef} access and try again.`,
      raw,
    };
  }
  if (status === 429) {
    return {
      kind: "external-rate-limit",
      userMessage: `${provider} is rate-limiting requests right now. Wait a few minutes and run this again.`,
      raw,
    };
  }
  if (status >= 500) {
    return {
      kind: "external-unavailable",
      userMessage: `${provider} had a problem on its end (${status}). Try running this again shortly.`,
      raw,
    };
  }
  return {
    kind: "external-rejected",
    userMessage: `${provider} rejected the request (${status}). Try again, and contact your workspace admin if it keeps failing.`,
    raw,
  };
}

export function classifyRunError(raw: string): ClassifiedRunError {
  const providerMatch = PROVIDER_API_ERROR.exec(raw);
  if (providerMatch?.[1] !== undefined && providerMatch[2] !== undefined) {
    return classifyProviderError(
      providerMatch[1],
      Number(providerMatch[2]),
      raw,
    );
  }
  const anyApiErrorMatch = ANY_API_ERROR.exec(raw);
  if (anyApiErrorMatch?.[1] !== undefined) {
    return classifyProviderError(
      GENERIC_PROVIDER_LABEL,
      Number(anyApiErrorMatch[1]),
      raw,
    );
  }
  if (NETWORK_PATTERNS.some((pattern) => pattern.test(raw))) {
    return { kind: "network", userMessage: NETWORK_MESSAGE, raw };
  }
  return { kind: "internal", userMessage: INTERNAL_MESSAGE, raw };
}

/**
 * The classified error from whichever step failed the run, or null if the run
 * has not failed or no step carries a `lastError`. First `lastError` in
 * map-iteration order wins (the run-state adapter attaches at most one per
 * run — see `failedRunErrorMessage`).
 */
export function failedRunError(
  state: RunState | null,
): ClassifiedRunError | null {
  if (state?.phase !== "failed") return null;
  for (const step of state.steps.values()) {
    if (step.lastError !== undefined) {
      return classifyRunError(step.lastError.message);
    }
  }
  return null;
}

/**
 * Plain-language line for a step's live inference issue (CL-3887) — the run
 * page's signal that a still-running step is stalled on its provider rather
 * than dead. Unlike `classifyRunError`, the input is the runtime's own fixed
 * `InferenceError.category` enum (interchange/packages/types/src/runtime.ts),
 * not raw provider-error text, so this is a direct lookup rather than pattern
 * matching. The step keeps running for every category — `context_overflow` is
 * the one exception that does not retry (the input itself must shrink), so
 * its message omits the retry claim the others make.
 */
export function describeLiveInferenceIssue(category: string): string {
  switch (category) {
    case "timeout":
      return "Model provider timed out — retrying";
    case "retryable":
      return "Model provider had a transient error — retrying";
    case "quota_exhausted":
      return "Model provider is rate-limiting requests — retrying";
    case "credential_failure":
      return "Model provider rejected the credential — retrying";
    case "context_overflow":
      return "Input is too large for the model";
    case "protocol_mismatch":
      return "Model provider returned an unexpected response — retrying";
    case "aborted":
      return "The step was interrupted — retrying";
    case "fatal":
    default:
      return "Model provider had a problem — retrying";
  }
}
