// The MCP-server credential provider, sibling to
// `http-x-api-key-provider.ts`: a tenant-connected MCP server
// (`@corbits/connections`' `mcp:<slug>` rows) authenticates with
// `authorization: Bearer <token>` when the person supplied a token, and
// with NO authorization header at all when they connected keyless. The
// vendored `http` (Bearer) plugin cannot express the keyless case — it
// always injects the stored secret, and a public MCP server like Exa
// accepts an absent header but 401s a bogus bearer — so keyless
// connections store `MCP_NO_TOKEN_SENTINEL` and this provider omits the
// header when it reads that sentinel back.
//
// Every protection the sibling providers enforce is mirrored exactly:
// the handle is pinned to the credential's origin at shape time, every
// request is re-checked against that origin (plus an explicit extra-origin
// map), and every outbound request forces `redirect: "manual"` so a 3xx
// never sends a token to a foreign host.

import type {
  CredentialProvider,
  CredentialShapeContext,
  HttpMediatedCredential,
} from "@intx/types";

import type { FetchLike } from "./http-x-api-key-provider";
import { mcpOriginPinnedFetch } from "./mcp-origin-pinned-fetch";

/**
 * The stored-secret sentinel for a keyless MCP-server connection.
 * Credential storage requires a non-empty secret, so a tokenless server
 * stores this value; this provider reads it back as "send no
 * authorization header". Owned here so both the writer
 * (`@corbits/connections`' MCP connector) and the reader (this
 * provider) import the one constant.
 */
export const MCP_NO_TOKEN_SENTINEL = "unauthenticated-mcp-server";

export interface McpStreamableHttpCredentialProviderOptions {
  /** Injectable `fetch` for tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/**
 * Provider plugin key an MCP-server provider row's `plugin` column
 * names. `@corbits/connections`' MCP connector writes this key on
 * connect; the sidecar registers the provider alongside the other
 * workbench-owned plugins.
 */
export const MCP_STREAMABLE_HTTP_PROVIDER_KEY = "mcp-streamable-http";

export function createMcpStreamableHttpCredentialProvider(
  opts?: McpStreamableHttpCredentialProviderOptions,
): CredentialProvider {
  const fetchImpl: FetchLike = opts?.fetch ?? globalThis.fetch;

  return {
    key: MCP_STREAMABLE_HTTP_PROVIDER_KEY,
    shape(context: CredentialShapeContext): HttpMediatedCredential {
      const pinnedOrigin = new URL(context.origin).origin;

      return {
        kind: "http",
        fetch: mcpOriginPinnedFetch({
          pinnedOrigin,
          fetch: fetchImpl,
          readToken: () => {
            // Read the secret fresh on every call so a rotation of the
            // underlying material cell reaches this handle without a
            // rebuild.
            const { secret } = context.readCurrentMaterial();
            return secret === MCP_NO_TOKEN_SENTINEL ? undefined : secret;
          },
        }),
        dispose(): void {
          // An http handle allocates no resources; nothing to release.
        },
      };
    },
  };
}
