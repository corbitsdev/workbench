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

// runTrackedOneShot and the isogit scratch store are mocked at their module
// boundaries: the pipeline's own logic (dedupe, classification, artifact
// persist, fan-out hand-off) is exercised against real Postgres; the inference
// turn and filesystem store are not the unit under test.
const analysisJson = JSON.stringify({
  summary: "Discussed onboarding friction and pricing.",
  painPoints: ["Onboarding is slow"],
  decisions: ["Ship a quickstart"],
  actionItems: [
    { description: "Draft quickstart", assignee: "alice@corbits.io" },
  ],
  tasks: [{ description: "Write docs" }],
  peopleMentioned: ["Bob"],
});
let oneShotReturn = analysisJson;
mock.module("./tracked-one-shot", () => ({
  runTrackedOneShot: async () => oneShotReturn,
}));
mock.module("@workbench/storage-isogit", () => ({
  createIsogitStore: async () => ({}),
}));

const { createGranolaCallPipeline, classifyCall, GRANOLA_CALL_ARTIFACT_KIND } =
  await import("./granola-call-pipeline");
import { schema } from "../db";
import type { HubDb } from "../db";
import type { InferenceSource } from "@intx/types/runtime";
import type { FanOutInput, FanOutResult } from "./granola-call-fanout";

const TENANT = "ten-granola";
const SOURCE = {
  id: "src",
  provider: "openai-compatible",
  model: "m",
} as InferenceSource;

let client: PGlite;
let db: HubDb;

async function artifactRows() {
  return client.query<{ kind: string; title: string; source: unknown }>(
    `select kind, title, source from artifact where tenant_id = $1`,
    [TENANT],
  );
}

function makePipeline(fanCalls: FanOutInput[]) {
  return createGranolaCallPipeline({
    db,
    rootTenantDomain: "corbits.io",
    dataDir: "/tmp/granola-test",
    resolveInferenceSource: async () => SOURCE,
    fanout: {
      fanOut: async (input): Promise<FanOutResult> => {
        fanCalls.push(input);
        return { delivered: 2, unmatched: [] };
      },
    },
  });
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
  await client.exec(`DELETE FROM artifact;`);
  oneShotReturn = analysisJson;
});

describe("classifyCall", () => {
  test("all attendees on the tenant domain is internal", () => {
    expect(classifyCall(["a@corbits.io", "b@corbits.io"], "corbits.io")).toBe(
      "internal",
    );
  });
  test("any off-domain attendee is external", () => {
    expect(classifyCall(["a@corbits.io", "c@acme.com"], "corbits.io")).toBe(
      "external",
    );
  });
  test("no attendee emails is unknown", () => {
    expect(classifyCall(["Alice", "Bob"], "corbits.io")).toBe("unknown");
  });
});

