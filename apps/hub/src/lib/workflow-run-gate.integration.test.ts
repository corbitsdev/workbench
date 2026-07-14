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
import { workflowRunResource } from "@workbench/shared";

import { schema } from "../db";
import type { HubDb } from "../db";
import {
  backfillDenyForExistingWorkflowKinds,
  isRunnableKind,
  isWorkflowRunDeniedForTenant,
  seedDenyGrantForNewWorkflowKind,
  setWorkflowRunGrant,
} from "./workflow-run-gate";

// Real-Postgres (PGlite) exercise of the workflow-run enablement lifecycle over
// the actual `grant` rows and the native authz engine. The mocked unit tests
// cannot see the state machine the run gate reads back: first-publish seeds a
// deny, the owner toggle rewrites it to a durable allow/deny, and a redeploy's
// seed must leave the owner's choice alone. FK enforcement is off for seeding.

const TENANT = "ten-wf";
const MEMBER_ROLE = "rol-member";
const KIND = "brief-builder";

let client: PGlite;
let db: HubDb;

const SEEDED_TABLES = ['"grant"', "role", "workflow_run"];

async function grantRows() {
  const resource = workflowRunResource(KIND);
  return client.query<{ effect: string }>(
    `select effect from "grant" where role_id = $1 and resource = $2 and action = 'run'`,
    [MEMBER_ROLE, resource],
  );
}

async function grantRowsFor(roleId: string, kind: string) {
  return client.query<{ effect: string }>(
    `select effect from "grant" where role_id = $1 and resource = $2 and action = 'run'`,
    [roleId, workflowRunResource(kind)],
  );
}

async function insertDeployment(
  tenantId: string,
  kind: string,
  opts: { deploymentId?: string | null; deletedAt?: string | null } = {},
) {
  const deploymentId =
    opts.deploymentId === undefined ? `ses-${kind}` : opts.deploymentId;
  await client.query(
    `insert into workflow_run (deployment_id, tenant_id, principal_id, kind, status, deleted_at)
     values ($1, $2, 'usr-x', $3, 'deployed', $4)`,
    [deploymentId, tenantId, kind, opts.deletedAt ?? null],
  );
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
  for (const table of SEEDED_TABLES) {
    await client.exec(`DELETE FROM ${table};`);
  }
  await client.query(
    `insert into role (id, tenant_id, name, is_system) values ($1, $2, 'member', true)`,
    [MEMBER_ROLE, TENANT],
  );
});

describe("workflow-run enablement lifecycle", () => {
  test("first publish seeds a single deny that disables the kind", async () => {
    await seedDenyGrantForNewWorkflowKind(db, TENANT, KIND);
    const rows = await grantRows();
    expect(rows.rows.map((r) => r.effect)).toEqual(["deny"]);
    expect(await isWorkflowRunDeniedForTenant(db, [TENANT], KIND)).toBe(true);
  });

  test("a redeploy's seed does not duplicate the deny row", async () => {
    await seedDenyGrantForNewWorkflowKind(db, TENANT, KIND);
    await seedDenyGrantForNewWorkflowKind(db, TENANT, KIND);
    const rows = await grantRows();
    expect(rows.rows.map((r) => r.effect)).toEqual(["deny"]);
  });

  test("enabling writes a durable allow that the redeploy seed leaves intact", async () => {
    // First publish -> disabled.
    await seedDenyGrantForNewWorkflowKind(db, TENANT, KIND);

    // Owner enables -> a single allow row, no lingering deny, kind runnable.
    await setWorkflowRunGrant(db, {
      tenantId: TENANT,
      roleId: MEMBER_ROLE,
      kind: KIND,
      enabled: true,
    });
    expect((await grantRows()).rows.map((r) => r.effect)).toEqual(["allow"]);
    expect(await isWorkflowRunDeniedForTenant(db, [TENANT], KIND)).toBe(false);

    // Redeploy re-runs the seed. The allow row is a decided state, so the kind
    // stays enabled — the bug was the seed re-disabling an owner-enabled kind.
    await seedDenyGrantForNewWorkflowKind(db, TENANT, KIND);
    expect((await grantRows()).rows.map((r) => r.effect)).toEqual(["allow"]);
    expect(await isWorkflowRunDeniedForTenant(db, [TENANT], KIND)).toBe(false);
  });

  test("disabling writes a single deny row", async () => {
    await setWorkflowRunGrant(db, {
      tenantId: TENANT,
      roleId: MEMBER_ROLE,
      kind: KIND,
      enabled: false,
    });
    expect((await grantRows()).rows.map((r) => r.effect)).toEqual(["deny"]);
    expect(await isWorkflowRunDeniedForTenant(db, [TENANT], KIND)).toBe(true);
  });

  test("toggling enable then disable never leaves more than one row", async () => {
    await seedDenyGrantForNewWorkflowKind(db, TENANT, KIND);
    await setWorkflowRunGrant(db, {
      tenantId: TENANT,
      roleId: MEMBER_ROLE,
      kind: KIND,
      enabled: true,
    });
    await setWorkflowRunGrant(db, {
      tenantId: TENANT,
      roleId: MEMBER_ROLE,
      kind: KIND,
      enabled: false,
    });
    expect((await grantRows()).rows.map((r) => r.effect)).toEqual(["deny"]);
  });
});

