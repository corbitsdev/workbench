// A workbench-owned `CredentialProvider`, sibling to
// `http-raw-authorization-provider.ts` and to `@intx/harness`'s vendored
// `createHttpCredentialProvider` (`vendor/intx/harness/src/
// credential-providers.ts`, read-only per AGENTS.md). Neither vendored
// plugin fits Exa or ScrapeCreators: both APIs authenticate via an
// `x-api-key` header, not `authorization` in any shape. Registering this
// as a third provider plugin, keyed `http-x-api-key`, lets a tenant's Exa
// or ScrapeCreators provider row opt into the header shape its API
// actually wants without touching or forking the vendored plugin.
//
// Every protection the sibling providers enforce is mirrored exactly: the
// handle is pinned to the credential's origin at shape time, every request
// is re-checked against that origin (a cross-origin target is refused), and
// every outbound request forces `redirect: "manual"` so a 3xx never lets a
// server redirect the key to a foreign host -- only the injected header
// NAME differs.

import type {
  CredentialProvider,
  CredentialShapeContext,
  HttpMediatedCredential,
} from "@intx/types";

/**
 * The minimal call signature the shaped handle needs from `fetch`. Mirrors
 * `@intx/harness`'s `FetchLike` so a caller can inject a stub in tests
 * without pulling the full `fetch` type's extra members.
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpXApiKeyCredentialProviderOptions {
  /**
   * The `fetch` the shaped handle delegates to once the request is
   * origin-checked and the header is injected. Defaults to the global
   * `fetch`; injectable so origin-pinning can be exercised without a
   * network.
   */
  fetch?: FetchLike;
}

/**
 * Provider plugin key a `credential` row's `plugin` column names to opt a
 * binding into an `x-api-key` header shape instead of the vendored `http`
 * (Bearer) plugin or this package's own `http-raw-authorization` plugin.
 */
export const HTTP_X_API_KEY_PROVIDER_KEY = "http-x-api-key";

/**
 * Build the `http-x-api-key` credential provider: an
 * `HttpMediatedCredential` whose `fetch` sends the secret in the
 * `x-api-key` header. Register it alongside `@intx/harness`'s
 * `builtinCredentialProviders()` in a `CredentialProviderRegistry` and
 * point a provider row's `plugin` column at `HTTP_X_API_KEY_PROVIDER_KEY`
 * to opt that credential's bindings into this header shape.
 */
export function createHttpXApiKeyCredentialProvider(
  opts?: HttpXApiKeyCredentialProviderOptions,
): CredentialProvider {
  const fetchImpl: FetchLike = opts?.fetch ?? globalThis.fetch;

  return {
    key: HTTP_X_API_KEY_PROVIDER_KEY,
    shape(context: CredentialShapeContext): HttpMediatedCredential {
      const pinnedOrigin = new URL(context.origin).origin;

      return {
        kind: "http",
        async fetch(
          input: string | URL | Request,
          init?: RequestInit,
        ): Promise<Response> {
          const target = resolveTargetUrl(input, pinnedOrigin);
          if (target.origin !== pinnedOrigin) {
            throw new Error(
              `http-x-api-key credential is pinned to ${pinnedOrigin}; refusing cross-origin request to ${target.origin}`,
            );
          }

          // Read the secret fresh on every call so a rotation of the
          // underlying material cell reaches this handle without a rebuild.
          const { secret } = context.readCurrentMaterial();

          if (input instanceof Request) {
            const headers = new Headers(input.headers);
            headers.set("x-api-key", secret);
            return fetchImpl(
              new Request(input, { headers, redirect: "manual" }),
            );
          }

          const headers = new Headers(init?.headers);
          headers.set("x-api-key", secret);
          return fetchImpl(target, { ...init, headers, redirect: "manual" });
        },
        dispose(): void {
          // An x-api-key http handle allocates no resources; nothing to
          // release.
        },
      };
    },
  };
}

/**
 * Resolve the URL a request targets, matching `@intx/harness`'s own
 * `resolveTargetUrl`: a relative string resolves against the pinned
 * origin, an absolute string or URL keeps its own origin (refused above if
 * it differs), and a `Request` already carries an absolute URL.
 */
function resolveTargetUrl(
  input: string | URL | Request,
  pinnedOrigin: string,
): URL {
  if (typeof input === "string") {
    return new URL(input, pinnedOrigin);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}
