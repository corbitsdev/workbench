// DB-gated coverage for the freeze's persistence half: a create-path
// freeze leaves no half-frozen row (CL-6447's disease — a definition
// whose version row has NULL `wire_projection` is permanently
// unlaunchable), and the in-place re-freeze both follows an edit and
// heals a legacy row frozen before the projection was recorded.
// Runs against its own scratch database, never the developer's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";

import {
  createDB,
  loadFrozenGrantSnapshot,
  loadFrozenWireProjection,
  type DB,
} from "@intx/db";
import { asset, tenant, principal, workflowDefinition } from "@intx/db/schema";
import { ensureWorkflowDefinitionForAsset } from "@intx/hub-sessions";
import { generateId } from "@intx/hub-common";

import { defineAgent } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";

import { setupDatabase, dbTargetFromUrl } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import {
  freezeInertWorkflowDefinition,
  refreezeWorkflowDefinitionProjection,
} from "../src/index";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_workflow_freeze_test`;
  return url.toString();
}

function agentWorkflowJson(systemPrompt: string): string {
  const agent = defineAgent({
    id: "agent",
    description: "",
    systemPrompt,
    tools: [],
    capabilities: [],
    inference: { sources: [{ provider: "catalog", model: "m-test" }] },
  });
  return JSON.stringify(
    defineWorkflow({
      id: "wf_agent_freeze_db_test",
      trigger: { type: "mail", to: "freeze-db-test@example.test" },
      steps: {
        agent: step({ agent, timeout: 60_000, triggers: "unbounded" }),
      },
    }),
  );
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

describeIfDb("freezeInertWorkflowDefinition against Postgres", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

  let db: DB["db"];
  let close: () => Promise<void>;
  const tenantId = generateId("tenant");
  const principalId = generateId("principal");

  beforeAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
    await setupDatabase(scratchUrl);

    const handle = createDB(dbTargetFromUrl(scratchUrl));
    db = handle.db;
    close = handle.close;

    await db.insert(tenant).values({
      id: tenantId,
      name: "Freeze Test",
      slug: `freeze-test-${tenantId.slice(-8)}`,
      domain: `freeze-test-${tenantId.slice(-8)}.example`,
    });
    await db.insert(principal).values({
      id: principalId,
      tenantId,
      kind: "user",
      refId: `usr_${tenantId.slice(-8)}`,
      status: "active",
    });
  }, 60_000);

  afterAll(async () => {
    await close?.();
  });

  async function insertAsset(name: string): Promise<string> {
    const assetId = generateId("asset");
    await db.insert(asset).values({
      id: assetId,
      tenantId,
      kind: "workflow",
      name,
      displayName: name,
      creatorPrincipalId: principalId,
    });
    return assetId;
  }

  test("a create-path freeze leaves no half-frozen row", async () => {
    const assetId = await insertAsset("freeze-create");
    const { definitionId, wireHash } = await freezeInertWorkflowDefinition(db, {
      assetId,
      workflowJson: agentWorkflowJson("Be helpful."),
    });

    const projection = await loadFrozenWireProjection(db, definitionId);
    expect(projection).not.toBeNull();
    const snapshot = await loadFrozenGrantSnapshot(db, definitionId);
    expect(snapshot).not.toBeNull();

    const row = await db.query.workflowDefinition.findFirst({
      where: eq(workflowDefinition.id, definitionId),
    });
    expect(row?.wireHash).toBe(wireHash);
  });

  test("a re-freeze follows an edit in place — same definition, new content", async () => {
    const assetId = await insertAsset("freeze-edit");
    const created = await freezeInertWorkflowDefinition(db, {
      assetId,
      workflowJson: agentWorkflowJson("First instructions."),
    });

    const refrozen = await refreezeWorkflowDefinitionProjection(db, {
      definitionId: created.definitionId,
      workflowJson: agentWorkflowJson("Edited instructions."),
    });
    expect(refrozen.wireHash).not.toBe(created.wireHash);

    const row = await db.query.workflowDefinition.findFirst({
      where: eq(workflowDefinition.id, created.definitionId),
    });
    expect(row?.wireHash).toBe(refrozen.wireHash);

    const projection = await loadFrozenWireProjection(db, created.definitionId);
    expect(JSON.stringify(projection)).toContain("Edited instructions.");
  });

  test("a re-freeze heals a legacy row frozen before the projection was recorded", async () => {
    const assetId = await insertAsset("freeze-legacy");
    const workflowJson = agentWorkflowJson("Legacy instructions.");
    // The pre-fix write: a bare ensure, no stamp — the permanently
    // unlaunchable state CL-6447 reproduced.
    const { definitionId } = await ensureWorkflowDefinitionForAsset(db, {
      assetId,
      wireHash: "legacy-raw-json-hash",
    });
    expect(await loadFrozenWireProjection(db, definitionId)).toBeNull();

    await refreezeWorkflowDefinitionProjection(db, {
      definitionId,
      workflowJson,
    });
    expect(await loadFrozenWireProjection(db, definitionId)).not.toBeNull();
    expect(await loadFrozenGrantSnapshot(db, definitionId)).not.toBeNull();
  });

  // CL-6452: a freeze produces a launch-authoritative definition. Only
  // a folded run's own deploy demotes the sibling it mints to a per-run
  // record (`@corbits/folded-runs`' `markRunDeployClone`), so a freeze —
  // and any other deploy that ensures a definition — stays authored.
  test("a freeze produces a launch-authoritative definition", async () => {
    const assetId = await insertAsset("freeze-origin");
    const { definitionId } = await freezeInertWorkflowDefinition(db, {
      assetId,
      workflowJson: agentWorkflowJson("Authored instructions."),
    });
    const authoredRow = await db.query.workflowDefinition.findFirst({
      where: eq(workflowDefinition.id, definitionId),
    });
    expect(authoredRow?.origin).toBe("authored");

    const sibling = await ensureWorkflowDefinitionForAsset(db, {
      assetId,
      wireHash: "another-deploy-hash",
    });
    expect(sibling.definitionId).not.toBe(definitionId);
    const siblingRow = await db.query.workflowDefinition.findFirst({
      where: eq(workflowDefinition.id, sibling.definitionId),
    });
    expect(siblingRow?.origin).toBe("authored");
  });
});
