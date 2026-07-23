import { and, eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import type { HubDb } from "../db";
import { providerWebhookDelivery } from "../db/schema";
import { decryptToolCredentialSecret } from "./credential-crypto";

const { provider, credential } = intxSchema;

/**
 * What a provider webhook adapter supplies. The generic receiver
 * (`createProviderWebhookRouter`) owns everything shared across providers --
 * reading the raw body once, size limits, dedupe storage, the fast
 * acknowledge, and dispatch. Everything that genuinely varies per provider
 * (signature scheme, replay-window source, delivery-id header, tenant-key
 * field, secret storage key) lives here instead. Adding a provider means
 * writing one of these and registering it -- never a new route.
 */
export interface ProviderWebhookAdapter {
  /** Short key identifying this provider: URL path segment, credential
   * providerName suffix (`<provider>-webhook`), and the `provider` column in
   * the dedupe ledger. Lowercase, no spaces (e.g. "linear"). */
  readonly provider: string;
  /** Header carrying the signature (e.g. "linear-signature"). */
  readonly signatureHeader: string;
  /** Header carrying the provider's own per-delivery id (e.g.
   * "linear-delivery"), used for dedupe together with `provider`. */
  readonly deliveryIdHeader: string;
  /** How far a delivery's timestamp may drift from receipt time before it is
   * rejected as a possible replay. */
  readonly replayToleranceMs: number;
  /** The `provider` row's `metadata` key the owner-configured tenant key
   * (e.g. Linear's `organizationId`) is stored under, alongside the secret,
   * via Owner -> Capabilities (`<provider>-webhook` catalog entry). */
  readonly tenantKeyMetadataField: string;

  /** Parse the raw body into the provider's payload shape. Returns `null` on
   * malformed JSON/envelope -- the router responds 400. */
  parsePayload(rawBody: string): unknown | null;
  /** Verify the signature header against the RAW body and the resolved
   * secret. Must be constant-time; never throws on a malformed header. */
  verifySignature(args: {
    rawBody: string;
    signatureHeaderValue: string;
    secret: string;
  }): boolean;
  /** The provider-native tenant identifier this delivery claims (e.g.
   * Linear's `organizationId`). `null` if the payload does not carry one --
   * the router responds 400 rather than routing blind. */
  extractTenantKey(payload: unknown): string | null;
  /** Unix ms the provider stamped this delivery at, read from wherever the
   * provider puts it (header or payload). `null` if absent -- treated the
   * same as a stale timestamp (replay guard must not be bypassable by
   * omission). */
  extractTimestampMs(payload: unknown, headers: Headers): number | null;
  /** The event's action/entity-type/provider-native id/entity body, for the
   * dedupe ledger and the event handed to `onEvent`. `null` on a payload
   * shape the adapter cannot make sense of -- the router responds 400. */
  extractDeliveryMeta(payload: unknown): {
    action: string;
    entityType: string;
    webhookId: string;
    data: unknown;
  } | null;
}

export type ProviderWebhookRegistry = ReadonlyMap<
  string,
  ProviderWebhookAdapter
>;

export function createProviderWebhookRegistry(
  adapters: readonly ProviderWebhookAdapter[],
): ProviderWebhookRegistry {
  const map = new Map<string, ProviderWebhookAdapter>();
  for (const adapter of adapters) {
    map.set(adapter.provider, adapter);
  }
  return map;
}

export type ProviderWebhookCredential = {
  tenantId: string;
  tenantKey: string;
  secret: string;
};

// The workbench is one root tenant per deployment -- there is exactly one
// place an owner can set a provider's webhook signing secret + the tenant
// key it belongs to (Owner -> Capabilities, provider `<provider>-webhook`),
// so "tenant routing" here is not a lookup across many tenants: it is
// comparing the delivery's claimed tenant key against the ONE configured
// value and rejecting anything else explicitly rather than guessing. If a
// future deployment shape needs several external workspaces routed to
// distinct tenants from one hub, this is the single seam to widen (scan
// credential rows for the tenant-key metadata field instead of reading the
// one root-tenant row).
export async function resolveProviderWebhookCredential(
  db: HubDb,
  rootTenantId: string,
  adapter: Pick<ProviderWebhookAdapter, "provider" | "tenantKeyMetadataField">,
): Promise<ProviderWebhookCredential | null> {
  const providerName = `${adapter.provider}-webhook`;

  const providerRow = await db.query.provider.findFirst({
    where: and(
      eq(provider.tenantId, rootTenantId),
      eq(provider.name, providerName),
    ),
    columns: { id: true, metadata: true },
  });
  if (!providerRow) return null;

  const credentialRow = await db.query.credential.findFirst({
    where: and(
      eq(credential.tenantId, rootTenantId),
      eq(credential.providerId, providerRow.id),
    ),
    columns: { secret: true },
  });
  if (!credentialRow) return null;

  const metadata = providerRow.metadata;
  const tenantKey =
    typeof metadata === "object" &&
    metadata !== null &&
    typeof (metadata as Record<string, unknown>)[
      adapter.tenantKeyMetadataField
    ] === "string"
      ? ((metadata as Record<string, unknown>)[
          adapter.tenantKeyMetadataField
        ] as string)
      : null;
  if (!tenantKey) return null;

  return {
    tenantId: rootTenantId,
    tenantKey,
    secret: decryptToolCredentialSecret(credentialRow.secret),
  };
}

// Idempotency ledger insert keyed by `(provider, deliveryId)`. Returns true
// the first time a delivery is seen (the caller should dispatch the
// handler), false on any retry (the caller acks 200 without re-dispatching).
// The unique primary key -- not a lookup-then-insert -- is what makes this
// race-safe under a provider's concurrent-retry behavior.
export async function recordProviderWebhookDelivery(
  db: HubDb,
  args: {
    provider: string;
    deliveryId: string;
    tenantId: string;
    tenantKey: string;
    action: string;
    entityType: string;
  },
): Promise<boolean> {
  const id = `${args.provider}:${args.deliveryId}`;
  const inserted = await db
    .insert(providerWebhookDelivery)
    .values({
      id,
      provider: args.provider,
      deliveryId: args.deliveryId,
      tenantId: args.tenantId,
      tenantKey: args.tenantKey,
      action: args.action,
      entityType: args.entityType,
    })
    .onConflictDoNothing({ target: providerWebhookDelivery.id })
    .returning({ id: providerWebhookDelivery.id });
  return inserted.length > 0;
}
