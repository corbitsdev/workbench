import { evaluateGrants } from "@intx/authz";
import type { GrantRule } from "@intx/types/authz";
import { schema as intxSchema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import { and, eq } from "drizzle-orm";
import {
  FEATURE_GRANT_ACTION,
  FEATURE_GRANT_CATALOG,
  featureGrantResource,
  type FeatureName,
  type MemberFeatureState,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { getConfig } from "../config";
import { createTtlMemo } from "./ttl-memo";
import { loadMemberRoleGrantsForTenantChain } from "./workflow-run-gate";

const { grant } = intxSchema;

const log = getLogger(["lib", "feature-grants"]);

// Features are deny-by-default (mirrors the demos toggle, not the
// allow-by-default workflow-run gate): absent any grant, a feature stays off.
// Pure over the passed grants through the REAL @intx/authz matcher.
export async function featureGrantAllowed(
  memberRoleGrants: GrantRule[],
  name: FeatureName,
): Promise<boolean> {
  const result = await evaluateGrants(
    memberRoleGrants,
    featureGrantResource(name),
    FEATURE_GRANT_ACTION,
  );
  return result.effect === "allow";
}

// Resolves the tenant's feature grant from its member role (the same scope the
// owner toggle writes).
export async function isFeatureGrantedForTenant(
  db: HubDb,
  tenantId: string,
  name: FeatureName,
): Promise<boolean> {
  const grants = await loadMemberRoleGrantsForTenantChain(db, [tenantId]);
  return featureGrantAllowed(grants, name);
}

// The honest, fail-closed check for the runtime decision points (scheduler
// tick, triage eligibility, tasks reconciler). `envOverride` is the emergency
// global kill switch (the pre-existing SCHEDULER_ENABLED/TRIAGE_ENABLED/
// TASKS_RECONCILER_ENABLED env vars): true always enables the feature
// regardless of grant state. Otherwise the tenant's member-role grant decides.
// A grant-store failure is logged and treated as DISABLED — never silently
// swallowed, never fails open.
export async function isFeatureEnabledForTenant(
  db: HubDb,
  tenantId: string,
  name: FeatureName,
  envOverride: boolean,
): Promise<boolean> {
  if (envOverride) return true;
  try {
    return await isFeatureGrantedForTenant(db, tenantId, name);
  } catch (err) {
    log.error(
      "feature-grants: grant check failed; treating feature as disabled",
      {
        tenantId,
        feature: name,
        error: err instanceof Error ? err : new Error(String(err)),
      },
    );
    return false;
  }
}

// Short-TTL in-process memo over `isFeatureEnabledForTenant`, mirroring
// `workflow-model-source-cache.ts`: the scheduler tick, triage drain, and
// tasks-reconciler interval each re-check on every pass, and the grant changes
// rarely, so a ~30s window collapses that to one grant-store query per
// (tenant, feature) rather than one per tick. In-process only, no redis.
const memo = createTtlMemo<boolean>();

/** Test-only: clears the feature-grant cache. */
export function resetFeatureGrantCache(): void {
  memo.reset();
}

export async function isFeatureEnabledForTenantCached(
  db: HubDb,
  tenantId: string,
  name: FeatureName,
  envOverride: boolean,
  opts?: { ttlMs?: number; now?: () => number },
): Promise<boolean> {
  return memo.get({
    key: `${tenantId}:${name}`,
    ttlMs: opts?.ttlMs ?? getConfig().featureGrantCacheTtlMs,
    now: opts?.now,
    resolve: () => isFeatureEnabledForTenant(db, tenantId, name, envOverride),
  });
}

/** Env kill-switch map matching runtime decision points (CL-3823). */
export function featureEnvOverridesFromConfig(): Record<FeatureName, boolean> {
  const config = getConfig();
  return {
    scheduler: config.scheduler.enabled,
    triage: config.triageEnabled,
    "tasks-reconciler": config.tasksReconciler.enabled,
  };
}

/** Member-readable feature states — same truth as runtime enablement. */
export async function listMemberFeatureStates(
  db: HubDb,
  tenantId: string,
  envOverrides: Record<FeatureName, boolean> = featureEnvOverridesFromConfig(),
): Promise<MemberFeatureState[]> {
  return Promise.all(
    FEATURE_GRANT_CATALOG.map(async (entry) => ({
      name: entry.name,
      enabled: await isFeatureEnabledForTenant(
        db,
        tenantId,
        entry.name,
        envOverrides[entry.name] ?? false,
      ),
    })),
  );
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

// Enable = write a member-role `allow` for `feature:<name>`/`enable`; disable =
// remove it. Grant CRUD on the org member role, the mirror of the demos toggle
// (which is also deny-by-default and writes/removes a plain allow).
export async function setFeatureGrant(
  db: HubDb,
  args: {
    tenantId: string;
    roleId: string;
    name: FeatureName;
    enabled: boolean;
  },
): Promise<void> {
  const resource = featureGrantResource(args.name);
  await db.transaction(async (tx) => {
    await memberRoleRowLock(tx, args.roleId);
    const existing = await tx.query.grant.findFirst({
      where: and(
        eq(grant.roleId, args.roleId),
        eq(grant.resource, resource),
        eq(grant.action, FEATURE_GRANT_ACTION),
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
        action: FEATURE_GRANT_ACTION,
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
