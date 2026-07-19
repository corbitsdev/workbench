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
import { APPROVAL_GATED_TOOL_NAMES } from "@workbench/agents";

// `resolveAskToolNamesForTenant` reads the memoized feature check plus the staff
// env override, both via `getConfig()`. The env override is OFF here so this
// suite exercises the admin-grant enable path (the seeded member-role grant).
mock.module("../config", () => ({
  getConfig: () => ({
    featureGrantCacheTtlMs: 30_000,
    nativeApprovalsEnabled: false,
  }),
}));

import { schema } from "../db";
import type { HubDb } from "../db";
import { setFeatureGrant, resetFeatureGrantCache } from "./feature-grants";
import { resolveAskToolNamesForTenant } from "./native-approvals";
import { persistInstanceToolGrants } from "../services/agent-provisioning";

// Real-Postgres (PGlite) exercise of the native-approvals activation seam: the
// `native-approvals` feature grant flips write-tool grant minting from `allow`
// to `ask`, and leaves it `allow` when off. FK enforcement is off for seeding.

const TENANT = "ten-na";
const MEMBER_ROLE = "rol-member";
const PRINCIPAL = "prn-inst";

let client: PGlite;
let db: HubDb;

const SEEDED_TABLES = ['"grant"', "role"];

// A stable write-gated tool name (Slack post) and a read tool (Exa search).
const WRITE_TOOL = "@workbench/tools-slack/slack:slack_post_message";
const WRITE_TOOL_LLM = "slack__post_message";
const READ_TOOL = "exa_search";

async function grantEffects(): Promise<Map<string, string>> {
  const rows = await client.query<{ resource: string; effect: string }>(
    `select resource, effect from "grant" where principal_id = $1 and action = 'invoke'`,
    [PRINCIPAL],
  );
  return new Map(rows.rows.map((r) => [r.resource, r.effect]));
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
  resetFeatureGrantCache();
  for (const table of SEEDED_TABLES) {
    await client.exec(`DELETE FROM ${table};`);
  }
  await client.query(
    `insert into role (id, tenant_id, name, is_system) values ($1, $2, 'member', true)`,
    [MEMBER_ROLE, TENANT],
  );
});

describe("resolveAskToolNamesForTenant", () => {
  test("empty when native-approvals is off (default)", async () => {
    const names = await resolveAskToolNamesForTenant(db, TENANT);
    expect(names.size).toBe(0);
  });

  test("the approval-gated write set when native-approvals is on", async () => {
    await setFeatureGrant(db, {
      tenantId: TENANT,
      roleId: MEMBER_ROLE,
      name: "native-approvals",
      enabled: true,
    });
    const names = await resolveAskToolNamesForTenant(db, TENANT);
    expect(names).toEqual(APPROVAL_GATED_TOOL_NAMES);
    expect(names.has(WRITE_TOOL_LLM)).toBe(true);
  });
});

describe("persistInstanceToolGrants native-approvals activation", () => {
  const now = new Date("2026-07-18T00:00:00.000Z");

  test("feature off: every tool grant is allow", async () => {
    await persistInstanceToolGrants(db as never, {
      tenantId: TENANT,
      principalId: PRINCIPAL,
      toolNames: [WRITE_TOOL, READ_TOOL],
      now,
    });
    const effects = await grantEffects();
    expect(effects.get(`tool:${WRITE_TOOL_LLM}`)).toBe("allow");
    expect(effects.get(`tool:${READ_TOOL}`)).toBe("allow");
  });

  test("feature on: write tool grant is ask, read tool grant is allow", async () => {
    await setFeatureGrant(db, {
      tenantId: TENANT,
      roleId: MEMBER_ROLE,
      name: "native-approvals",
      enabled: true,
    });
    resetFeatureGrantCache();
    await persistInstanceToolGrants(db as never, {
      tenantId: TENANT,
      principalId: PRINCIPAL,
      toolNames: [WRITE_TOOL, READ_TOOL],
      now,
    });
    const effects = await grantEffects();
    expect(effects.get(`tool:${WRITE_TOOL_LLM}`)).toBe("ask");
    expect(effects.get(`tool:${READ_TOOL}`)).toBe("allow");
  });
});
