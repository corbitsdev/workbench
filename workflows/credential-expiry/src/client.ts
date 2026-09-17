// A minimal client for the one stock Interchange surface this tool
// reads: `GET /api/tenants/:tenantId/credentials` and `/providers`, with
// the workflow run's own bearer (sidecar token plus run address), the
// same pairing `@corbits/connections-tools`' `listConnectedProviders`
// uses (`packages/connections-tools/src/client.ts`) — this package
// cannot depend on that one directly (a workflow ships as its own npm
// tarball; `@corbits/connections-tools` is not part of that surface),
// so the fetch/paginate shape is duplicated rather than imported.
import { type } from "arktype";

import type { ExpiringCredential } from "./decide";

export interface CredentialExpiryClientConfig {
  /** The hub's plain HTTP origin. */
  readonly hubConnectionsUrl: string;
  readonly tenantId: string;
  readonly sidecarToken: string;
  readonly address: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

const ProvidersPage = type({
  data: type({ id: "string", name: "string" }).array(),
  "nextCursor?": "string | null",
});

const CredentialsPage = type({
  data: type({
    id: "string",
    providerId: "string",
    name: "string",
    status: "'active'|'expired'|'revoked'|'error'",
    "expiresAt?": "string | null",
  }).array(),
  "nextCursor?": "string | null",
});

const PAGE_LIMIT = 100;

function authHeaders(
  config: CredentialExpiryClientConfig,
): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.address,
  };
}

function tenantBase(config: CredentialExpiryClientConfig): string {
  return `${config.hubConnectionsUrl}/api/tenants/${encodeURIComponent(config.tenantId)}`;
}

/** Walks every page: a truncated first page would read as "nothing is
 * expiring," a wrong answer rather than a slow one. */
async function readAllPages<T>(
  config: CredentialExpiryClientConfig,
  path: string,
  what: string,
  parse: (
    body: unknown,
  ) =>
    | { data: readonly T[]; nextCursor?: string | null | undefined }
    | type.errors,
): Promise<readonly T[]> {
  const doFetch = config.fetchImpl ?? fetch;
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor !== undefined) params.set("cursor", cursor);
    const response = await doFetch(
      `${tenantBase(config)}${path}?${params.toString()}`,
      { headers: authHeaders(config) },
    );
    if (!response.ok) {
      throw new Error(
        `${what} failed: ${response.status} ${response.statusText}`,
      );
    }
    const parsed = parse(await response.json());
    if (parsed instanceof type.errors) {
      throw new Error(
        `${what} came back in an unexpected shape: ${parsed.summary}`,
      );
    }
    items.push(...parsed.data);
    const next = parsed.nextCursor;
    if (next === undefined || next === null) return items;
    cursor = next;
  }
}

/**
 * Every credential this tenant holds, paired with its owning provider's
 * display name. Throws on any transport, HTTP, or shape failure —
 * never fabricates a result, matching `listConnectedProviders`.
 */
export async function fetchTenantCredentials(
  config: CredentialExpiryClientConfig,
): Promise<readonly ExpiringCredential[]> {
  const [providers, credentials] = await Promise.all([
    readAllPages(config, "/providers", "Listing providers", (body) =>
      ProvidersPage(body),
    ),
    readAllPages(config, "/credentials", "Listing credentials", (body) =>
      CredentialsPage(body),
    ),
  ]);
  const providerNameById = new Map(
    providers.map((provider) => [provider.id, provider.name]),
  );
  return credentials.map((row) => ({
    credentialId: row.id,
    name: row.name,
    providerLabel: providerNameById.get(row.providerId) ?? row.providerId,
    status: row.status,
    expiresAt: row.expiresAt,
  }));
}
