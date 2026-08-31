// CL-7242: reconstructs the audit's own reproduction -- two concurrent
// `startReviewingRepos` calls for the same repo -- against real,
// database-backed ports rather than plain fakes. `hasRepoGrant`/
// `mintRepoGrant` here fake a plain read-then-insert against the
// `grant` table directly, standing in for `apps/hub/src/index.ts`'s
// real binding (HTTP calls through `native-repo-grants.ts`, see
// CL-7242 follow-up "Mint workbench tenants and repo grants via
// Interchange HTTP") without a live hub-api server -- what this test
// actually proves is that `startReviewingRepos`' lease serializes any
// such hasRepoGrant/mintRepoGrant pair correctly, which is exactly
// what makes the real HTTP-bound versions safe too. The lease store's
// own test (`@corbits/webhook-triggers`'s
// `repo-review-lease.drizzle.test.ts`) proves the underlying
// compare-and-swap works; this proves `startReviewingRepos` itself
// settles on exactly one grant and one trigger, racing the two calls
// a double-click or a client retry would produce. DB-gated: skipped
// when DATABASE_URL is unset. Runs against its own scratch database
// (mirroring `@corbits/webhook-triggers`' own `store.drizzle.test.ts`),
// never the developer's or the walking-skeleton suite's.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";

import { runMigrations } from "@intx/db";
import * as intxSchema from "@intx/db/schema";
import { grant as grantTable, role as roleTable } from "@intx/db/schema";
import { createNoopCredentialCipher } from "@intx/crypto";
import {
  createDrizzleRepoReviewLeaseStore,
  createDrizzleWebhookTriggerStore,
  applyWebhookTriggersMigrations,
} from "@corbits/webhook-triggers";
import type { GitHubRepoSummary } from "@corbits/github-tools";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { dbGate } from "../../../scripts/e2e/db-gate";
import {
  startReviewingRepos,
  webhookTriggerName,
  type ConnectGithubSetupPorts,
} from "../src/connect-github-setup";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_connect_github_race_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const REPO: GitHubRepoSummary = {
  id: "1",
  name: "acme/widgets",
};
const TENANT_ID = "tnt_race";
const DEFINITION_ID = "def_code_review";

describeIfDb("startReviewingRepos under real concurrency (CL-7242)", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchTarget = new URL(scratchUrl);
  const scratchDatabase = scratchTarget.pathname.replace(/^\//, "");

  beforeAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
    const parsed = new URL(scratchUrl);
    await runMigrations(
      {
        host: parsed.hostname,
        port: Number(parsed.port || 5432),
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        database: scratchDatabase,
      },
      { schema: "public" },
    );
    await applyWebhookTriggersMigrations(scratchUrl);
  });

  afterAll(async () => {
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
  });

  test("two concurrent calls for the same repo mint exactly one grant and one trigger", async () => {
    const client = postgres(scratchUrl, {
      max: 10,
      onnotice: () => undefined,
    });
    try {
      const db = drizzle(client, { schema: intxSchema });
      const webhookStore = createDrizzleWebhookTriggerStore(
        db,
        createNoopCredentialCipher(),
      );
      const leaseStore = createDrizzleRepoReviewLeaseStore(db);

      const roleId = "role_race_member";
      await client`INSERT INTO "tenant" (id, name, slug, domain) VALUES (${TENANT_ID}, 'Acme', 'acme-race', 'acme-race.example')`;
      await client`INSERT INTO "role" (id, tenant_id, name) VALUES (${roleId}, ${TENANT_ID}, 'member')`;

      // Mirrors apps/hub/src/index.ts's real wiring exactly: the lease
      // is acquired first, and mintRepoGrant is a bare insert against
      // Interchange's own `grant` table -- no onConflict, no index of
      // ours on their table. Only the lease serializes the two racing
      // calls below.
      const buildPorts = (): ConnectGithubSetupPorts => ({
        acquireRepoReviewLease: (repo) =>
          leaseStore.acquire(TENANT_ID, repo.name),
        releaseRepoReviewLease: (repo) =>
          leaseStore.release(TENANT_ID, repo.name),
        hasRepoGrant: async (repo) => {
          const existing = await db.query.grant.findFirst({
            where: and(
              eq(grantTable.tenantId, TENANT_ID),
              eq(grantTable.resource, `repo:${repo.name}`),
              eq(grantTable.action, "read"),
            ),
            columns: { id: true },
          });
          return existing !== undefined;
        },
        mintRepoGrant: async (repo) => {
          const memberRole = await db.query.role.findFirst({
            where: and(
              eq(roleTable.tenantId, TENANT_ID),
              eq(roleTable.name, "member"),
            ),
            columns: { id: true },
          });
          if (memberRole === undefined) throw new Error("no member role");
          await db.insert(grantTable).values({
            id: `grant_${crypto.randomUUID()}`,
            tenantId: TENANT_ID,
            roleId: memberRole.id,
            resource: `repo:${repo.name}`,
            action: "read",
            effect: "allow",
            origin: "system",
          });
        },
        hasWebhookTrigger: async (repo) => {
          const triggers = await webhookStore.list(TENANT_ID);
          const name = webhookTriggerName(repo);
          return triggers.some(
            (t) => t.workflowDefinitionId === DEFINITION_ID && t.name === name,
          );
        },
        createWebhookTrigger: async (repo) => {
          const row = await webhookStore.ensure({
            id: `wht_${crypto.randomUUID()}`,
            tenantId: TENANT_ID,
            name: webhookTriggerName(repo),
            workflowDefinitionId: DEFINITION_ID,
            inputTemplate:
              "Review the pull request at {{pull_request.html_url}}",
            secret: crypto.randomUUID(),
            createdBy: "user_1",
          });
          return { id: row.id };
        },
        persistSelectedRepos: async () => {},
      });

      const [first, second] = await Promise.all([
        startReviewingRepos(["1"], [REPO], buildPorts()),
        startReviewingRepos(["1"], [REPO], buildPorts()),
      ]);

      // Whether the second call gets skipped by the lease or simply
      // finds the work already done (CL-7134's fast path) depends on
      // real, non-deterministic timing between the two real Postgres
      // round trips -- both are correct outcomes. The property this
      // test actually cares about is that at most one trigger is ever
      // created, and the database never ends up with a duplicate.
      const totalCreated =
        first.createdTriggerIds.length + second.createdTriggerIds.length;
      expect(totalCreated).toBe(1);

      const grantRows = await client`
        SELECT id FROM "grant"
        WHERE tenant_id = ${TENANT_ID} AND resource = 'repo:acme/widgets'
      `;
      expect(grantRows).toHaveLength(1);

      const triggerRows = await client`
        SELECT id FROM "webhook_triggers"."webhook_trigger"
        WHERE tenant_id = ${TENANT_ID} AND workflow_definition_id = ${DEFINITION_ID}
      `;
      expect(triggerRows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });
});
