// Regression for the FK-teardown bug that broke install-package and every
// other hub-booting seeder suite: deleting a tenant used to trip on
// `workflow_run_launch_spec.source_authority_principal_id` (RESTRICT on
// `principal`). The cleanup's referencer-removal list was missing the launch
// spec — and its anchor run — so `delete from tenant` failed with
// "violates RESTRICT setting of foreign key constraint
// workflow_run_launch_spec_source_authority_principal_id". This suite seeds
// exactly that shape (tenant → principal → definition → run → launch spec)
// and asserts cleanupTenants removes it all and the tenant row.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { createDB, schema, type DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { e2eDatabaseUrl } from "../lib/database-url";
import { dbGate } from "../lib/db-gate";
import { cleanupTenants } from "../lib/tenant-cleanup";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

function dbConfigFromUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port === "" ? 5432 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
  };
}

describeIfDb("cleanupTenants launches", () => {
  let db: DB;

  const tenantId = generateId("tenant");
  const principalId = generateId("principal");
  const definitionId = generateId("workflowDefinition");
  const runId = generateId("workflowRun");
  const sessionId = generateId("session");
  const domain = `tenant-cleanup-${tenantId}.localhost`;

  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    db = createDB(dbConfigFromUrl(databaseUrl));

    await db.db.insert(schema.tenant).values({
      id: tenantId,
      name: "Tenant Cleanup Test Tenant",
      slug: `tenant-cleanup-${tenantId.replaceAll("_", "-")}`,
      domain,
      parentId: null,
      config: null,
    });
    await db.db.insert(schema.principal).values({
      id: principalId,
      tenantId,
      kind: "user",
      refId: "usr_test",
      status: "active",
    });
    await db.db.insert(schema.workflowDefinition).values({
      id: definitionId,
      tenantId,
      creatorPrincipalId: principalId,
      assetId: null,
      name: "tenant-cleanup-test-definition",
    });
    await db.db.insert(schema.workflowRun).values({
      id: runId,
      definitionId,
      anchorRunId: runId,
      tenantId,
      principalId,
      address: `${runId}@${domain}`,
      status: "deployed",
    });
    // The exact row that used to wedge teardown: its
    // `sourceAuthorityPrincipalId` RESTRICT-references the tenant's
    // principal, and the launch spec has no `tenant_id` of its own, so it is
    // only reachable from the tenant through the run.
    await db.db.insert(schema.workflowRunLaunchSpec).values({
      anchorRunId: runId,
      sessionId,
      deploymentDomain: domain,
      sourceAuthorityPrincipalId: principalId,
      frozenApprovalBundle: {},
      sourceOfferingIds: [],
      defaultSourceOfferingId: "off_test",
      deployContent: { systemPrompt: "" },
    });
  });

  afterAll(async () => {
    if (databaseUrl === undefined) return;
    await db.close();
  });

  test("deletes launch spec, run, definition, principal, and the tenant row", async () => {
    await cleanupTenants([tenantId]);

    const tenantRows = await db.db
      .select()
      .from(schema.tenant)
      .where(eq(schema.tenant.id, tenantId));
    expect(tenantRows).toHaveLength(0);

    const launchSpecRows = await db.db
      .select()
      .from(schema.workflowRunLaunchSpec)
      .where(inArray(schema.workflowRunLaunchSpec.anchorRunId, [runId]));
    expect(launchSpecRows).toHaveLength(0);
  });
});
