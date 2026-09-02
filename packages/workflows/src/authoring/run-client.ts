// Shared fetch plumbing for a run-authenticated tool client — every tool
// bundle that calls a hub route mounted behind `WorkflowRunAuthenticator`
// (sidecar bearer token + run address, never a human session) needs the
// same two headers and the same `{ error: { code, userMessage } }`
// envelope parse. Before this module existed, `@corbits/workflow-
// authoring-tools`' and `@corbits/capability-tools`' own `client.ts`
// files each reimplemented both slightly differently (arktype-validated
// vs. ad hoc field access). This is that one shared seam.
//
// Browser-safe: no `@intx/*`, `drizzle-orm`, `hono`, or `postgres` — pure
// fetch/arktype, exported from `@corbits/workflows/client` alongside the
// rest of this package's browser-safe surface, because a tool bundle runs
// inside the sidecar's workflow-host, not the hub server.
import { type } from "arktype";

export interface RunBearerClientConfig {
  readonly sidecarToken: string;
  readonly address: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** The two headers every run-authenticated route resolves tenant and
 * principal from — identity never rides in a request body. */
export function runBearerHeaders(
  config: RunBearerClientConfig,
): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.address,
  };
}

const RunBearerErrorEnvelope = type({
  error: { code: "string", userMessage: "string" },
});

/** Pulls `error.userMessage` out of the canonical hub envelope
 * (`{ error: { code, userMessage } }`), if `body` matches that shape —
 * `undefined` for a differently-shaped or absent body, never a throw. */
export function runBearerErrorMessage(body: unknown): string | undefined {
  const parsed = RunBearerErrorEnvelope(body);
  return parsed instanceof type.errors ? undefined : parsed.error.userMessage;
}

/** The envelope's `error.code`, alongside the message above — some
 * callers (a republish `conflict`, a preview `not_found`) branch on the
 * code, not just the message. */
export function runBearerErrorCode(body: unknown): string | undefined {
  const parsed = RunBearerErrorEnvelope(body);
  return parsed instanceof type.errors ? undefined : parsed.error.code;
}

export function runBearerFetch(config: RunBearerClientConfig): typeof fetch {
  return config.fetchImpl ?? fetch;
}
