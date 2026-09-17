// A minimal client for the two hub surfaces this bundle reads.
//
// `list_connections` reads the STOCK Interchange tenant routes —
// `/api/tenants/:tenantId/providers` and `/credentials` — with the workflow
// run's own bearer credential (sidecar token plus run address), which the hub
// resolves to this run's principal and tenant. A connector counts as
// connected when the tenant has an active credential against a provider named
// for it, the same `provider.name = connector id` keying an agent launch
// resolves a credential by. There is no Workbench-specific
// `/api/workflow-connections` mirror any more.
//
// `request_connection` still posts its `connect-service` card through the
// workflow-chat participant route; that surface is unchanged.
import { type } from "arktype";

export interface ConnectionsToolClientConfig {
  /** The hub's plain HTTP origin. */
  readonly hubConnectionsUrl: string;
  /** The run's own tenant — the `:tenantId` segment of a stock route. */
  readonly tenantId: string;
  readonly sidecarToken: string;
  readonly address: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** Which connectors this tenant currently has a live credential for.
 * Keyed by connector id — the caller pairs it with its own connector
 * registry for display names and docs links, which the hub does not know. */
export type ConnectedProviders = ReadonlySet<string>;

const ProvidersPage = type({
  data: type({ id: "string", name: "string" }).array(),
  "nextCursor?": "string | null",
});

const CredentialsPage = type({
  data: type({
    id: "string",
    providerId: "string",
    status: "'active'|'expired'|'revoked'",
  }).array(),
  "nextCursor?": "string | null",
});

const PAGE_LIMIT = 100;

function authHeaders(
  config: ConnectionsToolClientConfig,
): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.address,
  };
}

function tenantBase(config: ConnectionsToolClientConfig): string {
  return `${config.hubConnectionsUrl}/api/tenants/${encodeURIComponent(config.tenantId)}`;
}

/** Walks every page: a truncated first page would read as "not connected",
 * a wrong answer rather than a slow one. */
async function readAllPages<T>(
  config: ConnectionsToolClientConfig,
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

/** Connector ids this tenant currently has a live credential for. Throws on
 * any transport, HTTP, or shape failure — never fabricates a result.
 *
 * The stock provider listing already includes providers inherited from
 * ancestor tenants; the stock credential listing does not, so a credential
 * that only exists on a parent tenant reads as not connected here. Recorded
 * as an upstream ask rather than papered over with a second query. */
export async function listConnectedProviders(
  config: ConnectionsToolClientConfig,
): Promise<ConnectedProviders> {
  const [providers, credentials] = await Promise.all([
    readAllPages(config, "/providers", "Listing providers", (body) =>
      ProvidersPage(body),
    ),
    readAllPages(config, "/credentials", "Listing credentials", (body) =>
      CredentialsPage(body),
    ),
  ]);
  const liveProviderIds = new Set(
    credentials
      .filter((row) => row.status === "active")
      .map((row) => row.providerId),
  );
  return new Set(
    providers
      .filter((row) => liveProviderIds.has(row.id))
      .map((row) => row.name),
  );
}

/** Thrown when the caller's run has no room of its own to post into —
 * the workflow-participant route's "not a participant of any channel"
 * 404. `request_connection` degrades to a plain deep link then. */
export class NoOwnRoomError extends Error {}

const PostedMessageResponse = type({ id: "string", createdAt: "string" });

export type ConnectServiceCard = {
  readonly connectorId: string;
  readonly displayName: string;
  readonly reason: string;
};

/** Posts a `connect-service` block into the caller's own room through
 * the same workflow-run-authenticated `participants/messages` route
 * `@corbits/interaction-tools`' `ask_user` posts its question blocks
 * to. The card carries framing only; the room's client resolves the
 * live connect state when it renders. */
export async function postConnectServiceBlock(
  config: ConnectionsToolClientConfig,
  card: ConnectServiceCard,
): Promise<{ readonly messageId: string }> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(
    `${config.hubConnectionsUrl}/api/workflow-chat/participants/messages`,
    {
      method: "POST",
      headers: { ...authHeaders(config), "content-type": "application/json" },
      body: JSON.stringify({
        parts: [
          {
            kind: "block",
            block: {
              type: "connect-service",
              data: {
                connectorId: card.connectorId,
                displayName: card.displayName,
                reason: card.reason,
              },
            },
          },
        ],
      }),
    },
  );
  if (response.status === 404) {
    throw new NoOwnRoomError("The caller has no room of its own to post into");
  }
  if (!response.ok) {
    throw new Error(
      `Posting the connect card failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = PostedMessageResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Post-message response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return { messageId: parsed.id };
}
