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
import {
  deleteAutoApprovedTool,
  persistAutoApprovedTool,
} from "./auto-approved-tools";
import { persistInstanceToolGrants } from "../services/agent-provisioning";

// Real-Postgres (PGlite) exercise of the native-approvals activation seam: write
// tools mint `ask` (gate) unless the instance principal has durably
// auto-approved them (CL-3942), in which case they mint `allow` and no longer
// gate. Read tools are always `allow`.

const TENANT = "ten-na";
const PRINCIPAL = "prn-inst";

let client: PGlite;
let db: HubDb;

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
  await client.exec(`DELETE FROM "auto_approved_tool";`);
});

describe("resolveAskToolNamesForTenant", () => {
  test("no auto-approvals: returns the full approval-gated write set", async () => {
    const names = await resolveAskToolNamesForTenant(db, TENANT, PRINCIPAL);
    expect(names).toEqual(APPROVAL_GATED_TOOL_NAMES);
    expect(names.has(WRITE_TOOL_LLM)).toBe(true);
  });

  test("read tools are never in the ask set", async () => {
    const names = await resolveAskToolNamesForTenant(db, TENANT, PRINCIPAL);
    expect(names.has(READ_TOOL)).toBe(false);
  });

  test("an auto-approved tool is excluded from the ask set", async () => {
    await persistAutoApprovedTool(db, {
      tenantId: TENANT,
      principalId: PRINCIPAL,
      toolName: WRITE_TOOL_LLM,
      createdByPrincipalId: "prn-member",
    });
    const names = await resolveAskToolNamesForTenant(db, TENANT, PRINCIPAL);
    expect(names.has(WRITE_TOOL_LLM)).toBe(false);
    // Other gated tools remain gated.
    expect(names.size).toBe(APPROVAL_GATED_TOOL_NAMES.size - 1);
  });

  test("auto-approval is scoped to its principal", async () => {
    await persistAutoApprovedTool(db, {
      tenantId: TENANT,
      principalId: "prn-other",
      toolName: WRITE_TOOL_LLM,
      createdByPrincipalId: "prn-member",
    });
    const names = await resolveAskToolNamesForTenant(db, TENANT, PRINCIPAL);
    expect(names.has(WRITE_TOOL_LLM)).toBe(true);
  });
});

describe("persistInstanceToolGrants with auto-approve", () => {
  const now = new Date("2026-07-19T00:00:00.000Z");

  test("write tool gates by default, read tool is allow", async () => {
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

  test("an auto-approved write tool mints allow on the next mint", async () => {
    await persistAutoApprovedTool(db, {
      tenantId: TENANT,
      principalId: PRINCIPAL,
      toolName: WRITE_TOOL_LLM,
      createdByPrincipalId: "prn-member",
    });
    await persistInstanceToolGrants(db as never, {
      tenantId: TENANT,
      principalId: PRINCIPAL,
      toolNames: [WRITE_TOOL, READ_TOOL],
      now,
    });
    const effects = await grantEffects();
    expect(effects.get(`tool:${WRITE_TOOL_LLM}`)).toBe("allow");
  });

  test("auto-approval is durable across a re-mint (relaunch)", async () => {
    await persistAutoApprovedTool(db, {
      tenantId: TENANT,
      principalId: PRINCIPAL,
      toolName: WRITE_TOOL_LLM,
      createdByPrincipalId: "prn-member",
    });
    await persistInstanceToolGrants(db as never, {
      tenantId: TENANT,
      principalId: PRINCIPAL,
      toolNames: [WRITE_TOOL],
      now,
    });
    // A second mint (a relaunch/reconcile) still sees the durable record.
    await persistInstanceToolGrants(db as never, {
      tenantId: TENANT,
      principalId: PRINCIPAL,
      toolNames: [WRITE_TOOL],
      now,
    });
    const effects = await grantEffects();
    expect(effects.get(`tool:${WRITE_TOOL_LLM}`)).toBe("allow");
  });

  test("revoking the auto-approval returns the tool to the ask set", async () => {
    await persistAutoApprovedTool(db, {
      tenantId: TENANT,
      principalId: PRINCIPAL,
      toolName: WRITE_TOOL_LLM,
      createdByPrincipalId: "prn-member",
    });
    const removed = await deleteAutoApprovedTool(db, {
      tenantId: TENANT,
      id: (await db.query.autoApprovedTool.findFirst())!.id,
      memberPrincipalId: "prn-member",
    });
    expect(removed).toEqual({
      principalId: PRINCIPAL,
      toolName: WRITE_TOOL_LLM,
    });
    const names = await resolveAskToolNamesForTenant(db, TENANT, PRINCIPAL);
    expect(names.has(WRITE_TOOL_LLM)).toBe(true);

    await persistInstanceToolGrants(db as never, {
      tenantId: TENANT,
      principalId: PRINCIPAL,
      toolNames: [WRITE_TOOL],
      now,
    });
    const effects = await grantEffects();
    expect(effects.get(`tool:${WRITE_TOOL_LLM}`)).toBe("ask");
  });
});
