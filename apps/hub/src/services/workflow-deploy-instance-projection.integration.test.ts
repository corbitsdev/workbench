import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import {
  deriveDeploymentAddress,
  deriveWorkflowRunRepoId,
} from "@intx/workflow-deploy";
import { createHubSessionLookups } from "@intx/hub-sessions";

import { schema } from "../db";
import type { HubDb } from "../db";
import {
  deleteInstanceDeploymentProjection,
  ensureWorkflowDefinitionAsset,
  reconcileInstanceDeploymentProjections,
  writeInstanceDeploymentProjection,
  writeWorkflowDeploymentRow,
} from "./workflow-deploy";

// Real-Postgres (PGlite) exercise of the native deployment projection a
// launched agent writes, and the interchange lookups (registerSignalCorrelation
// + lookupPublicKey) that ride the same `workflow_deployment` table — the seam
// CL-3931 unblocks for native approvals (CL-3934). FK triggers are disabled so a
// test can seed a single row without materializing every referenced tenant /
// asset / principal; the behavior under test is the projection round-trip, not
// referential integrity.
let client: PGlite;
let db: HubDb;

const TENANT = "tn-1";
const AGENT = "agt-1";
const PRINCIPAL = "prn-1";
const DOMAIN = "tenant.localhost";

beforeAll(async () => {
  client = new PGlite();
  const bootstrap = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, bootstrap as never);
  await apply();
  await client.exec(`SET session_replication_role = 'replica';`);
  db = bootstrap as unknown as HubDb;
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.exec(`DELETE FROM signal_correlation;`);
  await client.exec(`DELETE FROM approval;`);
  await client.exec(`DELETE FROM workflow_deployment;`);
  await client.exec(`DELETE FROM asset;`);
  await client.exec(`DELETE FROM "grant";`);
  await client.exec(`DELETE FROM agent_instance;`);
});

async function deploymentRows() {
  return db.select().from(intxSchema.workflowDeployment);
}

async function grantRows(resource: string) {
  return db
    .select()
    .from(intxSchema.grant)
    .where(eq(intxSchema.grant.resource, resource));
}

describe("writeInstanceDeploymentProjection", () => {
  test("writes the row, workflow asset, and creator grant a launched agent needs", async () => {
    const address = `ins_abc123@${DOMAIN}`;
    await writeInstanceDeploymentProjection({
      db,
      instanceAddress: address,
      agentId: AGENT,
      tenantId: TENANT,
      creatorPrincipalId: PRINCIPAL,
    });

    const deploymentId = deriveWorkflowRunRepoId(address);
    const rows = await deploymentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(deploymentId);
    expect(rows[0]?.address).toBe(address);
    expect(rows[0]?.status).toBe("deployed");
    // A launched agent's key lives on agent_instance, never here.
    expect(rows[0]?.publicKey ?? null).toBeNull();

    const assets = await db
      .select()
      .from(intxSchema.asset)
      .where(eq(intxSchema.asset.name, `wf_${AGENT}`));
    expect(assets).toHaveLength(1);
    expect(rows[0]?.definitionAssetId).toBe(assets[0]!.id);

    const grants = await grantRows(`workflow-run:${deploymentId}`);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.principalId).toBe(PRINCIPAL);
    expect(grants[0]?.action).toBe("read");
  });

  test("is idempotent across mail-wake redeploy cycles — one row, one grant", async () => {
    const address = `ins_wake1@${DOMAIN}`;
    for (let i = 0; i < 3; i++) {
      await writeInstanceDeploymentProjection({
        db,
        instanceAddress: address,
        agentId: AGENT,
        tenantId: TENANT,
        creatorPrincipalId: PRINCIPAL,
      });
    }
    const deploymentId = deriveWorkflowRunRepoId(address);
    expect(await deploymentRows()).toHaveLength(1);
    expect(await grantRows(`workflow-run:${deploymentId}`)).toHaveLength(1);
  });
});

describe("deleteInstanceDeploymentProjection", () => {
  test("removes the row and its creator grant on permanent teardown", async () => {
    const address = `ins_gone1@${DOMAIN}`;
    await writeInstanceDeploymentProjection({
      db,
      instanceAddress: address,
      agentId: AGENT,
      tenantId: TENANT,
      creatorPrincipalId: PRINCIPAL,
    });
    const deploymentId = deriveWorkflowRunRepoId(address);
    expect(await deploymentRows()).toHaveLength(1);

    await deleteInstanceDeploymentProjection({ db, instanceAddress: address });

    expect(await deploymentRows()).toHaveLength(0);
    expect(await grantRows(`workflow-run:${deploymentId}`)).toHaveLength(0);
  });
});

