// Shared test harness for `createWebhookTriggerRoutes`' HTTP surface:
// an in-memory `WebhookTriggerStore` fake and a tenant/principal-
// injecting mount, mirroring `@corbits/chat`'s `test/test-support.ts`.
// Not a production module — lives in `test/` only.
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { TenantEnv } from "@intx/hub-api";
import type { WebhookTriggerRow } from "../src/schema";
import type {
  CreateWebhookTriggerInput,
  WebhookTriggerStore,
} from "../src/store";

export const TENANT = {
  id: "tnt_1",
  name: "Acme",
  slug: "acme",
  domain: "acme.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

export function principal(id: string) {
  return {
    id,
    tenantId: TENANT.id,
    kind: "user" as const,
    refId: id,
    status: "active" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export function createInMemoryWebhookTriggerStore(): WebhookTriggerStore {
  const rows = new Map<string, WebhookTriggerRow>();

  function findByName(
    tenantId: string,
    workflowDefinitionId: string,
    name: string,
  ): WebhookTriggerRow | undefined {
    return [...rows.values()].find(
      (row) =>
        row.tenantId === tenantId &&
        row.workflowDefinitionId === workflowDefinitionId &&
        row.name === name,
    );
  }

  function newRow(input: CreateWebhookTriggerInput): WebhookTriggerRow {
    return {
      id: input.id,
      tenantId: input.tenantId,
      name: input.name,
      workflowDefinitionId: input.workflowDefinitionId,
      inputTemplate: input.inputTemplate,
      secret: input.secret,
      enabled: true,
      createdBy: input.createdBy,
      createdAt: new Date(),
      lastFiredAt: null,
    };
  }

  return {
    async create(input: CreateWebhookTriggerInput) {
      if (findByName(input.tenantId, input.workflowDefinitionId, input.name)) {
        // Mirrors the real driver's shape for a `23505` unique
        // violation, so callers exercising `isUniqueViolation`-style
        // handling against this fake see the same thing production does.
        throw Object.assign(
          new Error(
            `webhook trigger ${input.name} already exists for this workflow definition`,
          ),
          { code: "23505" },
        );
      }
      const row = newRow(input);
      rows.set(row.id, row);
      return row;
    },
    async ensure(input: CreateWebhookTriggerInput) {
      const existing = findByName(
        input.tenantId,
        input.workflowDefinitionId,
        input.name,
      );
      if (existing) return existing;
      const row = newRow(input);
      rows.set(row.id, row);
      return row;
    },
    async get(tenantId, triggerId) {
      const row = rows.get(triggerId);
      return row?.tenantId === tenantId ? row : undefined;
    },
    async getById(triggerId) {
      return rows.get(triggerId);
    },
    async list(tenantId) {
      return [...rows.values()].filter((row) => row.tenantId === tenantId);
    },
    async rotateSecret(tenantId, triggerId, secret) {
      const row = rows.get(triggerId);
      if (row === undefined || row.tenantId !== tenantId) return undefined;
      const updated = { ...row, secret };
      rows.set(triggerId, updated);
      return updated;
    },
    async setEnabled(tenantId, triggerId, enabled) {
      const row = rows.get(triggerId);
      if (row === undefined || row.tenantId !== tenantId) return undefined;
      const updated = { ...row, enabled };
      rows.set(triggerId, updated);
      return updated;
    },
    async recordFired(triggerId, firedAt) {
      const row = rows.get(triggerId);
      if (row === undefined) return;
      rows.set(triggerId, { ...row, lastFiredAt: firedAt });
    },
    async remove(tenantId, triggerId) {
      const row = rows.get(triggerId);
      if (row === undefined || row.tenantId !== tenantId) return false;
      rows.delete(triggerId);
      return true;
    },
  };
}

export function mountAs(
  routes: Hono<TenantEnv>,
  principalId: string,
): Hono<TenantEnv> {
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", principal(principalId));
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asPrincipal);
  app.route("/", routes);
  return app;
}
