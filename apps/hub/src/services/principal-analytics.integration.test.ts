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
import { getPrincipalAnalytics } from "./principal-analytics";

// Real-Postgres (PGlite) exercise of the Tools + Cost aggregation across its
// seams: the analytics_event fact table, the turn_part name-recovery join, and
// the principal attribution set. FK enforcement is disabled for seeding so each
// test plants only the rows it needs.

const TENANT = "tn-analytics";
const OTHER_TENANT = "tn-other";
const PRINCIPAL = "prn-target";
const OTHER_PRINCIPAL = "prn-other";
const SESSION = "ses-1";

let client: PGlite;
let db: HubDb;

async function seedToolCall(args: {
  id: string;
  callId: string;
  tenantId?: string;
  principalId?: string;
  sessionId?: string;
  status?: string;
}): Promise<void> {
  await client.query(
    `insert into analytics_event
       (id, tenant_id, principal_id, session_id, tool_call_id, event_key, event_type, status, occurred_at)
     values ($1,$2,$3,$4,$5,$1,'tool_call',$6, now())`,
    [
      args.id,
      args.tenantId ?? TENANT,
      args.principalId ?? PRINCIPAL,
      args.sessionId ?? SESSION,
      args.callId,
      args.status ?? "completed",
    ],
  );
}

async function seedInference(args: {
  id: string;
  tenantId?: string;
  principalId?: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  thinking?: number;
}): Promise<void> {
  await client.query(
    `insert into analytics_event
       (id, tenant_id, principal_id, session_id, event_key, event_type, status,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, occurred_at)
     values ($1,$2,$3,$4,$1,'inference_done','completed',$5,$6,$7,$8,$9, now())`,
    [
      args.id,
      args.tenantId ?? TENANT,
      args.principalId ?? PRINCIPAL,
      SESSION,
      args.input,
      args.output,
      args.cacheRead ?? 0,
      args.cacheWrite ?? 0,
      args.thinking ?? 0,
    ],
  );
}

// The `kind:'call'` tool part — carries the tool name (mirrors the collector).
async function seedToolPart(args: {
  id: string;
  callId: string;
  name: string;
  sessionId?: string;
}): Promise<void> {
  await client.query(
    `insert into turn_part (id, turn_id, session_id, type, ordinal, metadata)
     values ($1, 'turn-1', $2, 'tool', 0, $3::jsonb)`,
    [
      args.id,
      args.sessionId ?? SESSION,
      JSON.stringify({ kind: "call", callId: args.callId, name: args.name }),
    ],
  );
}

// The `kind:'result'` tool part the collector writes on tool.done — same
// callId, but NO `name`. The name-recovery join must never pick this row.
async function seedToolResultPart(args: {
  id: string;
  callId: string;
  sessionId?: string;
}): Promise<void> {
  await client.query(
    `insert into turn_part (id, turn_id, session_id, type, ordinal, metadata)
     values ($1, 'turn-1', $2, 'tool', 1, $3::jsonb)`,
    [
      args.id,
      args.sessionId ?? SESSION,
      JSON.stringify({ kind: "result", callId: args.callId, content: "ok" }),
    ],
  );
}

function analytics(principalId = PRINCIPAL) {
  return getPrincipalAnalytics({ db, tenantId: TENANT, principalId });
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
  for (const t of [
    "analytics_event",
    "turn_part",
    "member_agent_instance",
    "agent_instance",
  ]) {
    await client.exec(`DELETE FROM "${t}";`);
  }
});

