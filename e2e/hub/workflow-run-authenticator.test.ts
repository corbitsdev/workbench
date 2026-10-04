// The run authenticator must bind a sidecar token to the run its allocation
// anchors, and only while that allocation is live. Rows are real, so the
// suite skips without a reachable DATABASE_URL.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { sha256 } from "@intx/crypto";
import { createDB, dropSchema, runMigrations } from "@intx/db";
import {
  principal,
  sidecar,
  sidecarAllocation,
  tenant,
  workflowDefinition,
  workflowRun,
} from "@intx/db/schema";
import { createWorkflowRunAuthenticator } from "../../apps/hub/src/workflow-run-authenticator";
import { dbGate } from "../lib/db-gate";

const describeIfDb = dbGate(process.env["DATABASE_URL"] ?? "", import.meta.path);

describeIfDb("workflow run authenticator", () => {
  const url = new URL(process.env["DATABASE_URL"] ?? "postgres://x@localhost/x");
  // A dedicated schema keeps the suite independent of the shared database's
  // migration level.
  const config = {
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    schema: `run_auth_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
  };
  const handle = createDB(config);
  const { db } = handle;
  const suffix = crypto.randomUUID().slice(0, 8);

  async function seedTenant(name: string) {
    const id = `t-${name}-${suffix}`;
    await db.insert(tenant).values({
      id,
      name,
      slug: `${name}-${suffix}`,
      domain: `${name}-${suffix}.example.com`,
    });
    return id;
  }

  // One deployment: an anchor run, a child run, a live sidecar allocation.
  async function seedDeployment(tenantId: string, name: string, status = "allocated") {
    const definitionId = `d-${name}-${suffix}`;
    const anchorId = `anchor-${name}-${suffix}`;
    const principalId = `p-${name}-${suffix}`;
    const token = `token-${name}-${suffix}`;
    const sidecarId = `s-${name}-${suffix}`;
    await db.insert(workflowDefinition).values({
      id: definitionId,
      tenantId,
      name,
    });
    await db.insert(principal).values({
      id: principalId,
      tenantId,
      kind: "workflow",
      refId: anchorId,
      status: "active",
    });
    await db.insert(workflowRun).values({
      id: anchorId,
      definitionId,
      anchorRunId: anchorId,
      tenantId,
      principalId,
      address: `${name}-${suffix}@example.com`,
    });
    await db.insert(workflowRun).values({
      id: `child-${name}-${suffix}`,
      definitionId,
      anchorRunId: anchorId,
      tenantId,
      principalId,
      address: `child-${name}-${suffix}@example.com`,
    });
    await db.insert(sidecar).values({
      id: sidecarId,
      tokenHashSha256: Buffer.from(await sha256(token)),
    });
    await db.insert(sidecarAllocation).values({
      id: `a-${name}-${suffix}`,
      anchorRunId: anchorId,
      tenantId,
      provisionerId: "test",
      provisionerApiVersion: 1,
      provisionerBindingFingerprint: "test",
      sidecarId,
      status: status as "allocated",
    });
    return {
      token,
      anchorAddress: `${name}-${suffix}@example.com`,
      childAddress: `child-${name}-${suffix}@example.com`,
      anchorId,
      principalId,
    };
  }

  const authenticator = createWorkflowRunAuthenticator({ db });
  let tenantId: string;

  beforeAll(async () => {
    await runMigrations(config, { schema: config.schema });
    tenantId = await seedTenant("one");
  }, 120_000);

  afterAll(async () => {
    await handle.close();
    await dropSchema(config, { schema: config.schema });
  }, 60_000);

  test("a token resolves the run its allocation anchors, and that run's children", async () => {
    const a = await seedDeployment(tenantId, "own");
    expect(await authenticator.resolve(a.token, a.anchorAddress)).toEqual({
      tenantId,
      principalId: a.principalId,
      runId: a.anchorId,
    });
    expect((await authenticator.resolve(a.token, a.childAddress))?.tenantId).toBe(tenantId);
  });

  test("a token for run A does not authenticate as run B", async () => {
    const a = await seedDeployment(tenantId, "runa");
    const b = await seedDeployment(tenantId, "runb");
    expect(await authenticator.resolve(a.token, b.anchorAddress)).toBeNull();
    expect(await authenticator.resolve(a.token, b.childAddress)).toBeNull();
  });

  test("a released allocation's token no longer authenticates", async () => {
    const a = await seedDeployment(tenantId, "released", "released");
    expect(await authenticator.resolve(a.token, a.anchorAddress)).toBeNull();
  });
});