describe("isRunnableKind", () => {
  test("true for a deployed, not-denied kind; false once disabled", async () => {
    await insertDeployment(TENANT, KIND);
    expect(await isRunnableKind(db, TENANT, KIND)).toBe(true);

    await setWorkflowRunGrant(db, {
      tenantId: TENANT,
      roleId: MEMBER_ROLE,
      kind: KIND,
      enabled: false,
    });
    expect(await isRunnableKind(db, TENANT, KIND)).toBe(false);
  });

  test("false for a kind with no active deployment", async () => {
    expect(await isRunnableKind(db, TENANT, "never-deployed")).toBe(false);
  });
});

describe("deny-by-default catalog backfill", () => {
  test("a published kind with no grant row is denied after backfill", async () => {
    await insertDeployment(TENANT, KIND);

    await backfillDenyForExistingWorkflowKinds(db);

    expect((await grantRows()).rows.map((r) => r.effect)).toEqual(["deny"]);
    expect(await isWorkflowRunDeniedForTenant(db, [TENANT], KIND)).toBe(true);
  });

  test("an owner-enabled kind (existing allow) is left enabled", async () => {
    await insertDeployment(TENANT, KIND);
    await setWorkflowRunGrant(db, {
      tenantId: TENANT,
      roleId: MEMBER_ROLE,
      kind: KIND,
      enabled: true,
    });

    await backfillDenyForExistingWorkflowKinds(db);

    expect((await grantRows()).rows.map((r) => r.effect)).toEqual(["allow"]);
    expect(await isWorkflowRunDeniedForTenant(db, [TENANT], KIND)).toBe(false);
  });

  test("a kind with an existing deny is unchanged", async () => {
    await insertDeployment(TENANT, KIND);
    await setWorkflowRunGrant(db, {
      tenantId: TENANT,
      roleId: MEMBER_ROLE,
      kind: KIND,
      enabled: false,
    });

    await backfillDenyForExistingWorkflowKinds(db);

    expect((await grantRows()).rows.map((r) => r.effect)).toEqual(["deny"]);
  });

  test("re-running the backfill seeds no duplicate rows", async () => {
    await insertDeployment(TENANT, KIND);

    await backfillDenyForExistingWorkflowKinds(db);
    await backfillDenyForExistingWorkflowKinds(db);

    expect((await grantRows()).rows.map((r) => r.effect)).toEqual(["deny"]);
  });

  test("a soft-deleted deployment is not backfilled", async () => {
    await insertDeployment(TENANT, KIND, {
      deletedAt: new Date().toISOString(),
    });

    await backfillDenyForExistingWorkflowKinds(db);

    expect((await grantRows()).rows).toEqual([]);
  });

  test("backfills every published kind across tenants with a member role", async () => {
    const OTHER_TENANT = "ten-other";
    const OTHER_ROLE = "rol-other";
    const OTHER_KIND = "digest-builder";
    await client.query(
      `insert into role (id, tenant_id, name, is_system) values ($1, $2, 'member', true)`,
      [OTHER_ROLE, OTHER_TENANT],
    );
    await insertDeployment(TENANT, KIND);
    await insertDeployment(OTHER_TENANT, OTHER_KIND);

    await backfillDenyForExistingWorkflowKinds(db);

    expect((await grantRows()).rows.map((r) => r.effect)).toEqual(["deny"]);
    expect(
      (await grantRowsFor(OTHER_ROLE, OTHER_KIND)).rows.map((r) => r.effect),
    ).toEqual(["deny"]);
  });
});