describe("per-run deployment projection round-trip", () => {
  test("writeWorkflowDeploymentRow persists a row the reconnect key lookup resolves", async () => {
    const deploymentId = "dep_run1";
    const address = deriveDeploymentAddress({
      deploymentId,
      deploymentDomain: DOMAIN,
    });
    const definitionAssetId = await ensureWorkflowDefinitionAsset({
      db,
      tenantId: TENANT,
      workflowId: "pain-point-collateral",
      creatorPrincipalId: PRINCIPAL,
    });
    await writeWorkflowDeploymentRow({
      db,
      deploymentId,
      deploymentDomain: DOMAIN,
      tenantId: TENANT,
      definitionAssetId,
      creatorPrincipalId: PRINCIPAL,
    });
    // Simulate the deploy-ack persisting the sidecar-minted key on the row.
    await db
      .update(intxSchema.workflowDeployment)
      .set({ publicKey: "pk-run1" })
      .where(eq(intxSchema.workflowDeployment.id, deploymentId));

    const lookups = createHubSessionLookups({
      db: db as never,
      agentRepoStore: {} as never,
    });
    // A workflow-derived (ins_dep_...) address routes its reconnect challenge
    // through workflow_deployment, not agent_instance.
    expect(await lookups.lookupPublicKey(address)).toBe("pk-run1");
  });
});

describe("registerSignalCorrelation over a launched-agent projection (CL-3934 unblock)", () => {
  test("succeeds against a row written by writeInstanceDeploymentProjection", async () => {
    const address = `ins_susp1@${DOMAIN}`;
    await writeInstanceDeploymentProjection({
      db,
      instanceAddress: address,
      agentId: AGENT,
      tenantId: TENANT,
      creatorPrincipalId: PRINCIPAL,
    });
    const deploymentId = deriveWorkflowRunRepoId(address);

    const lookups = createHubSessionLookups({
      db: db as never,
      agentRepoStore: {} as never,
    });
    await lookups.registerSignalCorrelation({
      correlationId: "corr-1",
      runId: "run-1",
      deploymentId,
      agentAddress: address,
      kind: "approval",
    });

    const correlations = await db
      .select()
      .from(intxSchema.signalCorrelation)
      .where(eq(intxSchema.signalCorrelation.correlationId, "corr-1"));
    expect(correlations).toHaveLength(1);
    expect(correlations[0]?.tenantId).toBe(TENANT);

    const approvals = await db
      .select()
      .from(intxSchema.approval)
      .where(eq(intxSchema.approval.correlationId, "corr-1"));
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.tenantId).toBe(TENANT);
  });

  test("throws when no deployment projection names the address (the pre-fix failure)", async () => {
    const address = `ins_missing@${DOMAIN}`;
    const deploymentId = deriveWorkflowRunRepoId(address);
    const lookups = createHubSessionLookups({
      db: db as never,
      agentRepoStore: {} as never,
    });
    await expect(
      lookups.registerSignalCorrelation({
        correlationId: "corr-x",
        runId: "run-x",
        deploymentId,
        agentAddress: address,
        kind: "approval",
      }),
    ).rejects.toThrow(/No deployed workflow deployment for address/);
  });
});

describe("reconcileInstanceDeploymentProjections", () => {
  async function seedInstance(overrides: {
    id: string;
    address: string;
    status?: string;
    endedAt?: Date | null;
  }) {
    await db.insert(intxSchema.agentInstance).values({
      id: overrides.id,
      agentId: AGENT,
      tenantId: TENANT,
      principalId: PRINCIPAL,
      address: overrides.address,
      status: (overrides.status ?? "running") as "running",
      endedAt: overrides.endedAt ?? null,
    });
  }

  test("backfills active launched agents, drops orphans, preserves per-run rows", async () => {
    const liveAddress = `ins_live1@${DOMAIN}`;
    const orphanAddress = `ins_orphan1@${DOMAIN}`;
    const perRunAddress = deriveDeploymentAddress({
      deploymentId: "dep_perrun1",
      deploymentDomain: DOMAIN,
    });

    // A currently-live launched agent with no projection row (the backfill case).
    await seedInstance({ id: "ins_live1", address: liveAddress });
    // An ended instance whose stale projection row must be reclaimed.
    await seedInstance({
      id: "ins_orphan1",
      address: orphanAddress,
      status: "stopped",
      endedAt: new Date(),
    });
    await writeInstanceDeploymentProjection({
      db,
      instanceAddress: orphanAddress,
      agentId: AGENT,
      tenantId: TENANT,
      creatorPrincipalId: PRINCIPAL,
    });
    // A per-run (workflow-derived) row the reconcile must never touch.
    const perRunAssetId = await ensureWorkflowDefinitionAsset({
      db,
      tenantId: TENANT,
      workflowId: "pain-point-collateral",
      creatorPrincipalId: PRINCIPAL,
    });
    await writeWorkflowDeploymentRow({
      db,
      deploymentId: "dep_perrun1",
      deploymentDomain: DOMAIN,
      tenantId: TENANT,
      definitionAssetId: perRunAssetId,
      creatorPrincipalId: PRINCIPAL,
    });

    const result = await reconcileInstanceDeploymentProjections({ db });
    expect(result.written).toBe(1);
    expect(result.deleted).toBe(1);

    const addresses = (await deploymentRows()).map((r) => r.address).sort();
    expect(addresses).toEqual([liveAddress, perRunAddress].sort());
  });

  test("is a no-op on a second pass (already converged)", async () => {
    await seedInstance({ id: "ins_live2", address: `ins_live2@${DOMAIN}` });
    await reconcileInstanceDeploymentProjections({ db });
    const second = await reconcileInstanceDeploymentProjections({ db });
    expect(second).toEqual({ written: 0, deleted: 0 });
  });
});
