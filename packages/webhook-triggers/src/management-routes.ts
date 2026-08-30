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
import { pgErrorCode, PG_UNIQUE_VIOLATION } from "@intx/db";

import { generateWebhookSecret } from "./signature";
import type { WebhookTriggerRow } from "./schema";
import type { WebhookTriggerStore } from "./store";

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

/**
 * True for a Postgres unique-violation (`23505`) — the shape a duplicate
 * `(tenant, workflow definition, name)` now raises through
 * `0003_webhook_trigger_tenant_definition_name_unique`. `pgErrorCode`
 * walks Drizzle's wrapped cause chain, since a real insert failure
 * arrives as a `DrizzleQueryError` rather than the raw driver error;
 * this package's in-memory test fake stamps `.code` directly to match.
 * Never silently retried as an `ensure`: this route's `create` promises
 * a genuinely new row, so a collision is reported to the caller as a
 * conflict rather than handed back someone else's trigger.
 */
function isUniqueViolation(error: unknown): boolean {
  return pgErrorCode(error) === PG_UNIQUE_VIOLATION;
}

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
  /**
   * When provided, `POST /` rejects with 404 if the workflow definition
   * is not in the request tenant. Tests may omit (always-allow).
   */
  workflowDefinitionInTenant?: (
    tenantId: string,
    definitionId: string,
  ) => Promise<boolean>;
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

    if (deps.workflowDefinitionInTenant !== undefined) {
      const owned = await deps.workflowDefinitionInTenant(
        tenant.id,
        body.workflowDefinitionId,
      );
      if (!owned) {
        return c.json(ErrorEnvelope("not_found", "definition not found"), 404);
      }
    }

    const secret = generateWebhookSecret();

    let row: WebhookTriggerRow;
    try {
      row = await deps.store.create({
        id: generateId("workflowRun"),
        tenantId: tenant.id,
        name: body.name,
        workflowDefinitionId: body.workflowDefinitionId,
        inputTemplate: body.inputTemplate,
        secret,
        createdBy: principal.id,
      });
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        return c.json(
          ErrorEnvelope(
            "conflict",
            "a trigger with this name already exists for this workflow definition",
          ),
          409,
        );
      }
      throw cause;
    }

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
