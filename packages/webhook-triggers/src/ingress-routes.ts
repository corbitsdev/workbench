// The external-facing half of this package: a service outside
// Workbench's control (Granola, or anything else) posts here to kick
// off a workflow run. This is THE trust boundary — no session cookie,
// no tenant membership, nothing about the caller is trusted except
// what the HMAC signature over the raw body proves. Every failure
// mode here is loud and specific in the log, but deliberately generic
// (`invalid signature`, `not found`) in the HTTP response, so a probe
// against a wrong triggerId cannot distinguish "no such trigger" from
// "wrong secret" from an unlisted host.
import { Hono } from "hono";
import type { Env } from "hono";
import { getLogger } from "@intx/log";

import type { LaunchedWebhookTrigger } from "./launch";
import { WEBHOOK_SIGNATURE_HEADER, verifySignature } from "./signature";
import type { WebhookTriggerRow } from "./schema";
import type { WebhookTriggerStore } from "./store";

const log = getLogger(["webhook-triggers", "ingress"]);

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

export type CreateWebhookIngressRoutesDeps = {
  store: WebhookTriggerStore;
  /**
   * The hub composes this as `(trigger, payload) =>
   * launchWebhookTrigger(deps, trigger, payload)`, closing over the
   * real folded-runs deps — kept as a seam here (rather than this
   * module importing `launchWebhookTrigger` directly) so the route's
   * own parsing/signature/lookup logic is testable without a database
   * or the launch machinery.
   */
  launch: (
    trigger: WebhookTriggerRow,
    payload: unknown,
  ) => Promise<LaunchedWebhookTrigger>;
};

/**
 * Mounts `POST /:triggerId`, the single ingress endpoint. Intended to
 * be mounted OUTSIDE the platform's `resolveTenant` middleware — this
 * route resolves its own tenant scope by looking the trigger up by
 * id, since the caller carries no session and no tenant path segment.
 */
export function createWebhookIngressRoutes(
  deps: CreateWebhookIngressRoutesDeps,
): Hono<Env> {
  const app = new Hono<Env>();

  app.post("/:triggerId", async (c) => {
    const triggerId = c.req.param("triggerId");
    const trigger = await deps.store.getById(triggerId);
    if (trigger === undefined) {
      log.info("Webhook delivery for unknown trigger {triggerId}", {
        triggerId,
      });
      return c.json(ErrorEnvelope("not_found", "trigger not found"), 404);
    }

    if (!trigger.enabled) {
      log.info("Webhook delivery for disabled trigger {triggerId}", {
        triggerId,
      });
      return c.json(ErrorEnvelope("forbidden", "trigger is disabled"), 403);
    }

    const rawBody = await c.req.text();
    const signatureHeader = c.req.header(WEBHOOK_SIGNATURE_HEADER);
    if (!verifySignature(trigger.secret, rawBody, signatureHeader)) {
      log.warn(
        "Rejected webhook delivery for trigger {triggerId}: bad signature",
        {
          triggerId,
        },
      );
      return c.json(
        ErrorEnvelope("unauthorized", "invalid or missing signature"),
        401,
      );
    }

    let payload: unknown;
    try {
      payload = rawBody === "" ? {} : JSON.parse(rawBody);
    } catch {
      return c.json(
        ErrorEnvelope("bad_request", "payload is not valid JSON"),
        400,
      );
    }

    const launched = await deps.launch(trigger, payload);
    await deps.store.recordFired(trigger.id, new Date());

    return c.json(
      { instanceId: launched.instanceId, address: launched.triggerAddress },
      202,
    );
  });

  return app;
}
