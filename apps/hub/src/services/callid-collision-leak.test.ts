import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";

import { schema } from "../db";
import type { HubDb } from "../db";
import { getMomentDetail } from "./moment-detail";

// CL-2738 leak guard: callId is provider-assigned and NOT globally unique (a
// local model can emit "call_1"). If the turn_part join in
// buildToolCallDetailQuery were scoped on callId ALONE (no session predicate),
// an attacker's tool_call analytics_event with a colliding callId would surface
// a VICTIM's tool input/output across sessions/principals/tenants. The join is
// scoped to the anchor event's session_id, which closes the leak.

const TENANT = "tn-leak";
const VICTIM = "prn-victim";
const ATTACKER = "prn-attacker";

let client: PGlite;
let db: HubDb;

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
  for (const t of ["agent_session", "turn_part", "analytics_event"]) {
    await client.exec(`DELETE FROM "${t}";`);
  }
});

test("attacker's tool_call event cannot read a VICTIM's turn_part on a colliding callId", async () => {
  const COLLIDING_CALL_ID = "call_1"; // realistic for sequential provider ids

  // VICTIM's session holds the sensitive tool arguments/results.
  await client.query(
    `insert into agent_session (id, tenant_id, agent_id, principal_id, status, created_at, updated_at)
     values ('ses-victim', $1, 'agt', $2, 'active', now(), now())`,
    [TENANT, VICTIM],
  );
  await client.query(
    `insert into turn_part (id, turn_id, session_id, type, ordinal, metadata)
     values ('tp-v-call', 'turn-v', 'ses-victim', 'tool', 0, $1::jsonb)`,
    [
      JSON.stringify({
        kind: "call",
        callId: COLLIDING_CALL_ID,
        name: "read_secret",
        arguments: { ssn: "VICTIM-SECRET-123" },
      }),
    ],
  );
  await client.query(
    `insert into turn_part (id, turn_id, session_id, type, ordinal, metadata)
     values ('tp-v-res', 'turn-v', 'ses-victim', 'tool', 1, $1::jsonb)`,
    [
      JSON.stringify({
        kind: "result",
        callId: COLLIDING_CALL_ID,
        content: "VICTIM CONFIDENTIAL OUTPUT",
        isError: false,
      }),
    ],
  );

  // ATTACKER owns a tool_call analytics_event whose tool_call_id collides, in
  // their OWN session, with NO turn_part of their own.
  await client.query(
    `insert into agent_session (id, tenant_id, agent_id, principal_id, status, created_at, updated_at)
     values ('ses-attacker', $1, 'agt', $2, 'active', now(), now())`,
    [TENANT, ATTACKER],
  );
  await client.query(
    `insert into analytics_event (id, tenant_id, principal_id, session_id, event_key, event_type, tool_call_id, occurred_at)
     values ('evt-attacker', $1, $2, 'ses-attacker', 'evt-attacker', 'tool_call', $3, now())`,
    [TENANT, ATTACKER, COLLIDING_CALL_ID],
  );

  const asAttacker = await getMomentDetail({
    db,
    tenantId: TENANT,
    principalId: ATTACKER,
    kind: "tool_call",
    id: "evt-attacker",
  });

  // Scoping is airtight: attacker sees nulls (no part of their own session),
  // never the victim's input/output.
  expect(asAttacker?.toolCall?.input).toBeNull();
  expect(asAttacker?.toolCall?.output).toBeNull();
});
