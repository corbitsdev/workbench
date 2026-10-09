// Shared teardown for the e2e seeding suites that create tenants/principals/
// roles over stock HTTP routes and never delete them. Reruns of those suites
// used to accumulate rows in the shared `_e2e` database, so every seeder
// suite now registers one `afterAll` that removes exactly the tenants it
// created. Deleting a tenant cascades to the vast majority of its rows
// (principals, roles, grants, providers, credentials, catalog rows, workflow
// definitions/assets/runs, sessions, approvals, oauth clients, ...), but a
// few tables reference tenant with `onDelete: "restrict"` (sidecar_allocation,
// workflow_probe) or reference tenant with NO action (git_token), and a
// workflow_run_launch_spec references the tenant's principal with
// `onDelete: "restrict"` despite having no tenant_id of its own, so all of
// those are deleted first while the tenant row is still present.
import { inArray } from "drizzle-orm";

import { createDB } from "@intx/db";
import {
  gitToken,
  sidecarAllocation,
  tenant as tenantTable,
  workflowProbe,
  workflowRun,
  workflowRunLaunchSpec,
} from "@intx/db/schema";

import { e2eDatabaseUrl } from "./database-url";

/**
 * Deletes the tenants named by `tenantIds` together with every row that
 * references them. Idempotent per id: filtering on `inArray` makes deleting
 * already-absent ids a no-op, so a suite can pass ids of tenants that may have
 * failed to be created and still tear down cleanly.
 */
export async function cleanupTenants(tenantIds: readonly string[]): Promise<void> {
  if (tenantIds.length === 0) return;
  const databaseUrl = e2eDatabaseUrl();
  if (databaseUrl === undefined) return;
  const parsed = new URL(databaseUrl);
  const handle = createDB({
    host: parsed.hostname,
    port: parsed.port === "" ? 5432 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
  });
  try {
    const { db } = handle;
    // No-action-on-tenant rows and restrict-on-tenant rows must go before the
    // tenant row itself.
    await db.delete(gitToken).where(inArray(gitToken.tenantId, tenantIds));
    await db.delete(sidecarAllocation).where(inArray(sidecarAllocation.tenantId, tenantIds));
    await db.delete(workflowProbe).where(inArray(workflowProbe.tenantId, tenantIds));
    // `workflow_run_launch_spec.source_authority_principal_id` RESTRICT-
    // references the tenant's principal but the launch spec has no
    // `tenant_id` of its own: it reaches the tenant only through its anchor
    // run. Delete those launch specs (by their tenant's runs) before the
    // run/principal cascade can trip the RESTRICT, then the runs they kept
    // alive.
    const runIds = await db
      .select({ id: workflowRun.id })
      .from(workflowRun)
      .where(inArray(workflowRun.tenantId, tenantIds));
    if (runIds.length > 0) {
      await db.delete(workflowRunLaunchSpec).where(
        inArray(
          workflowRunLaunchSpec.anchorRunId,
          runIds.map((r) => r.id),
        ),
      );
      await db.delete(workflowRun).where(inArray(workflowRun.tenantId, tenantIds));
    }
    await db.delete(tenantTable).where(inArray(tenantTable.id, tenantIds));
  } finally {
    await handle.close();
  }
}
