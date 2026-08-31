// DB-gated: proves `record`'s upsert semantics and the redeploy round trip
// against a real Postgres transaction, mirroring
// packages/run-key-history/test/store.test.ts's scratch-database setup.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyWorkflowDeploySourceMigrations } from "../src/migrations";
import { createDrizzleWorkflowDeploySourceStore } from "../src/store";
import { dbGate } from "../../../scripts/e2e/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_workflow_deploy_source_store_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

describeIfDb("createDrizzleWorkflowDeploySourceStore", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

  async function withMaintenance(run: (sql: postgres.Sql) => Promise<void>) {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await run(maintenance);
    } finally {
      await maintenance.end();
    }
  }

  beforeAll(async () => {
    await withMaintenance(async (sql) => {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await sql.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    });
    await applyWorkflowDeploySourceMigrations(scratchUrl);
  }, 20000);

  afterAll(async () => {
    await withMaintenance(async (sql) => {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    });
  }, 20000);

  test("records and reads back an asset-sourced deploy", async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    const db = drizzle(sql);
    const store = createDrizzleWorkflowDeploySourceStore(db);
    try {
      await store.record({
        anchorRunId: "run_asset_1",
        tenantId: "tenant_1",
        deploymentDomain: "tenant1.workbench.dev",
        source: {
          kind: "asset",
          assetId: "asset_1",
          package: { format: "source", commitSha: "a".repeat(40) },
        },
        entry: "workflow.ts",
        definitionAssetId: "asset_1",
        sourceAuthorityPrincipalId: "principal_1",
      });

      const row = await store.get("run_asset_1");
      expect(row).not.toBeNull();
      expect(row?.source).toEqual({
        kind: "asset",
        assetId: "asset_1",
        package: { format: "source", commitSha: "a".repeat(40) },
      });
      expect(row?.pin).toBeNull();
      expect(row?.sourceRef).toBeNull();
    } finally {
      await sql.end();
    }
  });

  test("a redeploy overwrites the prior record for the same anchor run", async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    const db = drizzle(sql);
    const store = createDrizzleWorkflowDeploySourceStore(db);
    try {
      await store.record({
        anchorRunId: "run_rotate",
        tenantId: "tenant_1",
        deploymentDomain: "tenant1.workbench.dev",
        source: {
          kind: "asset",
          assetId: "asset_1",
          package: { format: "source", commitSha: "a".repeat(40) },
        },
        entry: "workflow.ts",
        definitionAssetId: "asset_1",
        sourceAuthorityPrincipalId: "principal_1",
      });
      await store.record({
        anchorRunId: "run_rotate",
        tenantId: "tenant_1",
        deploymentDomain: "tenant1.workbench.dev",
        source: {
          kind: "asset",
          assetId: "asset_1",
          package: { format: "source", commitSha: "b".repeat(40) },
        },
        entry: "workflow.ts",
        definitionAssetId: "asset_1",
        sourceAuthorityPrincipalId: "principal_1",
      });

      const row = await store.get("run_rotate");
      expect(row?.source).toEqual({
        kind: "asset",
        assetId: "asset_1",
        package: { format: "source", commitSha: "b".repeat(40) },
      });
    } finally {
      await sql.end();
    }
  });

  // The deliberate proof CL-6581 phase 1 asks for: everything a shared
  // placement deploy needs to be reissued survives in Postgres alone, with
  // NO input from the sidecar's local `deployment.json`. This test writes a
  // record with one connection (standing in for the hub process that
  // performed the original deploy), then opens a FRESH connection and store
  // instance (standing in for a hub restart with no shared in-memory state)
  // and reconstructs the exact `DeployWorkflowFromSourceParams` shape a
  // redeploy call needs -- proving the record alone, not any sidecar file,
  // is sufficient to redrive the deploy.
  test("a redeploy's full source-call intent survives a fresh connection, with no sidecar record involved", async () => {
    const writerSql = postgres(scratchUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      const writerStore = createDrizzleWorkflowDeploySourceStore(
        drizzle(writerSql),
      );
      await writerStore.record({
        anchorRunId: "run_restart_proof",
        tenantId: "tenant_1",
        deploymentDomain: "tenant1.workbench.dev",
        source: {
          kind: "asset",
          assetId: "asset_native_workflow",
          package: {
            format: "source",
            commitSha: "c".repeat(40),
            packageName: "@corbits/example-workflow",
          },
        },
        entry: "src/workflow.ts",
        definitionAssetId: "asset_native_workflow",
        sourceRef: "refs/heads/runs/run_restart_proof",
        sourceAuthorityPrincipalId: "principal_seed",
      });
    } finally {
      await writerSql.end();
    }

    // A fresh process, a fresh connection, a fresh store -- nothing carried
    // over from the write above except what landed in Postgres.
    const readerSql = postgres(scratchUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      const readerStore = createDrizzleWorkflowDeploySourceStore(
        drizzle(readerSql),
      );
      const row = await readerStore.get("run_restart_proof");
      expect(row).not.toBeNull();
      if (row === null) return;

      // Everything `DeployWorkflowFromSourceParams` needs beyond a fresh
      // `HarnessConfig` (re-resolved from the tenant's live inference
      // catalog, never persisted here) is present and round-trips exactly.
      const redeployParams = {
        tenantId: row.tenantId,
        anchorRunId: row.anchorRunId,
        deploymentDomain: row.deploymentDomain,
        source: row.source,
        entry: row.entry,
        definitionAssetId: row.definitionAssetId,
        ...(row.pin !== null ? { pin: row.pin } : {}),
        ...(row.sourceRef !== null ? { sourceRef: row.sourceRef } : {}),
      };

      expect(redeployParams).toEqual({
        tenantId: "tenant_1",
        anchorRunId: "run_restart_proof",
        deploymentDomain: "tenant1.workbench.dev",
        source: {
          kind: "asset",
          assetId: "asset_native_workflow",
          package: {
            format: "source",
            commitSha: "c".repeat(40),
            packageName: "@corbits/example-workflow",
          },
        },
        entry: "src/workflow.ts",
        definitionAssetId: "asset_native_workflow",
        sourceRef: "refs/heads/runs/run_restart_proof",
      });
    } finally {
      await readerSql.end();
    }
  });

  test("get returns null for an anchor run that was never recorded", async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    const db = drizzle(sql);
    const store = createDrizzleWorkflowDeploySourceStore(db);
    try {
      expect(await store.get("run_never_seen")).toBeNull();
    } finally {
      await sql.end();
    }
  });
});
