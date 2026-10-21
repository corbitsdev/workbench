// Exercises the hub's own composition: the stock platform routes answer,
// a Corbits mount (mailbox) sits inside the native tenant middleware rather
// than replacing it, and the hub-root run-scoped routes (`/api/workflow-artifacts`
// and `/api/workflow-memory`) seed the tenant context from the run named by
// `x-workflow-run-address` before `@corbits/agent-token` verifies the bearer.
// Platform behavior behind stock routes belongs to @intx/hub-api and is not
// re-proven here. Booting the hub runs package migrations, so a reachable
// DATABASE_URL is required and the suite skips without one.

import { afterAll, expect, test } from "bun:test";
import { mintAgentToken } from "@corbits/agent-token";
import { createDB } from "@intx/db";
import { principal, tenant, workflowDefinition, workflowRun } from "@intx/db/schema";
import { dbGate } from "../lib/db-gate";
import { bootHub } from "../lib/hub";
import { cleanupTenants } from "../lib/tenant-cleanup";

const describeIfDb = dbGate(process.env["DATABASE_URL"] ?? "", import.meta.path);
const seededTenantIds: string[] = [];

afterAll(async () => {
  await cleanupTenants(seededTenantIds);
});

describeIfDb("boot", () => {
  const first = bootHub();
  const second = bootHub();

  test("serves stock platform routes", async () => {
    const opts = first();

    const status = await opts.fetch(new Request("http://localhost/status"));
    expect(status.status).toBe(200);

    const me = await opts.fetch(new Request("http://localhost/api/me/principals"));
    expect(me.status).toBe(401);
  });

  test("a Corbits mount (mailbox) sits inside the native tenant middleware", async () => {
    const opts = second();

    // Anonymous request to a Corbits-mounted route: the platform's tenant
    // middleware answers 401 before the mailbox library's own handler runs.
    const gated = await opts.fetch(
      new Request("http://localhost/api/tenants/some-tenant/mailbox/me/inbox"),
    );
    expect(gated.status).toBe(401);
  });

  test("hub-root workflow routes authenticate an agent token against the run's tenant", async () => {
    const opts = first();
    const url = new URL(process.env["DATABASE_URL"] ?? "postgres://x@localhost/x");
    const handle = createDB({
      host: url.hostname,
      port: url.port === "" ? 5432 : Number(url.port),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ""),
    });
    try {
      const suffix = crypto.randomUUID().slice(0, 8);
      const tenantId = `tnt_comp_${suffix}`;
      const otherTenantId = `tnt_other_${suffix}`;
      seededTenantIds.push(tenantId, otherTenantId);
      const principalId = `prn_comp_${suffix}`;
      const definitionId = `def_comp_${suffix}`;
      const runId = `run_comp_${suffix}`;
      const runAddress = `${runId}@comp-${suffix}.test`;

      await handle.db.insert(tenant).values([
        {
          id: tenantId,
          name: "Composition Tenant",
          slug: `comp-${suffix}`,
          domain: `comp-${suffix}.test`,
        },
        {
          id: otherTenantId,
          name: "Other Tenant",
          slug: `other-${suffix}`,
          domain: `other-${suffix}.test`,
        },
      ]);
      await handle.db.insert(principal).values({
        id: principalId,
        tenantId,
        kind: "workflow",
        refId: runId,
        status: "active",
      });
      await handle.db.insert(workflowDefinition).values({
        id: definitionId,
        tenantId,
        name: "worker",
      });
      await handle.db.insert(workflowRun).values({
        id: runId,
        definitionId,
        anchorRunId: runId,
        tenantId,
        principalId,
        address: runAddress,
      });

      const minted = await mintAgentToken(handle.db, {
        tenantId,
        definitionId,
        name: "worker-hub",
      });
      const otherMinted = await mintAgentToken(handle.db, {
        tenantId: otherTenantId,
        definitionId,
        name: "other-hub",
      });

      const authedArtifacts = await opts.fetch(
        new Request("http://localhost/api/workflow-artifacts/artifacts/recent", {
          headers: {
            authorization: `Bearer ${minted.token}`,
            "x-workflow-run-address": runAddress,
          },
        }),
      );
      expect(authedArtifacts.status).toBe(200);

      const authedMemory = await opts.fetch(
        new Request("http://localhost/api/workflow-memory/list", {
          headers: {
            authorization: `Bearer ${minted.token}`,
            "x-workflow-run-address": runAddress,
          },
        }),
      );
      expect(authedMemory.status).toBe(200);

      const crossTenant = await opts.fetch(
        new Request("http://localhost/api/workflow-artifacts/artifacts/recent", {
          headers: {
            authorization: `Bearer ${otherMinted.token}`,
            "x-workflow-run-address": runAddress,
          },
        }),
      );
      expect(crossTenant.status).toBe(401);

      // Missing or unknown run address must answer 401 rather than throwing 500
      // when `c.get("tenant")` would otherwise be unset.
      const missingRun = await opts.fetch(
        new Request("http://localhost/api/workflow-memory/list", {
          headers: {
            authorization: `Bearer ${minted.token}`,
            "x-workflow-run-address": `missing-${suffix}@comp-${suffix}.test`,
          },
        }),
      );
      expect(missingRun.status).toBe(401);
    } finally {
      await handle.close();
    }
  });
});
