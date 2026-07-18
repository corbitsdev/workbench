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
import { getRunStepLiveIssues } from "./run-step-live-issue";

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

describe("getRunStepLiveIssues", () => {
  test("returns the latest inference_error for the step's own instance address, without the raw message", async () => {
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

    const issues = await getRunStepLiveIssues({
      db,
      tenantId: TENANT,
      deploymentId: "dep",
      runId: "run-1",
      steps: [
        {
          stepId: "draft",
          attempt: 1,
          since: new Date("2026-07-18T00:00:00Z"),
        },
      ],
    });

    const issue = issues.get("draft");
    expect(issue).toEqual({
      category: "retryable",
      occurredAt: "2026-07-18T00:00:05.000Z",
    });
    expect(issue).not.toHaveProperty("message");
  });

  test("resolves multiple in-flight steps in a single batched call, each honoring its own since", async () => {
    await instance("ins_dep-draft", "ins_dep-draft@wb.local");
    await instance("ins_dep-polish", "ins_dep-polish@wb.local");
    await inferenceError({
      instanceId: "ins_dep-draft",
      category: "timeout",
      message: "inference call exceeded inactivity timeout",
      occurredAt: "2026-07-18T00:00:01Z",
    });
    await inferenceError({
      instanceId: "ins_dep-polish",
      category: "rate_limited",
      message: "provider rate limited",
      occurredAt: "2026-07-18T00:00:02Z",
    });

    const issues = await getRunStepLiveIssues({
      db,
      tenantId: TENANT,
      deploymentId: "dep",
      runId: "run-2",
      steps: [
        {
          stepId: "draft",
          attempt: 1,
          since: new Date("2026-07-18T00:00:00Z"),
        },
        {
          // This step's own start is AFTER the polish error, so it must not
          // pick up an issue that predates it, even though the batched query
          // reads both addresses in one pass.
          stepId: "polish",
          attempt: 1,
          since: new Date("2026-07-18T00:00:05Z"),
        },
      ],
    });

    expect(issues.get("draft")).toEqual({
      category: "timeout",
      occurredAt: "2026-07-18T00:00:01.000Z",
    });
    expect(issues.has("polish")).toBe(false);
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

    const issues = await getRunStepLiveIssues({
      db,
      tenantId: TENANT,
      deploymentId: "dep",
      runId: "run-3",
      steps: [
        {
          stepId: "draft",
          attempt: 1,
          since: new Date("2026-07-18T00:00:00Z"),
        },
      ],
    });
    expect(issues.has("draft")).toBe(false);
  });

  test("ignores an error that occurred before the step's own start", async () => {
    await instance("ins_dep-draft", "ins_dep-draft@wb.local");
    await inferenceError({
      instanceId: "ins_dep-draft",
      category: "timeout",
      message: "stale timeout from an earlier attempt",
      occurredAt: "2026-07-18T00:00:01Z",
    });

    const issues = await getRunStepLiveIssues({
      db,
      tenantId: TENANT,
      deploymentId: "dep",
      runId: "run-4",
      steps: [
        {
          stepId: "draft",
          attempt: 1,
          since: new Date("2026-07-18T00:05:00Z"),
        },
      ],
    });
    expect(issues.has("draft")).toBe(false);
  });

  test("returns an empty map when no instance exists for that step address", async () => {
    const issues = await getRunStepLiveIssues({
      db,
      tenantId: TENANT,
      deploymentId: "dep",
      runId: "run-5",
      steps: [
        {
          stepId: "draft",
          attempt: 1,
          since: new Date("2026-07-18T00:00:00Z"),
        },
      ],
    });
    expect(issues.size).toBe(0);
  });

  test("memoizes repeated calls with the same run/step/attempt signature", async () => {
    await instance("ins_dep-draft", "ins_dep-draft@wb.local");
    await inferenceError({
      instanceId: "ins_dep-draft",
      category: "timeout",
      message: "inference call exceeded inactivity timeout",
      occurredAt: "2026-07-18T00:00:01Z",
    });

    const queryArgs = {
      db,
      tenantId: TENANT,
      deploymentId: "dep",
      runId: "run-memo",
      steps: [
        {
          stepId: "draft",
          attempt: 1,
          since: new Date("2026-07-18T00:00:00Z"),
        },
      ],
    };
    const first = await getRunStepLiveIssues(queryArgs);
    expect(first.get("draft")).toEqual({
      category: "timeout",
      occurredAt: "2026-07-18T00:00:01.000Z",
    });

    // A new inference_error lands after the first read; a memoized read within
    // the TTL window must still serve the earlier snapshot rather than
    // re-scanning the unindexed table on every SSE delta.
    await inferenceError({
      instanceId: "ins_dep-draft",
      category: "credential_failure",
      message: "credential invalid",
      occurredAt: "2026-07-18T00:00:02Z",
    });
    const second = await getRunStepLiveIssues(queryArgs);
    expect(second.get("draft")).toEqual({
      category: "timeout",
      occurredAt: "2026-07-18T00:00:01.000Z",
    });

    // A bumped attempt changes the cache key, so a retried step's issue is
    // never served stale from the previous attempt's cached entry.
    const bumped = await getRunStepLiveIssues({
      ...queryArgs,
      steps: [
        {
          stepId: "draft",
          attempt: 2,
          since: new Date("2026-07-18T00:00:00Z"),
        },
      ],
    });
    expect(bumped.get("draft")).toEqual({
      category: "credential_failure",
      occurredAt: "2026-07-18T00:00:02.000Z",
    });
  });
});
