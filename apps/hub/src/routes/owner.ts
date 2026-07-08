import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { type GrantStore } from "@intx/authz";
import { schema as intxSchema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  CREDENTIAL_PROVIDER_CATALOG,
  MEMBER_ROLE_NAME,
  OwnerContextResponse,
  OwnerCredentialSetBody,
  OwnerCredentialsResponse,
  OwnerCredentialStateSchema,
  OwnerWorkflowsResponse,
  OwnerWorkflowState,
  OwnerWorkflowToggle,
  WORKFLOW_RUN_ACTION,
  workflowRunResource,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { workflowRun } from "../db/schema";
import { createOwnerGrantGuard } from "../lib/admin-grant";
import { recordAudit } from "../services/admin-audit";

const { role, grant, credential, provider } = intxSchema;

// The org member role is the tenant's baseline run policy (see the CL-2885 run
// gate): a `deny` grant on it for `workflow:<kind>`/`run` disables that kind.
async function memberRoleId(
  db: HubDb,
  tenantId: string,
): Promise<string | null> {
  const row = await db.query.role.findFirst({
    where: and(
      eq(role.tenantId, tenantId),
      eq(role.name, MEMBER_ROLE_NAME),
      eq(role.isSystem, true),
    ),
    columns: { id: true },
  });
  return row?.id ?? null;
}

type OwnerRouteEnv = {
  Variables: { userId: string; ownerPrincipalId: string };
};

export interface CreateOwnerRouterDeps {
  db: HubDb;
  grantStore: GrantStore;
  rootTenantId: string;
}

/**
 * The Owner area's server surface. Mounted on the session-authenticated
 * `/api/v1` app; EVERY route is behind the OWNER grant guard so access is
 * enforced at the hub, not merely hidden in the web nav. Owner is strictly
 * stronger than admin: an ABK Labs owner (owner role, `*`/`*`) passes; a
 * customer admin does not. Governance is scoped to the root (global org) tenant,
 * the same tenant the guard authorizes against.
 */
export function createOwnerRouter(
  deps: CreateOwnerRouterDeps,
): Hono<OwnerRouteEnv> {
  const { db, grantStore, rootTenantId } = deps;
  const router = new Hono<OwnerRouteEnv>();

  router.use(
    "/owner/*",
    createOwnerGrantGuard({ db, grantStore, rootTenantId }),
  );

  // Owner identity/context for the current session. The `/owner` web shell
  // reads this to confirm owner access and learn which root tenant it governs.
  router.get(
    "/owner/context",
    describeRoute({
      description: "Owner identity and the root tenant the owner governs.",
      responses: {
        200: {
          description: "Owner context",
          content: {
            "application/json": {
              schema: resolver(OwnerContextResponse),
            },
          },
        },
      },
    }),
    (c) =>
      c.json({
        tenantId: rootTenantId,
        ownerPrincipalId: c.get("ownerPrincipalId"),
      }),
  );

  // Deployed workflow kinds with their run-enablement state. `enabled` is false
  // when the org member role holds a `deny` for that kind (or `workflow:*`) —
  // the same signal the CL-2885 run gate enforces.
  router.get(
    "/owner/workflows",
    describeRoute({
      description:
        "Deployed workflow kinds and whether each is enabled to run.",
      responses: {
        200: {
          description: "Owner workflows",
          content: {
            "application/json": { schema: resolver(OwnerWorkflowsResponse) },
          },
        },
      },
    }),
    async (c) => {
      const deployments = await db.query.workflowRun.findMany({
        where: and(
          eq(workflowRun.tenantId, rootTenantId),
          isNotNull(workflowRun.deploymentId),
          isNull(workflowRun.deletedAt),
        ),
        columns: { kind: true },
      });
      const kinds = [...new Set(deployments.map((d) => d.kind))].sort();

      const roleId = await memberRoleId(db, rootTenantId);
      const denyRows = roleId
        ? await db.query.grant.findMany({
            where: and(
              eq(grant.roleId, roleId),
              eq(grant.action, WORKFLOW_RUN_ACTION),
              eq(grant.effect, "deny"),
            ),
            columns: { resource: true },
          })
        : [];
      const deniedResources = new Set(denyRows.map((g) => g.resource));
      const wildcardDenied = deniedResources.has(workflowRunResource("*"));

      return c.json({
        workflows: kinds.map((kind) => ({
          kind,
          enabled:
            !wildcardDenied && !deniedResources.has(workflowRunResource(kind)),
        })),
      });
    },
  );

  // Toggle a workflow's run-enablement for the workbench. Disable = write a
  // member-role `deny` for `workflow:<kind>`/`run`; enable = remove it. Owner
  // enable/disable is grant CRUD on the org member role (the tenant baseline).
  router.put(
    "/owner/workflows/:kind",
    describeRoute({
      description: "Enable or disable a workflow kind for the workbench.",
      responses: {
        200: {
          description: "Updated workflow state",
          content: {
            "application/json": { schema: resolver(OwnerWorkflowState) },
          },
        },
      },
    }),
    async (c) => {
      const kind = c.req.param("kind");
      let body: unknown = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const parsed = OwnerWorkflowToggle(body);
      if (parsed instanceof type.errors) {
        return c.json({ error: `invalid body: ${parsed.summary}` }, 400);
      }

      const roleId = await memberRoleId(db, rootTenantId);
      if (!roleId) {
        return c.json({ error: "Workbench member role not found" }, 404);
      }
      const resource = workflowRunResource(kind);
      const actor = c.get("ownerPrincipalId");
      const now = new Date();

      if (parsed.enabled) {
        await db
          .delete(grant)
          .where(
            and(
              eq(grant.roleId, roleId),
              eq(grant.resource, resource),
              eq(grant.action, WORKFLOW_RUN_ACTION),
              eq(grant.effect, "deny"),
            ),
          );
        void recordAudit({
          db,
          tenantId: rootTenantId,
          action: "grant_revoked",
          actorPrincipalId: actor,
          resource,
          detail: { kind, capability: "workflow-run" },
        });
      } else {
        const existing = await db.query.grant.findFirst({
          where: and(
            eq(grant.roleId, roleId),
            eq(grant.resource, resource),
            eq(grant.action, WORKFLOW_RUN_ACTION),
            eq(grant.effect, "deny"),
          ),
          columns: { id: true },
        });
        if (!existing) {
          await db.insert(grant).values({
            id: generateId("grant"),
            tenantId: rootTenantId,
            roleId,
            resource,
            action: WORKFLOW_RUN_ACTION,
            effect: "deny",
            origin: "system",
            createdAt: now,
            updatedAt: now,
          });
          void recordAudit({
            db,
            tenantId: rootTenantId,
            action: "grant_created",
            actorPrincipalId: actor,
            resource,
            detail: { kind, capability: "workflow-run", effect: "deny" },
          });
        }
      }

      return c.json({ kind, enabled: parsed.enabled });
    },
  );

  // Owner-only, masked-metadata view of the workbench's provider credentials
  // (CL-2879/CL-2883). Secrets are WRITE-ONLY: this route (and every
  // credentials route below) never reads or returns the `secret`/
  // `refreshSecret` columns — only whether a credential row exists and when it
  // was last touched. The provider catalog is the shared source of truth
  // (`CREDENTIAL_PROVIDER_CATALOG`), kept in step with the seeder's
  // `buildEntries()`. The Catalog (inference) and Capabilities (tool) tabs
  // both call this one route and filter client-side by `kind`.
  router.get(
    "/owner/credentials",
    describeRoute({
      description:
        "Configured/missing state for each provider credential the workbench manages. Never returns secrets.",
      responses: {
        200: {
          description: "Owner credentials",
          content: {
            "application/json": { schema: resolver(OwnerCredentialsResponse) },
          },
        },
      },
    }),
    async (c) => {
      const providerRows = await db.query.provider.findMany({
        where: eq(provider.tenantId, rootTenantId),
        columns: { id: true, name: true },
      });
      const providerByName = new Map(providerRows.map((p) => [p.name, p.id]));

      const credentialRows = await db.query.credential.findMany({
        where: eq(credential.tenantId, rootTenantId),
        columns: { providerId: true, updatedAt: true },
      });
      const credentialByProviderId = new Map(
        credentialRows.map((row) => [row.providerId, row.updatedAt]),
      );

      const credentials = CREDENTIAL_PROVIDER_CATALOG.map((entry) => {
        const providerId = providerByName.get(entry.providerName);
        const updatedAt = providerId
          ? (credentialByProviderId.get(providerId) ?? null)
          : null;
        return {
          providerName: entry.providerName,
          label: entry.label,
          kind: entry.kind,
          configured: updatedAt !== null,
          updatedAt: updatedAt ? updatedAt.toISOString() : null,
        };
      });

      return c.json({ credentials });
    },
  );

  // Set or replace a provider's credential (write-only). Creates the provider
  // row on first use (seeded with the catalog's default metadata, e.g. a
  // well-known base URL), then upserts the credential's secret. Returns only
  // the masked state — the secret itself is never echoed back.
  router.put(
    "/owner/credentials/:providerName",
    describeRoute({
      description:
        "Set or replace a provider's credential secret. The secret is never returned.",
      responses: {
        200: {
          description: "Updated credential state",
          content: {
            "application/json": {
              schema: resolver(OwnerCredentialStateSchema),
            },
          },
        },
      },
    }),
    async (c) => {
      const providerName = c.req.param("providerName");
      const entry = CREDENTIAL_PROVIDER_CATALOG.find(
        (e) => e.providerName === providerName,
      );
      if (!entry) {
        return c.json({ error: "Unknown provider" }, 404);
      }

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid body" }, 400);
      }
      const parsed = OwnerCredentialSetBody(body);
      if (parsed instanceof type.errors) {
        return c.json({ error: `invalid body: ${parsed.summary}` }, 400);
      }

      const now = new Date();
      let providerRow = await db.query.provider.findFirst({
        where: and(
          eq(provider.tenantId, rootTenantId),
          eq(provider.name, entry.providerName),
        ),
        columns: { id: true },
      });

      if (!providerRow) {
        const [created] = await db
          .insert(provider)
          .values({
            id: generateId("provider"),
            tenantId: rootTenantId,
            name: entry.providerName,
            plugin: entry.providerPlugin,
            metadata: entry.defaultMetadata ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: provider.id });
        providerRow = created;
      }
      if (!providerRow) {
        return c.json({ error: "Could not resolve provider" }, 500);
      }

      const existingCredential = await db.query.credential.findFirst({
        where: and(
          eq(credential.tenantId, rootTenantId),
          eq(credential.providerId, providerRow.id),
        ),
        columns: { id: true },
      });

      const actor = c.get("ownerPrincipalId");
      let updatedAt: Date;
      if (existingCredential) {
        const [updated] = await db
          .update(credential)
          .set({ secret: parsed.secret, updatedAt: now })
          .where(eq(credential.id, existingCredential.id))
          .returning({ updatedAt: credential.updatedAt });
        updatedAt = updated?.updatedAt ?? now;
        void recordAudit({
          db,
          tenantId: rootTenantId,
          action: "grant_created",
          actorPrincipalId: actor,
          resource: `credential:${entry.providerName}`,
          detail: { providerName: entry.providerName, op: "rotate" },
        });
      } else {
        const [created] = await db
          .insert(credential)
          .values({
            id: generateId("credential"),
            tenantId: rootTenantId,
            providerId: providerRow.id,
            name: entry.label,
            type: "api_key",
            secret: parsed.secret,
            metadata: entry.defaultMetadata ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ updatedAt: credential.updatedAt });
        updatedAt = created?.updatedAt ?? now;
        void recordAudit({
          db,
          tenantId: rootTenantId,
          action: "grant_created",
          actorPrincipalId: actor,
          resource: `credential:${entry.providerName}`,
          detail: { providerName: entry.providerName, op: "create" },
        });
      }

      return c.json({
        providerName: entry.providerName,
        label: entry.label,
        kind: entry.kind,
        configured: true,
        updatedAt: updatedAt.toISOString(),
      });
    },
  );

  // Clear a provider's credential (revoke). Idempotent: clearing an
  // already-unconfigured provider is a no-op 200, not an error.
  router.delete(
    "/owner/credentials/:providerName",
    describeRoute({
      description: "Clear a provider's credential.",
      responses: {
        200: {
          description: "Updated credential state",
          content: {
            "application/json": {
              schema: resolver(OwnerCredentialStateSchema),
            },
          },
        },
      },
    }),
    async (c) => {
      const providerName = c.req.param("providerName");
      const entry = CREDENTIAL_PROVIDER_CATALOG.find(
        (e) => e.providerName === providerName,
      );
      if (!entry) {
        return c.json({ error: "Unknown provider" }, 404);
      }

      const providerRow = await db.query.provider.findFirst({
        where: and(
          eq(provider.tenantId, rootTenantId),
          eq(provider.name, entry.providerName),
        ),
        columns: { id: true },
      });

      if (providerRow) {
        const deleted = await db
          .delete(credential)
          .where(
            and(
              eq(credential.tenantId, rootTenantId),
              eq(credential.providerId, providerRow.id),
            ),
          )
          .returning({ id: credential.id });
        if (deleted.length > 0) {
          void recordAudit({
            db,
            tenantId: rootTenantId,
            action: "grant_revoked",
            actorPrincipalId: c.get("ownerPrincipalId"),
            resource: `credential:${entry.providerName}`,
            detail: { providerName: entry.providerName, op: "clear" },
          });
        }
      }

      return c.json({
        providerName: entry.providerName,
        label: entry.label,
        kind: entry.kind,
        configured: false,
        updatedAt: null,
      });
    },
  );

  return router;
}
