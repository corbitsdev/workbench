// Workflow-run-authenticated catalog-admin surface: the execution half of
// `@corbits/catalog-tools`' `create_offering`, `set_offering_priority`, and
// `disable_offering` tools. A workflow child has no browser session, only
// its sidecar bearer token and its own run address, so it cannot use
// `@intx/hub-api`'s tenant-session `/api/tenants/:id/catalog/{models,
// providers,offerings}` routes directly — the same reasoning
// `@corbits/access-tools`'s own `/api/workflow-access` mirror gives for its
// principal/grant surface.
//
// Mounted OUTSIDE the tenant prefix for that reason, at
// `/api/workflow-catalog-admin`. Every write is scoped to the authenticated
// run's own tenant alone — identity never rides in a request body.
//
// This is a thin wrapper, not a reimplementation: every route below reads
// or writes the SAME `model`/`modelProvider`/`modelOffering` rows
// `@intx/hub-api`'s own tenant-session catalog routes do
// (`vendor/intx/hub-api/src/routes/model-offerings.ts` and friends), and
// authorization runs through the SAME `createRequireGrant` against the
// same grant store and condition registry, resolved for the caller's real
// tenant/principal rows exactly like `@corbits/access-tools`' own
// `/api/workflow-access` mount resolves them. Those route factories aren't
// exported from `@intx/hub-api`'s public surface (only mounted internally
// by its own `createApp`), so this reimplements only their thin handler
// bodies against the shared schema and shared response shapes from
// `@intx/types` — never the grant-store authorization itself. Every
// offering write also pushes the same `pushSourceUpdatesSubtree` sidecar
// refresh the tenant-session routes push, so a running instance resolves
// the change the same way either surface made it.
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type } from "arktype";

import type { DB } from "@intx/db";
import { model, modelProvider, modelOffering } from "@intx/db/schema";
import { parseModelOfferingRow } from "@intx/db";
import { generateId } from "@intx/hub-common";
import {
  createRequireGrant,
  idResource,
  type RequireGrant,
  type TenantEnv,
} from "@intx/hub-api";
import type { ConditionRegistry, GrantStore } from "@intx/types/authz";
import {
  CreateModelOffering,
  UpdateModelOffering,
  base64urlDecode,
  base64urlEncode,
  type CredentialCipher,
} from "@intx/types";
import { makeErrorEnvelope } from "@corbits/error-sink";
import {
  pushSourceUpdatesSubtree,
  type SidecarRouter,
} from "@intx/hub-sessions";

export type WorkflowCatalogAdminRunScope = {
  readonly tenantId: string;
  readonly principalId: string;
};

export type WorkflowRunAuthenticator = {
  resolve(
    token: string,
    runAddress: string,
  ): Promise<WorkflowCatalogAdminRunScope | null>;
};

export type CreateWorkflowCatalogAdminRoutesDeps = {
  db: DB["db"];
  authenticator: WorkflowRunAuthenticator;
  grantStore: GrantStore;
  conditionRegistry: ConditionRegistry;
  sidecarRouter: SidecarRouter;
  credentialCipher: CredentialCipher;
};

function formatModel(row: typeof model.$inferSelect) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    canonicalName: row.canonicalName,
    displayName: row.displayName,
    description: row.description,
    disabled: row.disabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function formatModelProvider(row: typeof modelProvider.$inferSelect) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    plugin: row.plugin,
    baseURL: row.baseURL,
    credentialId: row.credentialId,
    walletId: row.walletId,
    disabled: row.disabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function formatModelOffering(row: typeof modelOffering.$inferSelect) {
  const parsed = parseModelOfferingRow(row);
  return {
    id: parsed.id,
    tenantId: parsed.tenantId,
    modelId: parsed.modelId,
    providerId: parsed.providerId,
    priority: parsed.priority,
    deploymentTags: parsed.deploymentTags,
    capabilities: parsed.capabilities,
    quirks: parsed.quirks,
    disabled: parsed.disabled,
    createdAt: parsed.createdAt.toISOString(),
    updatedAt: parsed.updatedAt.toISOString(),
  };
}

