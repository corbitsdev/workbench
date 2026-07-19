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
import { createNativeApprovalEnricher } from "./native-approval-enrich";

const TENANT = "tnt-enrich";
const DEPLOYMENT = "dep-enrich";

let client: PGlite;
let db: HubDb;

async function insertApproval(correlationId: string): Promise<void> {
  await client.query(
    `insert into approval (id, tenant_id, deployment_id, run_id, agent_address, correlation_id, status)
     values ($1, $2, $3, $4, $5, $6, 'pending')`,
    [
      `apr-${correlationId}`,
      TENANT,
      DEPLOYMENT,
      "run-1",
      "ins_x@enrich.example.com",
      correlationId,
    ],
  );
}

async function readSnapshot(
  correlationId: string,
): Promise<{ toolDefinition: unknown; toolArguments: unknown } | undefined> {
  const rows = await client.query<{
    tool_definition: unknown;
    tool_arguments: unknown;
  }>(
    `select tool_definition, tool_arguments from approval where correlation_id = $1`,
    [correlationId],
  );
  const row = rows.rows[0];
  if (row === undefined) return undefined;
  return {
    toolDefinition: row.tool_definition,
    toolArguments: row.tool_arguments,
  };
}

beforeAll(async () => {
  client = new PGlite();
  const bootstrap = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, bootstrap as never);
  await apply();
  // FK enforcement off so an approval row can be seeded without its tenant /
  // deployment referents.
  await client.exec(`SET session_replication_role = 'replica';`);
  db = bootstrap as unknown as HubDb;
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.exec(`DELETE FROM approval;`);
});

describe("createNativeApprovalEnricher", () => {
  test("snapshot AFTER the row exists enriches it (name + args)", async () => {
    const enricher = createNativeApprovalEnricher(db);
    await insertApproval("corr-after");

    await enricher.recordToolSnapshot({
      correlationId: "corr-after",
      callId: "call-1",
      toolName: "linear__create_issue",
      toolArguments: { title: "Ship it", body: "now" },
    });

    const snap = await readSnapshot("corr-after");
    expect(snap?.toolDefinition).toEqual({ name: "linear__create_issue" });
    expect(snap?.toolArguments).toEqual({ title: "Ship it", body: "now" });
  });

  test("snapshot BEFORE the row exists buffers, then enriches on created", async () => {
    const enricher = createNativeApprovalEnricher(db);

    // Snapshot arrives first: no row yet, so nothing is written.
    await enricher.recordToolSnapshot({
      correlationId: "corr-before",
      callId: "call-2",
      toolName: "slack__post_message",
      toolArguments: { channel: "#gtm", text: "hi" },
    });
    expect(await readSnapshot("corr-before")).toBeUndefined();

    // The register co-write lands the row; enrichOnCreated applies the buffer.
    await insertApproval("corr-before");
    await enricher.enrichOnCreated("corr-before");

    const snap = await readSnapshot("corr-before");
    expect(snap?.toolDefinition).toEqual({ name: "slack__post_message" });
    expect(snap?.toolArguments).toEqual({ channel: "#gtm", text: "hi" });
  });

  test("concurrent gated calls each carry their OWN tool name + args (join by correlationId, not recency)", async () => {
    const enricher = createNativeApprovalEnricher(db);
    await insertApproval("corr-a");
    await insertApproval("corr-b");

    // Two suspensions in flight at once with different correlation ids and
    // different tools. Recorded in parallel; interleaving must not cross the
    // snapshots.
    await Promise.all([
      enricher.recordToolSnapshot({
        correlationId: "corr-a",
        callId: "call-a",
        toolName: "linear__create_issue",
        toolArguments: { title: "Issue A" },
      }),
      enricher.recordToolSnapshot({
        correlationId: "corr-b",
        callId: "call-b",
        toolName: "slack__post_message",
        toolArguments: { channel: "#b", text: "B" },
      }),
    ]);

    const a = await readSnapshot("corr-a");
    const b = await readSnapshot("corr-b");
    expect(a?.toolDefinition).toEqual({ name: "linear__create_issue" });
    expect(a?.toolArguments).toEqual({ title: "Issue A" });
    expect(b?.toolDefinition).toEqual({ name: "slack__post_message" });
    expect(b?.toolArguments).toEqual({ channel: "#b", text: "B" });
  });

  test("does not clobber an already-enriched row (idempotent)", async () => {
    const enricher = createNativeApprovalEnricher(db);
    await insertApproval("corr-idem");

    await enricher.recordToolSnapshot({
      correlationId: "corr-idem",
      callId: "call-1",
      toolName: "linear__create_issue",
      toolArguments: { title: "first" },
    });
    // A redelivered snapshot for the same correlation must not overwrite.
    await enricher.recordToolSnapshot({
      correlationId: "corr-idem",
      callId: "call-1",
      toolName: "linear__create_issue",
      toolArguments: { title: "SECOND" },
    });

    const snap = await readSnapshot("corr-idem");
    expect(snap?.toolArguments).toEqual({ title: "first" });
  });

  test("a malformed snapshot is dropped, never throws", async () => {
    const enricher = createNativeApprovalEnricher(db);
    await expect(
      enricher.recordToolSnapshot({ correlationId: 123 }),
    ).resolves.toBeUndefined();
  });
});
