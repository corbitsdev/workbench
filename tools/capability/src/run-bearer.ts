// Kept local rather than imported from Workbench's private @corbits/workflows
// (full server dependency graph) so this bundle installs standalone in any
// Interchange-backed hub.
import { type } from "arktype";

export interface RunBearerClientConfig {
  readonly sidecarToken: string;
  readonly address: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** The two headers every run-authenticated route resolves tenant and
 * principal from — identity never rides in a request body. */
export function runBearerHeaders(config: RunBearerClientConfig): Record<string, string> {
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

export function runBearerFetch(config: RunBearerClientConfig): typeof fetch {
  return config.fetchImpl ?? fetch;
}