describe("getPrincipalAnalytics — Tools facet", () => {
  test("aggregates tool calls by resolved name, counts errors, and orders by calls", async () => {
    await seedToolPart({
      id: "tp1",
      callId: "c1",
      name: "attio__list_objects",
    });
    await seedToolPart({
      id: "tp2",
      callId: "c2",
      name: "attio__list_objects",
    });
    await seedToolPart({ id: "tp3", callId: "c3", name: "granola__get" });
    await seedToolCall({ id: "e1", callId: "c1" });
    await seedToolCall({ id: "e2", callId: "c2", status: "error" });
    await seedToolCall({ id: "e3", callId: "c3" });

    const { tools } = await analytics();

    expect(tools).toEqual([
      { name: "attio__list_objects", calls: 2, errors: 1 },
      { name: "granola__get", calls: 1, errors: 0 },
    ]);
  });

  test("resolves the real name from the `call` part, never the nameless `result` part, and does not fan out", async () => {
    // The collector writes BOTH a `kind:'result'` part (no name) and a
    // `kind:'call'` part (with name) under the same callId. The join must pick
    // the named row (not degrade to the callId) AND count the fact row once.
    await seedToolResultPart({ id: "tp_result", callId: "c1" });
    await seedToolPart({
      id: "tp_call",
      callId: "c1",
      name: "attio__list_objects",
    });
    await seedToolCall({ id: "e1", callId: "c1" });

    const { tools } = await analytics();

    expect(tools).toEqual([
      { name: "attio__list_objects", calls: 1, errors: 0 },
    ]);
  });

  test("falls back to the callId when no turn_part name survives", async () => {
    await seedToolCall({ id: "e1", callId: "reaped-call-1" });

    const { tools } = await analytics();

    expect(tools).toEqual([{ name: "reaped-call-1", calls: 1, errors: 0 }]);
  });

  test("excludes other tenants and other principals", async () => {
    await seedToolPart({ id: "tp1", callId: "c1", name: "mine" });
    await seedToolCall({ id: "e1", callId: "c1" });
    await seedToolCall({ id: "e2", callId: "c2", tenantId: OTHER_TENANT });
    await seedToolCall({
      id: "e3",
      callId: "c3",
      principalId: OTHER_PRINCIPAL,
    });

    const { tools } = await analytics();

    expect(tools).toEqual([{ name: "mine", calls: 1, errors: 0 }]);
  });

  test("attributes tool calls recorded under an owned instance's synthetic principal", async () => {
    const SYNTH = "prn-synth";
    await client.query(
      `insert into agent_instance (id, agent_id, tenant_id, principal_id, address, status)
       values ('ins-1','agt-x',$1,$2,'ins-1@wb.local','running')`,
      [TENANT, SYNTH],
    );
    await client.query(
      `insert into member_agent_instance (id, tenant_id, member_principal_id, template_key, agent_id, instance_id)
       values ('link-1',$1,$2,'myra','agt-x','ins-1')`,
      [TENANT, PRINCIPAL],
    );
    await seedToolPart({ id: "tp1", callId: "c1", name: "owned_tool" });
    await seedToolCall({ id: "e1", callId: "c1", principalId: SYNTH });

    const { tools } = await analytics();

    expect(tools).toEqual([{ name: "owned_tool", calls: 1, errors: 0 }]);
  });
});

describe("getPrincipalAnalytics — Cost facet", () => {
  test("sums token classes over inference_done and counts tool calls", async () => {
    await seedInference({
      id: "i1",
      input: 1000,
      output: 200,
      cacheRead: 50,
      cacheWrite: 10,
      thinking: 5,
    });
    await seedInference({ id: "i2", input: 500, output: 100 });
    await seedToolCall({ id: "e1", callId: "c1" });
    await seedToolCall({ id: "e2", callId: "c2" });

    const { cost } = await analytics();

    expect(cost).toEqual({
      inputTokens: 1500,
      outputTokens: 300,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      thinkingTokens: 5,
      inferenceCalls: 2,
      toolCalls: 2,
    });
  });

  test("returns zeros when the principal has no recorded facts", async () => {
    const { cost, tools } = await analytics(OTHER_PRINCIPAL);
    expect(tools).toEqual([]);
    expect(cost.inputTokens).toBe(0);
    expect(cost.inferenceCalls).toBe(0);
    expect(cost.toolCalls).toBe(0);
  });

  test("does not sum another tenant's tokens", async () => {
    await seedInference({ id: "i1", input: 100, output: 10 });
    await seedInference({
      id: "i2",
      input: 999,
      output: 999,
      tenantId: OTHER_TENANT,
    });

    const { cost } = await analytics();
    expect(cost.inputTokens).toBe(100);
    expect(cost.outputTokens).toBe(10);
  });
});