describe("granola call pipeline", () => {
  test("processes a new call: persists artifact + hands off to fan-out", async () => {
    const fanCalls: FanOutInput[] = [];
    const pipeline = makePipeline(fanCalls);

    const result = await pipeline.processCall({
      tenantId: TENANT,
      note: {
        id: "note-1",
        title: "Acme discovery",
        participants: ["a@corbits.io", "cust@acme.com"],
        transcript: "we talked",
      },
    });

    expect(result.status).toBe("processed");
    const rows = (await artifactRows()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe(GRANOLA_CALL_ARTIFACT_KIND);
    expect((rows[0]?.source as { granolaNoteId: string }).granolaNoteId).toBe(
      "note-1",
    );
    expect((rows[0]?.source as { classification: string }).classification).toBe(
      "external",
    );
    expect(fanCalls).toHaveLength(1);
    expect(fanCalls[0]?.analysis.painPoints).toEqual(["Onboarding is slow"]);
  });

  test("is idempotent per call: a second run skips creating the artifact but still re-attempts fan-out", async () => {
    // CL-3577 review fix (HIGH): a process that crashed after persisting the
    // artifact but before fan-out completed must not lose delivery forever.
    // Fan-out is idempotent per (call, recipient) via messageKey dedupe (see
    // granola-call-fanout.test.ts), so re-attempting on every duplicate hit
    // is safe — it only re-delivers what a prior attempt never wrote.
    const fanCalls: FanOutInput[] = [];
    const pipeline = makePipeline(fanCalls);
    const note = {
      id: "note-2",
      title: "Repeat",
      participants: ["a@corbits.io"],
    };

    const first = await pipeline.processCall({ tenantId: TENANT, note });
    const second = await pipeline.processCall({ tenantId: TENANT, note });

    expect(second.status).toBe("skipped-duplicate");
    expect((await artifactRows()).rows).toHaveLength(1);
    expect(fanCalls).toHaveLength(2); // both runs attempt fan-out
    if (first.status !== "processed") throw new Error("expected processed");
    expect(fanCalls[1]?.artifactId).toBe(first.artifactId);
    // The reconstructed analysis on the duplicate path matches the original.
    expect(fanCalls[1]?.analysis.painPoints).toEqual(["Onboarding is slow"]);
  });

  test("concurrent processCall for the same note creates only one artifact and both attempt fan-out", async () => {
    const fanCalls: FanOutInput[] = [];
    const pipeline = makePipeline(fanCalls);
    const note = {
      id: "note-race",
      title: "Race",
      participants: ["a@corbits.io"],
    };

    const [first, second] = await Promise.all([
      pipeline.processCall({ tenantId: TENANT, note }),
      pipeline.processCall({ tenantId: TENANT, note }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["processed", "skipped-duplicate"]);
    expect((await artifactRows()).rows).toHaveLength(1);
    // The race loser now also attempts fan-out against the winner's artifact
    // (CL-3577 review fix) — safe because fan-out dedupes per recipient.
    expect(fanCalls).toHaveLength(2);
  });

  test("skips legibly when no inference source resolves", async () => {
    const pipeline = createGranolaCallPipeline({
      db,
      rootTenantDomain: "corbits.io",
      resolveInferenceSource: async () => null,
      fanout: { fanOut: async () => ({ delivered: 0, unmatched: [] }) },
    });
    const result = await pipeline.processCall({
      tenantId: TENANT,
      note: { id: "note-3" },
    });
    expect(result.status).toBe("skipped-no-source");
    expect((await artifactRows()).rows).toHaveLength(0);
  });

  test("winner-crashed-before-fanout: a duplicate hit delivers the mail the first run never sent, then delivers nothing new", async () => {
    // A fan-out fake with the SAME per-call idempotency contract real
    // fan-out has (`fanOutMessageKey`'s per-(call,recipient) dedupe,
    // exercised directly in granola-call-fanout.test.ts) — modeled here as
    // one messageKey per call so this test stays scoped to the pipeline's
    // own duplicate-path behavior without pulling in the mailbox-write /
    // capability-grant stack.
    const deliveredKeys = new Set<string>();
    const fanout = {
      fanOut: async (fanInput: FanOutInput) => {
        const key = `granola-call:${fanInput.note.id}`;
        if (deliveredKeys.has(key)) return { delivered: 0, unmatched: [] };
        deliveredKeys.add(key);
        return { delivered: 1, unmatched: [] };
      },
    };
    const pipeline = createGranolaCallPipeline({
      db,
      rootTenantDomain: "corbits.io",
      dataDir: "/tmp/granola-test",
      resolveInferenceSource: async () => SOURCE,
      fanout,
    });
    const note = {
      id: "note-crash-recovery",
      title: "Crash recovery",
      participants: ["a@corbits.io"],
    };

    // Simulate the artifact having been persisted by an earlier process that
    // crashed before its fan-out completed: process once for real (delivers
    // the mail), then simulate the crash by resetting the delivery record
    // WITHOUT touching the artifact row.
    const first = await pipeline.processCall({ tenantId: TENANT, note });
    expect(first.status).toBe("processed");
    expect(deliveredKeys.size).toBe(1);
    deliveredKeys.clear();

    // Re-run: the existing-artifact duplicate path must still deliver the
    // mail the crashed run never sent.
    const second = await pipeline.processCall({ tenantId: TENANT, note });
    expect(second.status).toBe("skipped-duplicate");
    expect(deliveredKeys.size).toBe(1);

    // A third run delivers nothing new: the retry's delivery is still on
    // record, deduped by messageKey.
    const third = await pipeline.processCall({ tenantId: TENANT, note });
    expect(third.status).toBe("skipped-duplicate");
    expect(deliveredKeys.size).toBe(1);
  });

  test("throws on non-JSON analysis output", async () => {
    oneShotReturn = "not json at all";
    const pipeline = makePipeline([]);
    await expect(
      pipeline.processCall({ tenantId: TENANT, note: { id: "note-4" } }),
    ).rejects.toThrow(/non-JSON/);
  });
});