// --- Minimal keyset pagination, mirroring `@intx/hub-api`'s own
// `parsePageParams`/`cursorCondition`/`pageOrder`/`paginatedResponse`
// (`vendor/intx/hub-api/src/pagination.ts`) — not exported from its
// public surface, so reimplemented here at the same, small, generic
// shape rather than duplicating any domain logic. -----------------------

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const CursorData = type({
  t: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  id: "string",
});
type CursorData = typeof CursorData.infer;

function encodeCursor(createdAt: Date, id: string): string {
  const data: CursorData = { t: createdAt.toISOString(), id };
  return base64urlEncode(new TextEncoder().encode(JSON.stringify(data)));
}

function decodeCursor(cursor: string): CursorData | null {
  try {
    const json = new TextDecoder().decode(base64urlDecode(cursor));
    const parsed: unknown = JSON.parse(json);
    const data = CursorData(parsed);
    return data instanceof type.errors ? null : data;
  } catch {
    // report-error-ignore: a malformed opaque cursor is a client passing
    // back garbage, not an operational incident — treated the same as
    // the arktype mismatch just above, both fall through to `null` and
    // the caller starts the listing over from the first page.
    return null;
  }
}

function parsePageParams(query: {
  cursor: string | undefined;
  limit: string | undefined;
}): { limit: number; cursor: CursorData | null } {
  const raw = query.limit ? Number(query.limit) : DEFAULT_LIMIT;
  const limit = Number.isNaN(raw)
    ? DEFAULT_LIMIT
    : Math.min(Math.max(1, raw), MAX_LIMIT);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  return { limit, cursor };
}

function paginatedResponse<T>(
  items: T[],
  rows: { createdAt: Date; id: string }[],
  limit: number,
): { data: T[]; nextCursor: string | null } {
  const hasMore = items.length === limit;
  const lastRow = hasMore ? rows[rows.length - 1] : undefined;
  return {
    data: items,
    nextCursor: lastRow ? encodeCursor(lastRow.createdAt, lastRow.id) : null,
  };
}

