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
import { createGrantStore } from "@intx/db";

import { schema } from "../db";
import type { HubDb } from "../db";
import { isAdmin, isOwner } from "../lib/admin-grant";
import {
  assignRole,
  countOwners,
  demoteFromOwner,
  LastOwnerError,
  removeRole,
} from "./admin-governance";

// Real-Postgres exercise of the enforced management seam: assignRole/removeRole
// write real `principal_role` rows, and the admin gate (`isAdmin` -> native
// `createGrantStore`.collectGrants -> `authorize`) reads them back through the
// role -> grant expansion. This is the end-to-end that the mocked router test
// cannot cover. FK enforcement is disabled for seeding.

const TENANT = "ten-admin";
const ADMIN_ROLE = "rol-admin";
const USER_PRINCIPAL = "prn-user";

let client: PGlite;
let db: HubDb;

const SEEDED_TABLES = ['"grant"', "principal_role", "role", "principal"];

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
  // The `admin` system role and its wildcard grant (what tenant seeding plants).
  await client.query(
    `insert into role (id, tenant_id, name, is_system) values ($1, $2, 'admin', true)`,
    [ADMIN_ROLE, TENANT],
  );
  await client.query(
    `insert into "grant" (id, tenant_id, role_id, resource, action, effect, origin)
     values ('grt-admin', $1, $2, '*', 'manage', 'allow', 'role')`,
    [TENANT, ADMIN_ROLE],
  );
});

describe("elevate/demote over the real grant store", () => {
  test("assigning the admin role flips the gate to allow; removing it flips back to deny", async () => {
    const grantStore = createGrantStore(db);

    // Before: no role assignment -> gate denies.
    expect(await isAdmin(grantStore, USER_PRINCIPAL, TENANT)).toBe(false);

    // Elevate: writes a real principal_role row.
    await assignRole(db, TENANT, USER_PRINCIPAL, ADMIN_ROLE);
    const afterAssign = await client.query<{ count: string }>(
      `select count(*)::text as count from principal_role where principal_id = $1 and role_id = $2`,
      [USER_PRINCIPAL, ADMIN_ROLE],
    );
    expect(afterAssign.rows[0]?.count).toBe("1");

    // Gate now allows via role -> grant (*/manage) expansion.
    expect(await isAdmin(grantStore, USER_PRINCIPAL, TENANT)).toBe(true);

    // Demote: removes the assignment.
    await removeRole(db, USER_PRINCIPAL, ADMIN_ROLE);
    const afterRemove = await client.query<{ count: string }>(
      `select count(*)::text as count from principal_role where principal_id = $1 and role_id = $2`,
      [USER_PRINCIPAL, ADMIN_ROLE],
    );
    expect(afterRemove.rows[0]?.count).toBe("0");

    // Gate denies again.
    expect(await isAdmin(grantStore, USER_PRINCIPAL, TENANT)).toBe(false);
  });
});

// CL-3634: owner role delegation reuses the exact same native
// principal_role/grant mechanism — no bespoke concept — but adds the
// last-owner guardrail on top of `removeRole`.
describe("owner role delegation (CL-3634) over the real grant store", () => {
  const OWNER_ROLE = "rol-owner";
  const FIRST_OWNER = "prn-owner-1";
  const SECOND_OWNER = "prn-owner-2";

  beforeEach(async () => {
    await client.query(
      `insert into role (id, tenant_id, name, is_system) values ($1, $2, 'owner', true)`,
      [OWNER_ROLE, TENANT],
    );
    await client.query(
      `insert into "grant" (id, tenant_id, role_id, resource, action, effect, origin)
       values ('grt-owner', $1, $2, '*', '*', 'allow', 'role')`,
      [TENANT, OWNER_ROLE],
    );
    await assignRole(db, TENANT, FIRST_OWNER, OWNER_ROLE);
  });

  test("assigning the owner role flips the owner gate to allow", async () => {
    const grantStore = createGrantStore(db);
    expect(await isOwner(grantStore, SECOND_OWNER, TENANT)).toBe(false);
    await assignRole(db, TENANT, SECOND_OWNER, OWNER_ROLE);
    expect(await isOwner(grantStore, SECOND_OWNER, TENANT)).toBe(true);
  });

  test("demoteFromOwner removes the role when another owner remains", async () => {
    await assignRole(db, TENANT, SECOND_OWNER, OWNER_ROLE);
    expect(await countOwners(db, OWNER_ROLE)).toBe(2);

    await demoteFromOwner(db, TENANT, OWNER_ROLE, SECOND_OWNER);

    expect(await countOwners(db, OWNER_ROLE)).toBe(1);
    const grantStore = createGrantStore(db);
    expect(await isOwner(grantStore, SECOND_OWNER, TENANT)).toBe(false);
    expect(await isOwner(grantStore, FIRST_OWNER, TENANT)).toBe(true);
  });

  test("demoteFromOwner refuses to remove the last remaining owner", async () => {
    expect(await countOwners(db, OWNER_ROLE)).toBe(1);

    await expect(
      demoteFromOwner(db, TENANT, OWNER_ROLE, FIRST_OWNER),
    ).rejects.toBeInstanceOf(LastOwnerError);

    // The role assignment survives the refused demote.
    expect(await countOwners(db, OWNER_ROLE)).toBe(1);
    const grantStore = createGrantStore(db);
    expect(await isOwner(grantStore, FIRST_OWNER, TENANT)).toBe(true);
  });
});
