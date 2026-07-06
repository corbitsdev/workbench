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
import type { InferenceEvent } from "@intx/types/runtime";
import { createAnalyticsSubscriber } from "@workbench/analytics";

import { schema } from "../db";
import type { HubDb } from "../db";
import { getUsageByPerson } from "./activity-overview";

// Real-seam coverage for CL-2801: a hub-side, in-process file-parse turn feeds
// its inference events into the analytics subscriber, which must land a real
// analytics_event row attributed to the CALLER's instance/principal and roll
// up to the right person — exactly the path parseDocument now drives.

const TENANT = "tnt-fp";
const CALLER_PRINCIPAL = "prn-caller";
const CALLER_INSTANCE = "ins-caller";
const MEMBER = "prn-member";

let client: PGlite;
let db: HubDb;

const fileParseDone: InferenceEvent = {
  type: "inference.done",
  seq: 7,
  data: {
    turn: {
      role: "assistant",
      content: [],
      model: "claude-sonnet-5",
      timestamp: 0,
    },
    usage: {
      input: 900,
      output: 210,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    },
    source: {
      sourceId: "off_1",
      provider: "anthropic",
      model: "claude-sonnet-5",
    },
  },
};

beforeAll(async () => {
  client = new PGlite();
  const b = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, b as never);
  await apply();
  await client.exec(`SET session_replication_role = 'replica';`);
  db = b as unknown as HubDb;
});
afterAll(async () => await client?.close());
beforeEach(async () => {
  for (const t of [
    "member_agent_instance",
    "agent_instance",
    "analytics_event",
    "analytics_rollup_daily",
  ])
    await client.exec(`DELETE FROM "${t}";`);

  // The caller: an active Myra instance with a member_agent_instance mapping to
  // the human, and a live session (persistFact requires a sessionId).
  await client.query(
    `insert into agent_instance (id, agent_id, tenant_id, principal_id, address, status, session_id)
     values ($1,'agt-myra',$2,$3,'ins-caller@wb.local','running','ses-caller')`,
    [CALLER_INSTANCE, TENANT, CALLER_PRINCIPAL],
  );
  await client.query(
    `insert into member_agent_instance (id, tenant_id, member_principal_id, template_key, agent_id, instance_id)
     values ('map-1',$1,$2,'myra','agt-myra',$3)`,
    [TENANT, MEMBER, CALLER_INSTANCE],
  );
});

describe("CL-2801 file-parse analytics (real DB)", () => {
  test("onLocalInferenceEvent writes a real analytics_event row attributed to the caller", async () => {
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onLocalInferenceEvent({
      tenantId: TENANT,
      attributionPrincipalId: CALLER_PRINCIPAL,
      eventAddress: "file-parser-real",
      event: fileParseDone,
    });

    const rows = await client.query<{
      instance_id: string;
      principal_id: string;
      agent_id: string;
      input_tokens: number;
      output_tokens: number;
      event_type: string;
      event_key: string;
    }>(`select * from analytics_event`);

    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0]!;
    expect(row.instance_id).toBe(CALLER_INSTANCE);
    expect(row.principal_id).toBe(CALLER_PRINCIPAL);
    expect(row.agent_id).toBe("agt-myra");
    expect(row.event_type).toBe("inference_done");
    expect(Number(row.input_tokens)).toBe(900);
    expect(Number(row.output_tokens)).toBe(210);
    // Keyed by the one-shot's own address under the caller's session prefix.
    expect(row.event_key).toBe("ses-caller:file-parser-real:7:inference.done");
  });

  test("file-parse tokens roll up to the caller's person via getUsageByPerson", async () => {
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onLocalInferenceEvent({
      tenantId: TENANT,
      attributionPrincipalId: CALLER_PRINCIPAL,
      eventAddress: "file-parser-real",
      event: fileParseDone,
    });

    const usage = await getUsageByPerson({
      db,
      tenantId: TENANT,
      callerPrincipalId: null,
    });

    const member = usage.find((u) => u.principalId === MEMBER);
    expect(member).toBeDefined();
    expect(member!.inputTokens).toBe(900);
    expect(member!.outputTokens).toBe(210);
  });

  test("duplicate delivery of the same event is idempotent (no double-count)", async () => {
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    for (let i = 0; i < 2; i++)
      await subscriber.onLocalInferenceEvent({
        tenantId: TENANT,
        attributionPrincipalId: CALLER_PRINCIPAL,
        eventAddress: "file-parser-real",
        event: fileParseDone,
      });

    const usage = await getUsageByPerson({
      db,
      tenantId: TENANT,
      callerPrincipalId: null,
    });
    const member = usage.find((u) => u.principalId === MEMBER);
    expect(member!.inputTokens).toBe(900);
    expect(member!.outputTokens).toBe(210);
  });
});