export function createWorkflowCatalogAdminRoutes(
  deps: CreateWorkflowCatalogAdminRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  const requireGrant: RequireGrant = createRequireGrant({
    grantStore: deps.grantStore,
    conditionRegistry: deps.conditionRegistry,
  });

  app.use("*", async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";
    const address = c.req.header("x-workflow-run-address") ?? "";
    const scope = await deps.authenticator.resolve(token, address);
    if (scope === null) {
      return c.json(
        makeErrorEnvelope({
          code: "unauthorized",
          userMessage:
            "Missing or unrecognized sidecar bearer token / run address",
        }),
        401,
      );
    }

    const [tenantRow, principalRow] = await Promise.all([
      deps.db.query.tenant.findFirst({
        where: (row, { eq: eqCol }) => eqCol(row.id, scope.tenantId),
      }),
      deps.db.query.principal.findFirst({
        where: (row, { and: andCols, eq: eqCol }) =>
          andCols(
            eqCol(row.id, scope.principalId),
            eqCol(row.tenantId, scope.tenantId),
          ),
      }),
    ]);
    if (
      tenantRow === undefined ||
      principalRow === undefined ||
      principalRow.status !== "active"
    ) {
      return c.json(
        makeErrorEnvelope({
          code: "unauthorized",
          userMessage:
            "Missing or unrecognized sidecar bearer token / run address",
        }),
        401,
      );
    }
    c.set("tenant", tenantRow);
    c.set("principal", principalRow);
    await next();
  });

  app.get("/models", requireGrant("model:*", "read"), async (c) => {
    const tenantCtx = c.get("tenant");
    const { limit, cursor } = parsePageParams({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });
    const conditions = [eq(model.tenantId, tenantCtx.id)];
    if (cursor) {
      conditions.push(
        // Both branches always produce valid SQL, so or() never actually
        // returns undefined here (mirroring
        // `vendor/intx/hub-api/src/pagination.ts`'s `cursorCondition`).
        or(
          lt(model.createdAt, new Date(cursor.t)),
          and(eq(model.createdAt, new Date(cursor.t)), lt(model.id, cursor.id)),
        ) ?? sql`false`,
      );
    }
    const rows = await deps.db.query.model.findMany({
      where: and(...conditions),
      orderBy: [desc(model.createdAt), desc(model.id)],
      limit,
    });
    return c.json(paginatedResponse(rows.map(formatModel), rows, limit));
  });

  app.get("/providers", requireGrant("model-provider:*", "read"), async (c) => {
    const tenantCtx = c.get("tenant");
    const { limit, cursor } = parsePageParams({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });
    const conditions = [eq(modelProvider.tenantId, tenantCtx.id)];
    if (cursor) {
      conditions.push(
        // Both branches always produce valid SQL, so or() never actually
        // returns undefined here (mirroring
        // `vendor/intx/hub-api/src/pagination.ts`'s `cursorCondition`).
        or(
          lt(modelProvider.createdAt, new Date(cursor.t)),
          and(
            eq(modelProvider.createdAt, new Date(cursor.t)),
            lt(modelProvider.id, cursor.id),
          ),
        ) ?? sql`false`,
      );
    }
    const rows = await deps.db.query.modelProvider.findMany({
      where: and(...conditions),
      orderBy: [desc(modelProvider.createdAt), desc(modelProvider.id)],
      limit,
    });
    return c.json(
      paginatedResponse(rows.map(formatModelProvider), rows, limit),
    );
  });

  app.post(
    "/offerings",
    requireGrant("model-offering:*", "create"),
    async (c) => {
      const tenantCtx = c.get("tenant");
      const body = CreateModelOffering(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid offering request: ${body.summary}`,
          }),
          400,
        );
      }

      const modelRow = await deps.db.query.model.findFirst({
        where: and(
          eq(model.id, body.modelId),
          eq(model.tenantId, tenantCtx.id),
        ),
      });
      if (modelRow === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "Model not found in this tenant",
          }),
          404,
        );
      }

      const providerRow = await deps.db.query.modelProvider.findFirst({
        where: and(
          eq(modelProvider.id, body.providerId),
          eq(modelProvider.tenantId, tenantCtx.id),
        ),
      });
      if (providerRow === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "Provider not found in this tenant",
          }),
          404,
        );
      }

      const existing = await deps.db.query.modelOffering.findFirst({
        where: and(
          eq(modelOffering.tenantId, tenantCtx.id),
          eq(modelOffering.modelId, body.modelId),
          eq(modelOffering.providerId, body.providerId),
        ),
      });
      if (existing !== undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "conflict",
            userMessage:
              "An offering for this model and provider already exists",
          }),
          409,
        );
      }

      const now = new Date();
      const [row] = await deps.db
        .insert(modelOffering)
        .values({
          id: generateId("modelOffering"),
          tenantId: tenantCtx.id,
          modelId: body.modelId,
          providerId: body.providerId,
          priority: body.priority ?? 0,
          deploymentTags: body.deploymentTags ?? [],
          capabilities: body.capabilities ?? [],
          quirks: body.quirks ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (row === undefined) {
        throw new Error("Insert into model_offering returned no row");
      }

      void pushSourceUpdatesSubtree(
        deps.db,
        deps.sidecarRouter,
        tenantCtx.id,
        deps.credentialCipher,
      );
      return c.json(formatModelOffering(row), 201);
    },
  );

  app.patch(
    "/offerings/:offeringId",
    requireGrant(idResource("model-offering", "offeringId"), "manage"),
    async (c) => {
      const tenantCtx = c.get("tenant");
      const offeringId = c.req.param("offeringId");
      const body = UpdateModelOffering(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid offering update: ${body.summary}`,
          }),
          400,
        );
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.priority !== undefined) updates["priority"] = body.priority;
      if (body.deploymentTags !== undefined)
        updates["deploymentTags"] = body.deploymentTags;
      if (body.capabilities !== undefined)
        updates["capabilities"] = body.capabilities;
      if (body.quirks !== undefined) updates["quirks"] = body.quirks;
      if (body.disabled !== undefined) updates["disabled"] = body.disabled;

      const [updated] = await deps.db
        .update(modelOffering)
        .set(updates)
        .where(
          and(
            eq(modelOffering.id, offeringId),
            eq(modelOffering.tenantId, tenantCtx.id),
          ),
        )
        .returning();

      if (updated === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: `No offering "${offeringId}" in this tenant`,
          }),
          404,
        );
      }

      void pushSourceUpdatesSubtree(
        deps.db,
        deps.sidecarRouter,
        tenantCtx.id,
        deps.credentialCipher,
      );
      return c.json(formatModelOffering(updated));
    },
  );

  return app;
}
