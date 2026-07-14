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

  test("is idempotent per call: a second run skips (no duplicate artifact, no fan-out)", async () => {
    const fanCalls: FanOutInput[] = [];
    const pipeline = makePipeline(fanCalls);
    const note = {
      id: "note-2",
      title: "Repeat",
      participants: ["a@corbits.io"],
    };

    await pipeline.processCall({ tenantId: TENANT, note });
    const second = await pipeline.processCall({ tenantId: TENANT, note });

    expect(second.status).toBe("skipped-duplicate");
    expect((await artifactRows()).rows).toHaveLength(1);
    expect(fanCalls).toHaveLength(1); // only the first run fanned out
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

  test("throws on non-JSON analysis output", async () => {
    oneShotReturn = "not json at all";
    const pipeline = makePipeline([]);
    await expect(
      pipeline.processCall({ tenantId: TENANT, note: { id: "note-4" } }),
    ).rejects.toThrow(/non-JSON/);
  });
});
