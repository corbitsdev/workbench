import { type } from "arktype";
import { Hono } from "hono";
import { getLogger } from "@intx/log";
import { describeRoute, resolver } from "hono-openapi";
import { type GrantStore } from "@intx/authz";
import { schema as intxSchema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  CREDENTIAL_PROVIDER_CATALOG,
  DEMOS_RESOURCE,
  DEMOS_VIEW_ACTION,
  FEATURE_GRANT_CATALOG,
  type FeatureName,
  findOAuthProviderConfig,
  INBOX_SOURCE_CATALOG,
  MEMBER_ROLE_NAME,
  OwnerInboxSourcesResponse,
  OwnerInboxSourceToggle,
  OwnerInboxSourceToggleResult,
  OwnerCapabilitiesResponse,
  OwnerCapabilityToggle,
  OwnerCapabilityToggleResult,
  OwnerContextResponse,
  OwnerCredentialSetBody,
  OwnerCredentialsResponse,
  OwnerCredentialStateSchema,
  OwnerDemosResponse,
  OwnerDemosToggle,
  OwnerFeaturesResponse,
  OwnerFeatureToggle,
  OwnerFeatureToggleResult,
  OwnerWorkflowsResponse,
  OwnerWorkflowState,
  OwnerWorkflowToggle,
  workflowRunResource,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { workflowRun } from "../db/schema";
import { createOwnerGrantGuard } from "../lib/admin-grant";
import {
  fetchSlackTeamId,
  resolveSlackCredential,
} from "../lib/slack-api-client";
import { joinAllPublicChannels } from "../lib/slack-channel-autojoin";
import { upsertSlackTeamMapping } from "../lib/slack-team-mapping";
import { encryptSecret } from "../lib/credential-crypto";
import {
  listOwnerCapabilityStates,
  setCapabilityGrant,
} from "../lib/capability-grants";
import { demosViewAllowed } from "../lib/demos-gate";
import { featureGrantAllowed, setFeatureGrant } from "../lib/feature-grants";
import {
  isInboxSourceEnabledFromGrants,
  setWorkspaceInboxSourceGrant,
} from "../lib/workspace-inbox-source-gate";
import {
  loadMemberRoleGrantsForTenantChain,
  setWorkflowRunGrant,
  workflowRunDenied,
} from "../lib/workflow-run-gate";
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
  // Whether the `SHOW_DEMOS` env override is on. Reported as `forcedByEnv` so the
  // owner sees the demos toggle is inert while the deployment forces demos on.
  showDemos: boolean;
  // Each feature grant's emergency env override (SCHEDULER_ENABLED,
  // TRIAGE_ENABLED, TASKS_RECONCILER_ENABLED), keyed by `FeatureName`. Reported
  // per feature as `forcedByEnv`, same purpose as `showDemos`.
  featureEnvOverrides: Record<FeatureName, boolean>;
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
  const { db, grantStore, rootTenantId, showDemos, featureEnvOverrides } = deps;
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

      // Decide enablement from the org member-role grants — loaded ONCE, and
      // scoped to the tenant the owner toggle actually writes (rootTenantId).
      // Reading the same scope the write targets keeps the displayed state
      // honest: removing a deny here re-enables the kind (an ancestor deny, if
      // one ever existed, is a chain concern the owner cannot toggle anyway).
      const grants = await loadMemberRoleGrantsForTenantChain(db, [
        rootTenantId,
      ]);
      const workflows = await Promise.all(
        kinds.map(async (kind) => ({
          kind,
          enabled: !(await workflowRunDenied(grants, kind)),
        })),
      );

      return c.json({ workflows });
    },
  );

  // Toggle a workflow's run-enablement for the workbench. Enable = write a
  // member-role `allow` for `workflow:<kind>`/`run`; disable = write a `deny`.
  // Enablement is a persisted grant either way (never the absence of one) so a
  // redeploy's first-publish seed can tell an owner-enabled kind (allow) from a
  // never-decided one (no row) and leave the owner's choice intact.
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

      await setWorkflowRunGrant(db, {
        tenantId: rootTenantId,
        roleId,
        kind,
        enabled: parsed.enabled,
      });
      void recordAudit({
        db,
        tenantId: rootTenantId,
        action: "grant_created",
        actorPrincipalId: actor,
        resource,
        detail: {
          kind,
          capability: "workflow-run",
          effect: parsed.enabled ? "allow" : "deny",
        },
      });

      return c.json({ kind, enabled: parsed.enabled });
    },
  );

  // The org-wide demos toggle. `enabled` is true when the org member role holds
  // an `allow` for `demos`/`view` — the opt-in the sidebar's Demos section reads
  // (demos are hidden by default). The `SHOW_DEMOS` env override is separate and
  // does not surface here.
  router.get(
    "/owner/demos",
    describeRoute({
      description: "Whether the Demos sidebar section is enabled org-wide.",
      responses: {
        200: {
          description: "Owner demos state",
          content: {
            "application/json": { schema: resolver(OwnerDemosResponse) },
          },
        },
      },
    }),
    async (c) => {
      const grants = await loadMemberRoleGrantsForTenantChain(db, [
        rootTenantId,
      ]);
      return c.json({
        enabled: await demosViewAllowed(grants),
        forcedByEnv: showDemos,
      });
    },
  );

  // Toggle the Demos section org-wide. Enable = write a member-role `allow` for
  // `demos`/`view`; disable = remove it. Grant CRUD on the org member role, the
  // mirror of the workflow toggle (which writes a `deny`).
  router.put(
    "/owner/demos",
    describeRoute({
      description: "Enable or disable the Demos sidebar section org-wide.",
      responses: {
        200: {
          description: "Updated demos state",
          content: {
            "application/json": { schema: resolver(OwnerDemosResponse) },
          },
        },
      },
    }),
    async (c) => {
      let body: unknown = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const parsed = OwnerDemosToggle(body);
      if (parsed instanceof type.errors) {
        return c.json({ error: `invalid body: ${parsed.summary}` }, 400);
      }

      const roleId = await memberRoleId(db, rootTenantId);
      if (!roleId) {
        return c.json({ error: "Workbench member role not found" }, 404);
      }
      const actor = c.get("ownerPrincipalId");
      const now = new Date();

      if (parsed.enabled) {
        const existing = await db.query.grant.findFirst({
          where: and(
            eq(grant.roleId, roleId),
            eq(grant.resource, DEMOS_RESOURCE),
            eq(grant.action, DEMOS_VIEW_ACTION),
            eq(grant.effect, "allow"),
          ),
          columns: { id: true },
        });
        if (!existing) {
          await db.insert(grant).values({
            id: generateId("grant"),
            tenantId: rootTenantId,
            roleId,
            resource: DEMOS_RESOURCE,
            action: DEMOS_VIEW_ACTION,
            effect: "allow",
            origin: "system",
            createdAt: now,
            updatedAt: now,
          });
          void recordAudit({
            db,
            tenantId: rootTenantId,
            action: "grant_created",
            actorPrincipalId: actor,
            resource: DEMOS_RESOURCE,
            detail: { capability: "demos-view", effect: "allow" },
          });
        }
      } else {
        await db
          .delete(grant)
          .where(
            and(
              eq(grant.roleId, roleId),
              eq(grant.resource, DEMOS_RESOURCE),
              eq(grant.action, DEMOS_VIEW_ACTION),
              eq(grant.effect, "allow"),
            ),
          );
        void recordAudit({
          db,
          tenantId: rootTenantId,
          action: "grant_revoked",
          actorPrincipalId: actor,
          resource: DEMOS_RESOURCE,
          detail: { capability: "demos-view" },
        });
      }

      return c.json({ enabled: parsed.enabled, forcedByEnv: showDemos });
    },
  );

  // The owner-managed feature-grant catalog (scheduler/triage/tasks-reconciler
  // — see `packages/workbench-shared/src/governance.ts`). `enabled` reflects
  // the member-role grant only; `forcedByEnv` is true when the feature's
  // emergency env override is on, mirroring the demos toggle above.
  // Per-principal overrides are out of scope here (tenant-level only); every
  // row's `principalId` is `null`.
  router.get(
    "/owner/features",
    describeRoute({
      tags: ["Owner"],
      description:
        "Owner-managed feature grants (scheduler, triage, tasks reconciler) and their enablement state.",
      responses: {
        200: {
          description: "Owner features",
          content: {
            "application/json": { schema: resolver(OwnerFeaturesResponse) },
          },
        },
      },
    }),
    async (c) => {
      const grants = await loadMemberRoleGrantsForTenantChain(db, [
        rootTenantId,
      ]);
      const features = await Promise.all(
        FEATURE_GRANT_CATALOG.map(async (entry) => ({
          name: entry.name,
          label: entry.label,
          description: entry.description,
          enabled: await featureGrantAllowed(grants, entry.name),
          forcedByEnv: featureEnvOverrides[entry.name],
          principalId: null,
        })),
      );
      return c.json({ features });
    },
  );

  // Toggle a feature grant org-wide. Enable = write a member-role `allow` for
  // `feature:<name>`/`enable`; disable = remove it — the same deny-by-default
  // CRUD shape as the demos toggle.
  router.put(
    "/owner/features/:name",
    describeRoute({
      tags: ["Owner"],
      description: "Enable or disable a feature grant for the workbench.",
      parameters: [
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Updated feature state",
          content: {
            "application/json": { schema: resolver(OwnerFeatureToggleResult) },
          },
        },
      },
    }),
    async (c) => {
      const name = c.req.param("name");
      const catalogEntry = FEATURE_GRANT_CATALOG.find(
        (entry) => entry.name === name,
      );
      if (!catalogEntry) {
        return c.json({ error: `unknown feature: ${name}` }, 404);
      }

      let body: unknown = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const parsed = OwnerFeatureToggle(body);
      if (parsed instanceof type.errors) {
        return c.json({ error: `invalid body: ${parsed.summary}` }, 400);
      }

      const roleId = await memberRoleId(db, rootTenantId);
      if (!roleId) {
        return c.json({ error: "Workbench member role not found" }, 404);
      }
      const actor = c.get("ownerPrincipalId");

      await setFeatureGrant(db, {
        tenantId: rootTenantId,
        roleId,
        name: catalogEntry.name,
        enabled: parsed.enabled,
      });
      void recordAudit({
        db,
        tenantId: rootTenantId,
        action: parsed.enabled ? "grant_created" : "grant_revoked",
        actorPrincipalId: actor,
        resource: `feature:${catalogEntry.name}`,
        detail: {
          capability: "feature-grant",
          effect: parsed.enabled ? "allow" : "none",
        },
      });

      return c.json({ name: catalogEntry.name, enabled: parsed.enabled });
    },
  );

  // Owner-level inbox source enablement (CL-3584). Which intake sources are
  // enabled tenant-wide. Deny-by-default: a source runs for members only once
  // the owner enables it here (the tenant ceiling above each member's
  // `inboxSource:*` preference). `enabled` reflects the member-role
  // `inbox-source:<key>`/`enable` grant. Catalog copy comes from
  // `INBOX_SOURCE_CATALOG`.
  router.get(
    "/owner/inbox-sources",
    describeRoute({
      tags: ["Owner"],
      description:
        "Owner-managed inbox source enablement (the tenant ceiling above each member's inbox-source preference) and their state.",
      responses: {
        200: {
          description: "Owner inbox sources",
          content: {
            "application/json": { schema: resolver(OwnerInboxSourcesResponse) },
          },
        },
      },
    }),
    async (c) => {
      const grants = await loadMemberRoleGrantsForTenantChain(db, [
        rootTenantId,
      ]);
      const sources = await Promise.all(
        INBOX_SOURCE_CATALOG.map(async (entry) => ({
          key: entry.key,
          label: entry.label,
          description: entry.description,
          enabled: await isInboxSourceEnabledFromGrants(grants, entry.key),
        })),
      );
      return c.json({ sources });
    },
  );

  // Toggle an inbox source's tenant enablement. Enable = write a member-role
  // `allow` for `inbox-source:<key>`/`enable`; disable = remove it. Member
  // preferences are never touched, so disabling then re-enabling restores each
  // member's prior `inboxSource:*` choice.
  router.put(
    "/owner/inbox-sources/:key",
    describeRoute({
      tags: ["Owner"],
      description: "Enable or disable an inbox source for the workbench.",
      parameters: [
        {
          name: "key",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Updated inbox source state",
          content: {
            "application/json": {
              schema: resolver(OwnerInboxSourceToggleResult),
            },
          },
        },
      },
    }),
    async (c) => {
      const key = c.req.param("key");
      const catalogEntry = INBOX_SOURCE_CATALOG.find(
        (entry) => entry.key === key,
      );
      if (!catalogEntry) {
        return c.json({ error: `unknown inbox source: ${key}` }, 404);
      }

      let body: unknown = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const parsed = OwnerInboxSourceToggle(body);
      if (parsed instanceof type.errors) {
        return c.json({ error: `invalid body: ${parsed.summary}` }, 400);
      }

      const roleId = await memberRoleId(db, rootTenantId);
      if (!roleId) {
        return c.json({ error: "Workbench member role not found" }, 404);
      }
      const actor = c.get("ownerPrincipalId");

      await setWorkspaceInboxSourceGrant(db, {
        tenantId: rootTenantId,
        roleId,
        sourceKey: catalogEntry.key,
        enabled: parsed.enabled,
      });
      void recordAudit({
        db,
        tenantId: rootTenantId,
        action: parsed.enabled ? "grant_created" : "grant_revoked",
        actorPrincipalId: actor,
        resource: `inbox-source:${catalogEntry.key}`,
        detail: {
          capability: "inbox-source-grant",
          effect: parsed.enabled ? "allow" : "none",
        },
      });

      // CL-3581: enabling Slack sweeps the bot into every public channel so
      // mention events start flowing without per-channel invites. Best-effort —
      // enablement itself never fails on a Slack API error.
      //
      // CL-3629: also resolves the workspace's team id (auth.test) and
      // persists the team_id → tenant mapping the webhook route uses to
      // target this tenant only. This assumes a single `SLACK_SIGNING_SECRET`
      // verifies every mapped team — true for one distributed Slack app
      // installed across workspaces, but a constraint worth calling out: a
      // second, differently-signed Slack app would need per-tenant signing
      // secrets (not built here; tracked as follow-up).
      if (parsed.enabled && catalogEntry.key === "slack") {
        const credential = await resolveSlackCredential(db, rootTenantId);
        if (credential) {
          try {
            const teamId = await fetchSlackTeamId(
              credential,
              AbortSignal.timeout(10_000),
            );
            if (teamId) {
              await upsertSlackTeamMapping(db, rootTenantId, teamId);
            } else {
              getLogger(["routes", "owner"]).warn(
                "slack auth.test returned no team_id; team mapping not recorded",
              );
            }
          } catch (err) {
            getLogger(["routes", "owner"]).warn(
              "slack auth.test failed after enablement; team mapping not recorded, webhook events for this workspace will drop until re-enabled",
              { err },
            );
          }
          joinAllPublicChannels(credential, AbortSignal.timeout(60_000)).catch(
            (err) => {
              getLogger(["routes", "owner"]).warn(
                "slack auto-join sweep failed after enablement; mentions only flow in channels the bot is in",
                { err },
              );
            },
          );
        }
      }

      return c.json({ key: catalogEntry.key, enabled: parsed.enabled });
    },
  );

  // Owner capability gate (CL-3356 #1). Which connectable OAuth providers
  // (Linear, Attio, …) are available to members. Allow-by-default: a provider
  // is enabled unless the owner writes a `member`-role `deny` on
  // `capability:<provider>`/`use`, which HIDES it from every member's
  // Connections surface. Mirror of the workflow-run gate.
  router.get(
    "/owner/capabilities",
    describeRoute({
      tags: ["Owner"],
      description:
        "Connectable OAuth providers and whether each capability is enabled (not owner-hidden).",
      responses: {
        200: {
          description: "Owner capabilities",
          content: {
            "application/json": {
              schema: resolver(OwnerCapabilitiesResponse),
            },
          },
        },
      },
    }),
    async (c) => {
      const capabilities = await listOwnerCapabilityStates(db, [rootTenantId]);
      return c.json({ capabilities });
    },
  );

  router.put(
    "/owner/capabilities/:provider",
    describeRoute({
      tags: ["Owner"],
      description:
        "Enable (allow) or hide (deny) a connectable provider's capability org-wide.",
      parameters: [
        {
          name: "provider",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Updated capability state",
          content: {
            "application/json": {
              schema: resolver(OwnerCapabilityToggleResult),
            },
          },
        },
      },
    }),
    async (c) => {
      const providerName = c.req.param("provider");
      if (!findOAuthProviderConfig(providerName)) {
        return c.json({ error: `unknown provider: ${providerName}` }, 404);
      }

      let body: unknown = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const parsed = OwnerCapabilityToggle(body);
      if (parsed instanceof type.errors) {
        return c.json({ error: `invalid body: ${parsed.summary}` }, 400);
      }

      const roleId = await memberRoleId(db, rootTenantId);
      if (!roleId) {
        return c.json({ error: "Workbench member role not found" }, 404);
      }
      const actor = c.get("ownerPrincipalId");

      await setCapabilityGrant(db, {
        tenantId: rootTenantId,
        roleId,
        provider: providerName,
        enabled: parsed.enabled,
      });
      void recordAudit({
        db,
        tenantId: rootTenantId,
        action: parsed.enabled ? "grant_created" : "grant_revoked",
        actorPrincipalId: actor,
        resource: `capability:${providerName}`,
        detail: {
          capability: "capability-grant",
          effect: parsed.enabled ? "allow" : "none",
        },
      });

      return c.json({ provider: providerName, enabled: parsed.enabled });
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
        columns: { id: true, name: true, metadata: true },
      });
      const providerByName = new Map(
        providerRows.map((p) => [p.name, { id: p.id, metadata: p.metadata }]),
      );

      const credentialRows = await db.query.credential.findMany({
        where: eq(credential.tenantId, rootTenantId),
        columns: { providerId: true, updatedAt: true },
      });
      const credentialByProviderId = new Map(
        credentialRows.map((row) => [row.providerId, row.updatedAt]),
      );

      const credentials = CREDENTIAL_PROVIDER_CATALOG.map((entry) => {
        const prov = providerByName.get(entry.providerName);
        const providerId = prov?.id ?? null;
        const updatedAt = providerId
          ? (credentialByProviderId.get(providerId) ?? null)
          : null;
        const baseURL =
          prov && typeof prov.metadata === "object" && prov.metadata !== null
            ? ((prov.metadata as Record<string, unknown>).baseURL as
                | string
                | undefined)
            : undefined;
        return {
          providerName: entry.providerName,
          label: entry.label,
          kind: entry.kind,
          configured: updatedAt !== null,
          updatedAt: updatedAt ? updatedAt.toISOString() : null,
          ...(baseURL ? { baseURL } : {}),
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
        columns: { id: true, metadata: true },
      });

      if (!providerRow) {
        const initialMetadata = {
          ...(entry.defaultMetadata ?? {}),
          ...(parsed.baseURL ? { baseURL: parsed.baseURL } : {}),
        };
        const [created] = await db
          .insert(provider)
          .values({
            id: generateId("provider"),
            tenantId: rootTenantId,
            name: entry.providerName,
            plugin: entry.providerPlugin,
            metadata:
              Object.keys(initialMetadata).length > 0 ? initialMetadata : null,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: provider.id, metadata: provider.metadata });
        providerRow = created;
      }
      if (!providerRow) {
        return c.json({ error: "Could not resolve provider" }, 500);
      }

      // If owner supplied a baseURL (e.g. for bifrost), merge it into provider metadata.
      if (parsed.baseURL) {
        const currentMeta = (providerRow.metadata ?? {}) as Record<
          string,
          unknown
        >;
        const nextMeta = { ...currentMeta, baseURL: parsed.baseURL };
        await db
          .update(provider)
          .set({ metadata: nextMeta, updatedAt: now })
          .where(eq(provider.id, providerRow.id));
        // keep our local copy in sync for any downstream use in this request
        providerRow.metadata = nextMeta;
      }

      const existingCredential = await db.query.credential.findFirst({
        where: and(
          eq(credential.tenantId, rootTenantId),
          eq(credential.providerId, providerRow.id),
        ),
        columns: { id: true },
      });

      // CL-3446: only `kind: "tool"` secrets are encrypted at rest. `kind:
      // "inference"` rows stay plaintext-compatible — Interchange reads
      // `credential.secret` raw at agent-launch time and cannot be modified
      // to decrypt first.
      const storedSecret =
        entry.kind === "tool" ? encryptSecret(parsed.secret) : parsed.secret;

      const actor = c.get("ownerPrincipalId");
      let updatedAt: Date;
      if (existingCredential) {
        const [updated] = await db
          .update(credential)
          .set({ secret: storedSecret, updatedAt: now })
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
            secret: storedSecret,
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

      const responseBaseURL =
        providerRow &&
        typeof providerRow.metadata === "object" &&
        providerRow.metadata !== null
          ? ((providerRow.metadata as Record<string, unknown>).baseURL as
              | string
              | undefined)
          : undefined;

      return c.json({
        providerName: entry.providerName,
        label: entry.label,
        kind: entry.kind,
        configured: true,
        updatedAt: updatedAt.toISOString(),
        ...(responseBaseURL ? { baseURL: responseBaseURL } : {}),
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
        columns: { id: true, metadata: true },
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

      const responseBaseURL =
        providerRow &&
        typeof providerRow.metadata === "object" &&
        providerRow.metadata !== null
          ? ((providerRow.metadata as Record<string, unknown>).baseURL as
              | string
              | undefined)
          : undefined;

      return c.json({
        providerName: entry.providerName,
        label: entry.label,
        kind: entry.kind,
        configured: false,
        updatedAt: null,
        ...(responseBaseURL ? { baseURL: responseBaseURL } : {}),
      });
    },
  );

  return router;
}
