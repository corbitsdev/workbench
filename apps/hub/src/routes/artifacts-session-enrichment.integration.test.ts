import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { Hono } from "hono";

import { schema } from "../db";
import type { HubDb } from "../db";

const TENANT = "tn-artifact-session";
const PRINCIPAL = "prn-viewer";

mock.module("../lib/user-context", () => ({
  getRequestedUserContext: () =>
    Promise.resolve({
      context: { tenantId: TENANT, principalId: PRINCIPAL },
      forbidden: false,
    }),
}));

const intxDbReal = await import("@intx/db");
mock.module("@intx/db", () => ({
  ...intxDbReal,
  getAncestorChain: () => Promise.resolve([TENANT]),
}));

const { createArtifactsRouter: loadRouter } = await import("./artifacts");

let client: PGlite;
let db: HubDb;

function app(): Hono<{ Variables: { userId: string } }> {
  const parent = new Hono<{ Variables: { userId: string } }>();
  parent.use("*", async (c, next) => {
    c.set("userId", "user-1");
    await next();
  });
  parent.route(
    "/",
    loadRouter(
      db,
      {} as unknown as Parameters<typeof createArtifactsRouter>[1],
    ),
  );
  return parent;
}

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
  await client.exec(`DELETE FROM artifact;`);
  await client.exec(`DELETE FROM workflow_run_record;`);
  await client.exec(`DELETE FROM workflow_run;`);
});

describe("GET /artifacts session enrichment", () => {
  test("joins provenance sessionId to workflow_run_record and deploy meta label", async () => {
    const deploymentId = "ses_enrich_deploy";
    const runId = "run_enrich_1";
    const now = "2026-06-01T12:00:00.000Z";

    await client.query(
      `insert into workflow_run (deployment_id, tenant_id, principal_id, kind, status, meta, created_at, updated_at)
       values ($1, $2, $3, 'heartbeat', 'running', $4::jsonb, $5, $5)`,
      [
        deploymentId,
        TENANT,
        PRINCIPAL,
        JSON.stringify({
          version: "1.0.0",
          sha: "abc1234",
          deployedAt: now,
          label: "Morning brief",
        }),
        now,
      ],
    );

    await client.query(
      `insert into workflow_run_record (id, deployment_id, kind, tenant_id, principal_id, status, created_at, updated_at)
       values ($1, $2, 'heartbeat', $3, $4, 'completed', $5, $5)`,
      [runId, deploymentId, TENANT, PRINCIPAL, now],
    );

    await client.query(
      `insert into artifact (id, tenant_id, kind, title, content, source, created_at, updated_at)
       values ($1, $2, 'document', 'Brief output', 'body', $3::jsonb, $4, $4)`,
      [
        "00000000-0000-4000-8000-000000000001",
        TENANT,
        JSON.stringify({
          origin: "workflow",
          sessionId: deploymentId,
        }),
        now,
      ],
    );

    const res = await app().request(`/artifacts?tenantId=${TENANT}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifacts: Array<{
        id: string;
        sessionId: string | null;
        sessionName: string | null;
        sessionStatus: string | null;
      }>;
    };
    const row = body.artifacts.find(
      (a) => a.id === "00000000-0000-4000-8000-000000000001",
    );
    expect(row).toBeDefined();
    expect(row!.sessionId).toBe(runId);
    expect(row!.sessionName).toBe("Morning brief");
    expect(row!.sessionStatus).toBe("done");
  });

  test("resolves when provenance sessionId is the run record id", async () => {
    const runId = "run_direct_id";
    const now = "2026-06-02T12:00:00.000Z";

    await client.query(
      `insert into workflow_run_record (id, deployment_id, kind, tenant_id, principal_id, status, created_at, updated_at)
       values ($1, 'ses_dep', 'deck', $2, $3, 'running', $4, $4)`,
      [runId, TENANT, PRINCIPAL, now],
    );

    await client.query(
      `insert into artifact (id, tenant_id, kind, title, content, source, created_at, updated_at)
       values ($1, $2, 'document', 'Deck slide', 'body', $3::jsonb, $4, $4)`,
      [
        "00000000-0000-4000-8000-000000000002",
        TENANT,
        JSON.stringify({ origin: "workflow", sessionId: runId }),
        now,
      ],
    );

    const res = await app().request(
      `/artifacts/00000000-0000-4000-8000-000000000002?tenantId=${TENANT}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifact: {
        sessionId: string | null;
        sessionStatus: string | null;
      };
    };
    expect(body.artifact.sessionId).toBe(runId);
    expect(body.artifact.sessionStatus).toBe("generating");
  });
});
