import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { schema as intxSchema } from '@intx/db';
import { getLogger } from '@intx/log';
import { getConfig } from '../config';
import type { HubDb } from '../db';
import { workflowRun, artifact, artifactVersion, enabledWorkflow } from '../db/schema';
import { ensureGlobalMember, provisionMyraInstance } from './tenant-provisioning';

const log = getLogger(['migrate', 'global-tenant']);

const { tenant, principal, agentInstance } = intxSchema;

/**
 * The provisioning helpers the migration depends on. Injected with real defaults
 * so tests can substitute stubs without `mock.module`-ing a first-party module
 * that other suites exercise for real (Bun module mocks leak across files).
 */
export type MigrationDeps = {
  ensureGlobalMember: typeof ensureGlobalMember;
  provisionMyraInstance: typeof provisionMyraInstance;
};

const defaultDeps: MigrationDeps = { ensureGlobalMember, provisionMyraInstance };

export type UserMigrationResult = {
  userId: string;
  personalTenantId: string | null;
  oldPrincipalId: string | null;
  newPrincipalId: string | null;
  workbenchesReparented: number;
  workflowRunsReKeyed: number;
  artifactsReKeyed: number;
  artifactVersionsReKeyed: number;
  enabledWorkflowsReKeyed: number;
  oldMyraInstancesStopped: number;
  globalMyraInstanceId: string | null;
  skipped?: string;
};

export type MigrationSummary = {
  dryRun: boolean;
  globalTenantId: string;
  users: UserMigrationResult[];
  failures: Array<{ userId: string; error: string }>;
};

/**
 * Migrate one user from their personal tenant into the shared global org tenant
 * (CL-1451). Idempotent and re-runnable: it ensures the global member principal,
 * re-parents the user's named workbenches under the global tenant, provisions a
 * fresh per-user Myra in the global tenant (stopping the old personal instance),
 * and re-keys workflow_run / artifact / artifact_version from the old personal
 * principal to the new global principal.
 *
 * pain_point carries no tenant/principal columns (it hangs off workflow_run via
 * session_id), so it migrates implicitly with its run — nothing to re-key.
 *
 * In dryRun mode no writes happen; the returned counts report what WOULD move.
 * The live path runs inside a single per-user transaction so one failure rolls
 * back cleanly and the batch continues. Note: ensureGlobalMember +
 * provisionMyraInstance run BEFORE that transaction (they have their own), so a
 * crash between them and the re-key commit leaves Myra provisioned but data not
 * yet re-keyed — recoverable, because a re-run finishes the re-key (the UPDATEs
 * are guarded by counts from the old principal). An interrupted run MUST be
 * re-run.
 */
