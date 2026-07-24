import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { getLogger } from "@intx/log";
import {
  recordProviderWebhookDelivery,
  resolveProviderWebhookCredential,
  type ProviderWebhookRegistry,
} from "../lib/provider-webhooks";
import type { HubDb } from "../db";

const log = getLogger(["routes", "webhooks-provider-triggers"]);

const MAX_BODY_BYTES = 256 * 1024;

const ErrorResponse = type({ error: "string" });
const OkResponse = type({ ok: "true" });

export type ProviderWebhookEvent = {
  provider: string;
  tenantId: string;
  tenantKey: string;
  deliveryId: string;
  webhookId: string;
  action: string;
  entityType: string;
  data: unknown;
};

export interface ProviderWebhookRouterDeps {
  db: HubDb;
  rootTenantId: string;
  registry: ProviderWebhookRegistry;
  /**
   * Runs once per NEW delivery (never on a dedupe-collapsed retry), after
   * the response has already been sent. CL-4269 scope is the receiver --
   * verify, route to the one configured tenant, dedupe, and durably record
   * the event -- so the default handler logs the verified event rather than
   * mapping it to a workflow run. Wiring specific provider events to
   * specific workflow triggers is intentionally left to a follow-up; this is
   * the seam that mapping plugs into.
   */
  onEvent?: (event: ProviderWebhookEvent) => Promise<void>;
}

async function defaultOnEvent(event: ProviderWebhookEvent): Promise<void> {
  log.info("provider webhook event verified and recorded", {
    provider: event.provider,
    tenantId: event.tenantId,
    tenantKey: event.tenantKey,
    deliveryId: event.deliveryId,
    webhookId: event.webhookId,
    action: event.action,
    entityType: event.entityType,
  });
}

/**
 * One receive surface for every signed provider webhook (CL-4269). A
 * provider is configuration plus a small `ProviderWebhookAdapter` — never
 * its own route. Adding GitHub/Slack/Attio means registering an adapter in
 * `registry`, not writing another endpoint.
 *
 * Distinct from `webhook-trigger-fire.ts`: that route authenticates by a
 * secret WE generate and the caller presents (`x-trigger-secret`); this one
 * authenticates by the PROVIDER signing the payload with ITS secret. Two
 * genuinely different auth models, kept as sibling routes rather than
 * conflated into one — the generic path has no per-provider signature
 * scheme to plug in, and a provider adapter has no caller-presented secret
 * to compare.
 *
 * Shared, provider-agnostic responsibilities live here: read the raw body
 * once (size-capped), resolve the adapter, resolve the tenant's secret,
 * verify the signature over the RAW body, enforce the replay window, dedupe
 * by `(provider, deliveryId)`, acknowledge fast (200), and dispatch the
 * verified event to `onEvent` OUTSIDE the request/response cycle — so a
 * slow or failing handler never risks the 5s timeout a provider like Linear
 * would count as delivery failure (repeated failures auto-disable the
 * webhook).
 */
