import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { schema } from "../db";
import type { HubDb } from "../db";
import { workflowRun } from "../db/schema";
import { loadDeploymentMeta } from "./run-store";

// Real (PGlite) round-trip for the version-badge audit read. The badge must
// resolve a run's deployed version straight from the deployment index —
// regardless of whether that deployment was later disabled, superseded, or
// undeployed (all of which soft-delete the row) — so this exercises the actual
// drizzle select, not a mock. The seam matters: a redeploy soft-deletes the
// prior deployment, and the run that executed on it is exactly the audit case.
const DDL = `
  CREATE TABLE workflow_run (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id text,
    tenant_id text NOT NULL,
    principal_id text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    input jsonb,
    output jsonb,
    meta jsonb,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    deleted_at timestamp
  );
`;

let client: PGlite;
let db: HubDb;

beforeEach(async () => {
  client = new PGlite();
  await client.exec(DDL);
  db = drizzle(client, { schema }) as unknown as HubDb;
});

afterEach(async () => {
  await client.close();
});

const meta = {
  version: "3",
  sha: "a1b2c3d",
  deployedAt: "2026-05-01T00:00:00.000Z",
};

const baseRow = {
  tenantId: "tn-1",
  principalId: "prn-1",
  kind: "pain-point-collateral",
  status: "running",
};

describe("loadDeploymentMeta", () => {
  test("resolves version meta for a live deployment", async () => {
    await db
      .insert(workflowRun)
      .values({ ...baseRow, deploymentId: "ses_live", meta });

    expect(await loadDeploymentMeta(db, "ses_live")).toEqual(meta);
  });

  test("still resolves meta for a soft-deleted (superseded) deployment", async () => {
    await db.insert(workflowRun).values({
      ...baseRow,
      deploymentId: "ses_gone",
      status: "superseded",
      meta,
      deletedAt: new Date(),
    });

    expect(await loadDeploymentMeta(db, "ses_gone")).toEqual(meta);
  });

  test("returns null when the deployment has no captured meta", async () => {
    await db
      .insert(workflowRun)
      .values({ ...baseRow, deploymentId: "ses_nometa", meta: null });

    expect(await loadDeploymentMeta(db, "ses_nometa")).toBeNull();
  });

  test("returns null for an unknown deploymentId", async () => {
    expect(await loadDeploymentMeta(db, "ses_missing")).toBeNull();
  });
});
