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
import { getRunStepLiveIssue } from "./run-step-live-issue";

const TENANT = "tn-live-issue";
let client: PGlite;
let db: HubDb;
let seq = 0;

async function instance(id: string, address: string) {
  await client.query(
    `insert into agent_instance (id, agent_id, tenant_id, principal_id, address, status)
     values ($1,'agt-x',$2,'prn-def',$3,'running')`,
    [id, TENANT, address],
  );
}

async function inferenceError(args: {
  instanceId: string;
  category: string;
  message: string;
  occurredAt: string;
}) {
  seq += 1;
  await client.query(
    `insert into analytics_event (id, tenant_id, instance_id, session_id, event_key, event_type, status, metadata, occurred_at)
     values ($1,$2,$3,'ses-x',$1,'inference_error','error',$4,$5)`,
    [
      `evt-${seq}`,
      TENANT,
      args.instanceId,
      JSON.stringify({ category: args.category, message: args.message }),
      args.occurredAt,
    ],
  );
}

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
  seq = 0;
  for (const t of ["agent_instance", "analytics_event"]) {
    await client.exec(`DELETE FROM "${t}";`);
  }
});

describe("getRunStepLiveIssue", () => {
  test("returns the latest inference_error for the step's own instance address", async () => {
    await instance("ins_dep-draft", "ins_dep-draft@wb.local");
    await inferenceError({
      instanceId: "ins_dep-draft",
      category: "timeout",
      message: "inference call exceeded inactivity timeout",
      occurredAt: "2026-07-18T00:00:01Z",
    });
    await inferenceError({
      instanceId: "ins_dep-draft",
      category: "retryable",
      message: "provider returned 503",
      occurredAt: "2026-07-18T00:00:05Z",
    });

    const issue = await getRunStepLiveIssue({
      db,
      tenantId: TENANT,
      deploymentId: "dep",
      stepId: "draft",
      since: new Date("2026-07-18T00:00:00Z"),
    });

    expect(issue).toEqual({
      category: "retryable",
      message: "provider returned 503",
      occurredAt: "2026-07-18T00:00:05.000Z",
    });
  });

  test("does not attribute another step's instance on the same deployment", async () => {
    await instance("ins_dep-draft", "ins_dep-draft@wb.local");
    await instance("ins_dep-polish", "ins_dep-polish@wb.local");
    await inferenceError({
      instanceId: "ins_dep-polish",
      category: "timeout",
      message: "inference call exceeded inactivity timeout",
      occurredAt: "2026-07-18T00:00:01Z",
    });

    const issue = await getRunStepLiveIssue({
      db,
      tenantId: TENANT,
      deploymentId: "dep",
      stepId: "draft",
      since: new Date("2026-07-18T00:00:00Z"),
    });
    expect(issue).toBeNull();
  });

  test("ignores an error that occurred before the step's own start", async () => {
    await instance("ins_dep-draft", "ins_dep-draft@wb.local");
    await inferenceError({
      instanceId: "ins_dep-draft",
      category: "timeout",
      message: "stale timeout from an earlier attempt",
      occurredAt: "2026-07-18T00:00:01Z",
    });

    const issue = await getRunStepLiveIssue({
      db,
      tenantId: TENANT,
      deploymentId: "dep",
      stepId: "draft",
      since: new Date("2026-07-18T00:05:00Z"),
    });
    expect(issue).toBeNull();
  });

  test("returns null when no instance exists for that step address", async () => {
    const issue = await getRunStepLiveIssue({
      db,
      tenantId: TENANT,
      deploymentId: "dep",
      stepId: "draft",
      since: new Date("2026-07-18T00:00:00Z"),
    });
    expect(issue).toBeNull();
  });
});