export async function migrateUserToGlobalTenant(
  db: HubDb,
  opts: { userId: string; globalTenantId: string; globalTenantDomain: string; dryRun: boolean },
  deps: MigrationDeps = defaultDeps
): Promise<UserMigrationResult> {
  const { userId, globalTenantId, globalTenantDomain, dryRun } = opts;

  const personalSlug = `user-${userId}`;
  const personalTenant = await db.query.tenant.findFirst({
    where: eq(tenant.slug, personalSlug),
  });

  const oldPrincipal = personalTenant
    ? await db.query.principal.findFirst({
        where: and(
          eq(principal.tenantId, personalTenant.id),
          eq(principal.kind, 'user'),
          eq(principal.refId, userId)
        ),
      })
    : null;

  // The user's named workbenches: top-level tenants (parentId null) the user is
  // a principal in, excluding their personal tenant and the global tenant.
  // Invariant in the current data model: the only non-personal top-level tenants
  // a user is a principal of are workbenches they own. If that ever changes
  // (e.g. shared/partner top-level tenants), filter to the owner role here.
  const userPrincipals = await db.query.principal.findMany({
    where: and(eq(principal.kind, 'user'), eq(principal.refId, userId)),
  });
  const candidateTenantIds = userPrincipals.map((p) => p.tenantId);
  const workbenchTenants = candidateTenantIds.length
    ? await db.query.tenant.findMany({
        where: and(
          inArray(tenant.id, candidateTenantIds),
          isNull(tenant.parentId),
          ne(tenant.id, globalTenantId),
          ne(tenant.slug, personalSlug)
        ),
      })
    : [];
  const workbenchTenantIds = workbenchTenants.map((t) => t.id);

  // Old personal Myra instances to stop (live only).
  const oldMyraInstances = personalTenant
    ? await db.query.agentInstance.findMany({
        where: and(
          eq(agentInstance.tenantId, personalTenant.id),
          inArray(agentInstance.status, ['deployed', 'running', 'updating'])
        ),
      })
    : [];

  // Rows to re-key, counted from the OLD personal principal.
  const runs = oldPrincipal
    ? await db.query.workflowRun.findMany({ where: eq(workflowRun.principalId, oldPrincipal.id) })
    : [];
  const artifacts = oldPrincipal
    ? await db.query.artifact.findMany({ where: eq(artifact.principalId, oldPrincipal.id) })
    : [];
  // artifact_version is re-keyed by authorId; count the rows authored by the old principal.
  const authoredVersions = oldPrincipal
    ? await db.query.artifactVersion.findMany({
        where: eq(artifactVersion.authorId, oldPrincipal.id),
      })
    : [];
  // enabledWorkflow is keyed (tenant_id, principal_id, kind) since CL-1450; the
  // 0015 backfill set principal_id to this personal-tenant user principal. Must
  // re-key it too, or the user's enabled workflows look disabled after cutover.
  const enabledWorkflows = oldPrincipal
    ? await db.query.enabledWorkflow.findMany({
        where: eq(enabledWorkflow.principalId, oldPrincipal.id),
      })
    : [];

  const result: UserMigrationResult = {
    userId,
    personalTenantId: personalTenant?.id ?? null,
    oldPrincipalId: oldPrincipal?.id ?? null,
    newPrincipalId: null,
    workbenchesReparented: workbenchTenantIds.length,
    workflowRunsReKeyed: runs.length,
    artifactsReKeyed: artifacts.length,
    artifactVersionsReKeyed: authoredVersions.length,
    enabledWorkflowsReKeyed: enabledWorkflows.length,
    oldMyraInstancesStopped: oldMyraInstances.length,
    globalMyraInstanceId: null,
  };

  if (dryRun) {
    log.info('[dry-run] would migrate user', { ...result });
    return result;
  }

  // Ensure the global member + per-user Myra OUTSIDE the per-user transaction:
  // they have their own race-safe internal transactions and are idempotent.
  const { principalId: newPrincipalId } = await deps.ensureGlobalMember(db, { userId });
  result.newPrincipalId = newPrincipalId;

  const { paInstanceId } = await deps.provisionMyraInstance(db, {
    tenantId: globalTenantId,
    tenantDomain: globalTenantDomain,
    userId,
    creatorPrincipalId: newPrincipalId,
  });
  result.globalMyraInstanceId = paInstanceId;

  await db.transaction(async (tx) => {
    const now = new Date();

    if (workbenchTenantIds.length > 0) {
      await tx
        .update(tenant)
        .set({ parentId: globalTenantId, updatedAt: now })
        .where(inArray(tenant.id, workbenchTenantIds));
    }

    if (oldPrincipal) {
      // Each update is guarded by its count so a re-run (rows already re-keyed,
      // counts 0) issues no UPDATE at all — a true no-op.
      if (runs.length > 0) {
        await tx
          .update(workflowRun)
          .set({ tenantId: globalTenantId, principalId: newPrincipalId, updatedAt: now })
          .where(eq(workflowRun.principalId, oldPrincipal.id));
      }

      if (artifacts.length > 0) {
        await tx
          .update(artifact)
          .set({ tenantId: globalTenantId, principalId: newPrincipalId, updatedAt: now })
          .where(eq(artifact.principalId, oldPrincipal.id));
      }

      if (authoredVersions.length > 0) {
        await tx
          .update(artifactVersion)
          .set({ authorId: newPrincipalId })
          .where(eq(artifactVersion.authorId, oldPrincipal.id));
      }

      if (enabledWorkflows.length > 0) {
        // No collision under the (tenant_id, principal_id, kind) unique key: the
        // new principal is unique per user, so each member's enablement rows land
        // distinctly in the global tenant.
        await tx
          .update(enabledWorkflow)
          .set({ tenantId: globalTenantId, principalId: newPrincipalId })
          .where(eq(enabledWorkflow.principalId, oldPrincipal.id));
      }
    }

    if (personalTenant && oldMyraInstances.length > 0) {
      await tx
        .update(agentInstance)
        .set({ status: 'stopped', endedAt: now, updatedAt: now })
        .where(
          and(
            eq(agentInstance.tenantId, personalTenant.id),
            inArray(agentInstance.status, ['deployed', 'running', 'updating'])
          )
        );
    }
  });

  log.info('Migrated user into global tenant', { ...result });
  return result;
}

/**
 * Migrate every existing workbench user into the global org tenant. The global
 * tenant must already be seeded (CL-1446). Each user is migrated in its own
 * transaction; a failure is logged and the batch continues. Safe to run twice.
 */
export async function migrateAllUsersToGlobalTenant(
  db: HubDb,
  opts: { dryRun: boolean },
  deps: MigrationDeps = defaultDeps
): Promise<MigrationSummary> {
  const { slug, domain } = getConfig().globalTenant;

  const globalTenant = await db.query.tenant.findFirst({ where: eq(tenant.slug, slug) });
  if (!globalTenant) {
    throw new Error(`Global tenant (slug=${slug}) not seeded — run the hub once before migrating`);
  }

  // Distinct users are the better-auth user rows.
  const users = await db.query.user.findMany();

  const summary: MigrationSummary = {
    dryRun: opts.dryRun,
    globalTenantId: globalTenant.id,
    users: [],
    failures: [],
  };

  for (const user of users) {
    try {
      const res = await migrateUserToGlobalTenant(
        db,
        {
          userId: user.id,
          globalTenantId: globalTenant.id,
          globalTenantDomain: domain,
          dryRun: opts.dryRun,
        },
        deps
      );
      summary.users.push(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to migrate user — continuing', {
        userId: user.id,
        error: err instanceof Error ? err : new Error(message),
      });
      summary.failures.push({ userId: user.id, error: message });
    }
  }

  log.info('Migration complete', {
    dryRun: opts.dryRun,
    migrated: summary.users.length,
    failures: summary.failures.length,
  });
  return summary;
}