export function createProviderWebhookRouter(
  deps: ProviderWebhookRouterDeps,
): Hono {
  const app = new Hono();
  const onEvent = deps.onEvent ?? defaultOnEvent;

  app.post(
    "/webhooks/triggers/:provider",
    describeRoute({
      tags: ["Triggers"],
      summary: "Receive a signed provider webhook delivery",
      responses: {
        200: {
          description: "Verified and accepted (including deduped retries)",
          content: { "application/json": { schema: resolver(OkResponse) } },
        },
        400: {
          description: "Malformed body, envelope, or missing delivery id",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        401: {
          description: "Missing/invalid signature or a stale timestamp",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: "Tenant key does not match the configured tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "No adapter is registered for this provider",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        413: {
          description: "Body exceeds the size ceiling",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        503: {
          description: "No webhook credential is configured for this provider",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const providerKey = c.req.param("provider");
      const adapter = deps.registry.get(providerKey);
      if (!adapter) {
        return c.json({ error: "unknown provider" }, 404);
      }

      const signatureHeaderValue = c.req.header(adapter.signatureHeader);
      if (!signatureHeaderValue) {
        log.warn("provider webhook: missing signature header; rejecting", {
          provider: providerKey,
        });
        return c.json({ error: "missing signature" }, 401);
      }

      const contentLength = c.req.header("content-length");
      if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
        return c.json({ error: "payload too large" }, 413);
      }

      const rawBody = await c.req.text();
      if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
        return c.json({ error: "payload too large" }, 413);
      }

      const credential = await resolveProviderWebhookCredential(
        deps.db,
        deps.rootTenantId,
        adapter,
      );
      if (!credential) {
        log.error("provider webhook: no credential configured", {
          provider: providerKey,
        });
        return c.json({ error: "webhook not configured" }, 503);
      }

      const signatureOk = adapter.verifySignature({
        rawBody,
        signatureHeaderValue,
        secret: credential.secret,
      });
      if (!signatureOk) {
        log.warn("provider webhook: signature mismatch; rejecting", {
          provider: providerKey,
        });
        return c.json({ error: "invalid signature" }, 401);
      }

      const payload = adapter.parsePayload(rawBody);
      if (payload === null) {
        return c.json({ error: "unrecognized payload" }, 400);
      }

      const timestampMs = adapter.extractTimestampMs(
        payload,
        c.req.raw.headers,
      );
      if (timestampMs === null) {
        log.warn("provider webhook: missing timestamp; rejecting", {
          provider: providerKey,
        });
        return c.json({ error: "missing timestamp" }, 401);
      }
      const skew = Math.abs(Date.now() - timestampMs);
      if (skew > adapter.replayToleranceMs) {
        log.warn("provider webhook: stale timestamp; rejecting", {
          provider: providerKey,
          skewMs: skew,
        });
        return c.json({ error: "stale timestamp" }, 401);
      }

      const tenantKey = adapter.extractTenantKey(payload);
      if (!tenantKey) {
        return c.json({ error: "payload has no tenant key" }, 400);
      }
      // Signature is verified against the ONE configured secret, so this can
      // only fail if the payload's tenant key disagrees with the value the
      // owner configured alongside that secret -- never guessed, always an
      // explicit rejection.
      if (tenantKey !== credential.tenantKey) {
        log.warn(
          "provider webhook: tenant key does not match the configured tenant; rejecting",
          { provider: providerKey, tenantKey },
        );
        return c.json({ error: "unknown tenant" }, 403);
      }

      const deliveryMeta = adapter.extractDeliveryMeta(payload);
      if (!deliveryMeta) {
        return c.json({ error: "unrecognized payload" }, 400);
      }

      const deliveryId = c.req.header(adapter.deliveryIdHeader);
      if (!deliveryId) {
        log.warn("provider webhook: missing delivery id header", {
          provider: providerKey,
        });
        return c.json({ error: "missing delivery id" }, 400);
      }

      const isNewDelivery = await recordProviderWebhookDelivery(deps.db, {
        provider: providerKey,
        deliveryId,
        tenantId: credential.tenantId,
        tenantKey: credential.tenantKey,
        action: deliveryMeta.action,
        entityType: deliveryMeta.entityType,
      });

      if (isNewDelivery) {
        // Detached: the handler's own duration must never count against a
        // provider's response timeout, and a downstream failure there is not
        // this delivery's failure -- it was already durably recorded above.
        void onEvent({
          provider: providerKey,
          tenantId: credential.tenantId,
          tenantKey: credential.tenantKey,
          deliveryId,
          webhookId: deliveryMeta.webhookId,
          action: deliveryMeta.action,
          entityType: deliveryMeta.entityType,
          data: deliveryMeta.data,
        }).catch((err) => {
          log.error("provider webhook: onEvent handler failed", {
            provider: providerKey,
            deliveryId,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        });
      } else {
        log.info("provider webhook: duplicate delivery, not re-fired", {
          provider: providerKey,
          deliveryId,
        });
      }

      return c.json({ ok: true }, 200);
    },
  );

  return app;
}
