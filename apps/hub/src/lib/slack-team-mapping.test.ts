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
import { schema } from "../db";
import type { HubDb } from "../db";
import {
  resolveTenantForSlackTeam,
  upsertSlackTeamMapping,
} from "./slack-team-mapping";

let client: PGlite;
let db: HubDb;

beforeAll(async () => {
  client = new PGlite();
  const bootstrap = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, bootstrap as never);
  await apply();
  db = bootstrap as unknown as HubDb;
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.exec(`DELETE FROM slack_team_tenant_mapping;`);
});

describe("resolveTenantForSlackTeam", () => {
  test("returns null for an unmapped team", async () => {
    expect(await resolveTenantForSlackTeam(db, "T-UNKNOWN")).toBeNull();
  });

  test("returns the mapped tenant", async () => {
    await upsertSlackTeamMapping(db, "ten-a", "T-A");
    expect(await resolveTenantForSlackTeam(db, "T-A")).toBe("ten-a");
  });
});

describe("upsertSlackTeamMapping", () => {
  test("two tenants with distinct team ids resolve independently", async () => {
    await upsertSlackTeamMapping(db, "ten-a", "T-A");
    await upsertSlackTeamMapping(db, "ten-b", "T-B");
    expect(await resolveTenantForSlackTeam(db, "T-A")).toBe("ten-a");
    expect(await resolveTenantForSlackTeam(db, "T-B")).toBe("ten-b");
  });

  test("re-enabling the same team for a different tenant reassigns it (last writer wins)", async () => {
    await upsertSlackTeamMapping(db, "ten-a", "T-A");
    await upsertSlackTeamMapping(db, "ten-c", "T-A");
    expect(await resolveTenantForSlackTeam(db, "T-A")).toBe("ten-c");

    const rows = await client.query<{ count: string }>(
      `select count(*)::text as count from slack_team_tenant_mapping where slack_team_id = 'T-A'`,
    );
    expect(rows.rows[0]?.count).toBe("1");
  });
});
