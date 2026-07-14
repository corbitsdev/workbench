import { evaluateGrants } from "@intx/authz";
import type { GrantRule } from "@intx/types/authz";
import { schema as intxSchema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import { and, eq } from "drizzle-orm";
import {
  WORKSPACE_INBOX_SOURCE_ACTION,
  workspaceInboxSourceResource,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { loadMemberRoleGrantsForTenantChain } from "./workflow-run-gate";

const { grant } = intxSchema;

const log = getLogger(["lib", "workspace-inbox-source-gate"]);

/**
 * Whether an inbox source (either scope) is owner-enabled, evaluated over
 * already-loaded member-role grants. Deny-by-default: absent an
 * `inbox-source:<key>`/`enable` allow the source stays OFF. Pure over the
 * passed grants through the REAL `@intx/authz` matcher; callers that already
 * loaded the tenant's grants (the owner catalog GET, the `/me/inbox-sources`
 * filter) use this to avoid one grant-store query per source.
 */
export async function isInboxSourceEnabledFromGrants(
  memberRoleGrants: GrantRule[],
  sourceKey: string,
): Promise<boolean> {
  const result = await evaluateGrants(
    memberRoleGrants,
    workspaceInboxSourceResource(sourceKey),
    WORKSPACE_INBOX_SOURCE_ACTION,
  );
  return result.effect === "allow";
}

/**
 * Whether an inbox source is owner-enabled for a tenant. Deny-by-default
 * (mirrors feature grants): absent any grant the source stays OFF; an `allow`
 * on the tenant's system `member` role for `inbox-source:<key>`/`enable`
 * (owner-written) turns it on. This is the tenant ceiling for BOTH scopes: the
 * intake tick checks it per workspace source once per tenant, and per member
 * source before honoring a member's `inboxSource:*` preference (CL-3584
 * cascade). A grant-store failure is logged and treated as DISABLED — never
 * fails open.
 */
export async function isWorkspaceInboxSourceEnabledForTenant(
  db: HubDb,
  tenantId: string,
  sourceKey: string,
): Promise<boolean> {
  try {
    const grants = await loadMemberRoleGrantsForTenantChain(db, [tenantId]);
    return await isInboxSourceEnabledFromGrants(grants, sourceKey);
  } catch (err) {
    log.error(
      "workspace-inbox-source-gate: grant check failed; treating source as disabled",
      {
        tenantId,
        sourceKey,
        error: err instanceof Error ? err : new Error(String(err)),
      },
    );
    return false;
  }
}

async function memberRoleRowLock(
  tx: Parameters<Parameters<HubDb["transaction"]>[0]>[0],
  roleId: string,
): Promise<void> {
  await tx
    .select({ id: intxSchema.role.id })
    .from(intxSchema.role)
    .where(eq(intxSchema.role.id, roleId))
    .for("update");
}

/**
 * Owner toggle CRUD for an inbox source's tenant enablement. Enable = write a
 * `member`-role `allow` for `inbox-source:<key>`/`enable`; disable = remove it.
 * Deny-by-default, the mirror of `setFeatureGrant`. Member preferences are
 * never touched here — disabling only removes the tenant ceiling grant, so a
 * later re-enable restores each member's preserved `inboxSource:*` choice.
 */
export async function setWorkspaceInboxSourceGrant(
  db: HubDb,
  args: {
    tenantId: string;
    roleId: string;
    sourceKey: string;
    enabled: boolean;
  },
): Promise<void> {
  const resource = workspaceInboxSourceResource(args.sourceKey);
  await db.transaction(async (tx) => {
    await memberRoleRowLock(tx, args.roleId);
    const existing = await tx.query.grant.findFirst({
      where: and(
        eq(grant.roleId, args.roleId),
        eq(grant.resource, resource),
        eq(grant.action, WORKSPACE_INBOX_SOURCE_ACTION),
        eq(grant.effect, "allow"),
      ),
      columns: { id: true },
    });

    if (args.enabled) {
      if (existing) return;
      const now = new Date();
      await tx.insert(grant).values({
        id: generateId("grant"),
        tenantId: args.tenantId,
        roleId: args.roleId,
        resource,
        action: WORKSPACE_INBOX_SOURCE_ACTION,
        effect: "allow",
        origin: "system",
        createdAt: now,
        updatedAt: now,
      });
      return;
    }

    if (!existing) return;
    await tx.delete(grant).where(eq(grant.id, existing.id));
  });
}
