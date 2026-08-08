// Tenant-scoped CRUD over triggers, mounted inside the platform's
// native tenant middleware (`TenantEnv`'s `tenant`/`principal` are
// resolved before any handler here runs, the same way
// `@corbits/chat`'s `routes.ts` relies on it). This is a management
// surface, not the trust boundary — that is `./ingress-routes.ts`,
// mounted separately and unauthenticated by design.
//
// The secret is generated here (server-side, `crypto.randomBytes` via
// `./signature.ts`) and returned exactly once: in the create response
// and in the rotate response. Every other response — get, list — omits
// it entirely, never even a redacted form.
import { Hono } from "hono";
import { type } from "arktype";

import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { idResource } from "@intx/hub-api";
import { generateId } from "@intx/hub-common";

import { generateWebhookSecret } from "./signature";
import type { WebhookTriggerRow } from "./schema";
import type { WebhookTriggerStore } from "./store";

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

const CreateTriggerBody = type({
  name: "string",
  workflowDefinitionId: "string",
  inputTemplate: "string",
});

const SetEnabledBody = type({
  enabled: "boolean",
});

/**
 * Every field of a trigger except its secret — the shape returned by
 * list/get/enable/disable, and by create/rotate alongside a one-time
 * `secret` field those two responses add.
 */
function publicView(row: WebhookTriggerRow) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    workflowDefinitionId: row.workflowDefinitionId,
    inputTemplate: row.inputTemplate,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
  };
}

export type CreateWebhookTriggerRoutesDeps = {
  store: WebhookTriggerStore;
  requireGrant: RequireGrant;
};

export function createWebhookTriggerRoutes(
  deps: CreateWebhookTriggerRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.post("/", deps.requireGrant("webhook-trigger:*", "create"), async (c) => {
    const body = CreateTriggerBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        ErrorEnvelope("bad_request", `invalid trigger body: ${body.summary}`),
        400,
      );
    }

    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const secret = generateWebhookSecret();

    const row = await deps.store.create({
      id: generateId("instance"),
      tenantId: tenant.id,
      name: body.name,
      workflowDefinitionId: body.workflowDefinitionId,
      inputTemplate: body.inputTemplate,
      secret,
      createdBy: principal.id,
    });

    return c.json({ ...publicView(row), secret }, 201);
  });

  app.get("/", deps.requireGrant("webhook-trigger:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const rows = await deps.store.list(tenant.id);
    return c.json({ items: rows.map(publicView) });
  });

  app.get(
    "/:id",
    deps.requireGrant(idResource("webhook-trigger", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const row = await deps.store.get(tenant.id, c.req.param("id"));
      if (row === undefined) {
        return c.json(ErrorEnvelope("not_found", "trigger not found"), 404);
      }
      return c.json(publicView(row));
    },
  );

  app.post(
    "/:id/rotate-secret",
    deps.requireGrant(idResource("webhook-trigger", "id"), "write"),
    async (c) => {
      const tenant = c.get("tenant");
      const secret = generateWebhookSecret();
      const row = await deps.store.rotateSecret(
        tenant.id,
        c.req.param("id"),
        secret,
      );
      if (row === undefined) {
        return c.json(ErrorEnvelope("not_found", "trigger not found"), 404);
      }
      return c.json({ ...publicView(row), secret });
    },
  );

  app.post(
    "/:id/enabled",
    deps.requireGrant(idResource("webhook-trigger", "id"), "write"),
    async (c) => {
      const body = SetEnabledBody(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          ErrorEnvelope("bad_request", `invalid enabled body: ${body.summary}`),
          400,
        );
      }
      const tenant = c.get("tenant");
      const row = await deps.store.setEnabled(
        tenant.id,
        c.req.param("id"),
        body.enabled,
      );
      if (row === undefined) {
        return c.json(ErrorEnvelope("not_found", "trigger not found"), 404);
      }
      return c.json(publicView(row));
    },
  );

  app.delete(
    "/:id",
    deps.requireGrant(idResource("webhook-trigger", "id"), "delete"),
    async (c) => {
      const tenant = c.get("tenant");
      const removed = await deps.store.remove(tenant.id, c.req.param("id"));
      if (!removed) {
        return c.json(ErrorEnvelope("not_found", "trigger not found"), 404);
      }
      return c.body(null, 204);
    },
  );

  return app;
}
