// Shared fetch plumbing for a run-authenticated tool client — every tool
// bundle that calls a hub route mounted behind a workflow-run
// authenticator (sidecar bearer token + run address, never a human
// session) needs the same two headers. Kept local to this package
// (rather than imported from Workbench's own `@corbits/workflows`, which
// is private and carries a full server dependency graph) so this bundle
// installs standalone in any Interchange-backed hub.
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

export function runBearerFetch(config: RunBearerClientConfig): typeof fetch {
  return config.fetchImpl ?? fetch;
}
