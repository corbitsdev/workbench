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
import { APPROVAL_GATED_TOOL_NAMES } from "@workbench/agents";

import { schema } from "../db";
import type { HubDb } from "../db";
import { resolveAskToolNamesForTenant } from "./native-approvals";
import { persistInstanceToolGrants } from "../services/agent-provisioning";

// Real-Postgres (PGlite) exercise of the native-approvals activation seam
// (CL-3940): write-tool grant minting is `ask` UNCONDITIONALLY (no owner
// toggle, no env flag), while read tools stay `allow`. `sideEffect: "write"`
// drives it via `APPROVAL_GATED_TOOL_NAMES`.

const TENANT = "ten-na";
const PRINCIPAL = "prn-inst";

let client: PGlite;
let db: HubDb;

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
  await client.exec(`DELETE FROM "grant";`);
});

describe("resolveAskToolNamesForTenant", () => {
  test("always the approval-gated write set (write tool present)", async () => {
    const names = await resolveAskToolNamesForTenant();
    expect(names).toEqual(APPROVAL_GATED_TOOL_NAMES);
    expect(names.has(WRITE_TOOL_LLM)).toBe(true);
  });

  test("read tools are never in the ask set", async () => {
    const names = await resolveAskToolNamesForTenant();
    expect(names.has(READ_TOOL)).toBe(false);
  });
});

describe("persistInstanceToolGrants unconditional gating", () => {
  const now = new Date("2026-07-19T00:00:00.000Z");

  test("write tool grant is ask, read tool grant is allow — no feature grant needed", async () => {
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
