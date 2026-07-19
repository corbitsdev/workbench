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

import { parseInferenceEvent } from "@intx/types/runtime";
import { type } from "arktype";

import { schema } from "../db";
import type { HubDb } from "../db";
import { createNativeApprovalEnricher } from "./native-approval-enrich";
import { createApprovalsEventBus } from "./approvals-events";
import type { ApprovalEvent } from "./approvals-events";

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

  test("the EXACT reactor event validates through parseInferenceEvent and drives enrichment", async () => {
    const enricher = createNativeApprovalEnricher(db);
    await insertApproval("corr-reactor");

    // The literal frame the reactor emits at an authz `ask` suspension. It must
    // survive interchange's real validator with type + data intact (the
    // `custom.*` branch keeps `data` as an open Record), then enrich the row.
    const wire = {
      type: "custom.approval.requested",
      seq: 7,
      data: {
        correlationId: "corr-reactor",
        callId: "call-reactor",
        toolName: "linear__create_issue",
        toolArguments: { title: "From reactor" },
      },
    };
    const validated = parseInferenceEvent(wire);
    expect(validated instanceof type.errors).toBe(false);
    if (validated instanceof type.errors) throw new Error(validated.summary);
    expect(validated.type).toBe("custom.approval.requested");
    expect(validated.data).toEqual(wire.data);

    await enricher.recordToolSnapshot(validated.data);

    const snap = await readSnapshot("corr-reactor");
    expect(snap?.toolDefinition).toEqual({ name: "linear__create_issue" });
    expect(snap?.toolArguments).toEqual({ title: "From reactor" });
  });

  test("buffered-race: two snapshots buffered (rows absent) then drained, each row keeps its OWN snapshot", async () => {
    const enricher = createNativeApprovalEnricher(db);

    // Both snapshots arrive before either row exists — both buffer.
    await enricher.recordToolSnapshot({
      correlationId: "corr-buf-a",
      callId: "call-buf-a",
      toolName: "linear__create_issue",
      toolArguments: { title: "Buffered A" },
    });
    await enricher.recordToolSnapshot({
      correlationId: "corr-buf-b",
      callId: "call-buf-b",
      toolName: "slack__post_message",
      toolArguments: { channel: "#buf-b", text: "Buffered B" },
    });
    expect(await readSnapshot("corr-buf-a")).toBeUndefined();
    expect(await readSnapshot("corr-buf-b")).toBeUndefined();

    // Rows land, drained via enrichOnCreated in parallel.
    await insertApproval("corr-buf-a");
    await insertApproval("corr-buf-b");
    await Promise.all([
      enricher.enrichOnCreated("corr-buf-a"),
      enricher.enrichOnCreated("corr-buf-b"),
    ]);

    const a = await readSnapshot("corr-buf-a");
    const b = await readSnapshot("corr-buf-b");
    expect(a?.toolDefinition).toEqual({ name: "linear__create_issue" });
    expect(a?.toolArguments).toEqual({ title: "Buffered A" });
    expect(b?.toolDefinition).toEqual({ name: "slack__post_message" });
    expect(b?.toolArguments).toEqual({ channel: "#buf-b", text: "Buffered B" });
  });

  test("redacts secret-keyed values and caps oversized arguments before persist", async () => {
    const enricher = createNativeApprovalEnricher(db);
    await insertApproval("corr-redact");

    await enricher.recordToolSnapshot({
      correlationId: "corr-redact",
      callId: "call-redact",
      toolName: "slack__post_message",
      toolArguments: {
        channel: "#gtm",
        api_key: "sk-live-123",
        headers: { Authorization: "Bearer abc", "X-Trace": "keep-me" },
        nested: { password: "hunter2", note: "visible" },
      },
    });

    const snap = await readSnapshot("corr-redact");
    expect(snap?.toolArguments).toEqual({
      channel: "#gtm",
      api_key: "[redacted]",
      headers: { Authorization: "[redacted]", "X-Trace": "keep-me" },
      nested: { password: "[redacted]", note: "visible" },
    });
  });

  test("caps an oversized argument payload and marks it truncated", async () => {
    const enricher = createNativeApprovalEnricher(db);
    await insertApproval("corr-big");

    await enricher.recordToolSnapshot({
      correlationId: "corr-big",
      callId: "call-big",
      toolName: "slack__post_message",
      toolArguments: { blob: "x".repeat(20_000) },
    });

    const snap = (await readSnapshot("corr-big"))?.toolArguments as Record<
      string,
      unknown
    >;
    expect(snap.__truncated).toBe(true);
    expect(typeof snap.preview).toBe("string");
    expect((snap.preview as string).length).toBeLessThanOrEqual(8 * 1024);
  });
});

describe("createNativeApprovalEnricher post-creation notify (refetch contract)", () => {
  test("snapshot AFTER created publishes an 'updated' event with the approvalId", async () => {
    const bus = createApprovalsEventBus();
    const seen: ApprovalEvent[] = [];
    bus.subscribe(TENANT, (e) => seen.push(e));
    const enricher = createNativeApprovalEnricher(db, bus);

    // Row already exists (its "created" event has already fired elsewhere).
    await insertApproval("corr-upd");
    await enricher.recordToolSnapshot({
      correlationId: "corr-upd",
      callId: "call-upd",
      toolName: "linear__create_issue",
      toolArguments: { title: "late" },
    });

    expect(seen).toEqual([
      {
        tenantId: TENANT,
        sessionId: null,
        kind: "updated",
        approvalId: "apr-corr-upd",
      },
    ]);
  });

  test("snapshot BEFORE created publishes nothing (created will carry the snapshot)", async () => {
    const bus = createApprovalsEventBus();
    const seen: ApprovalEvent[] = [];
    bus.subscribe(TENANT, (e) => seen.push(e));
    const enricher = createNativeApprovalEnricher(db, bus);

    // Snapshot first, row absent: buffers, no publish.
    await enricher.recordToolSnapshot({
      correlationId: "corr-pre",
      callId: "call-pre",
      toolName: "slack__post_message",
      toolArguments: { channel: "#pre", text: "hi" },
    });
    // Row lands; enrichOnCreated applies the buffer but must NOT publish —
    // the "created" event (fired by the notify wrapper right after) already
    // carries the enriched snapshot.
    await insertApproval("corr-pre");
    await enricher.enrichOnCreated("corr-pre");

    expect(seen).toEqual([]);
  });

  test("a redelivered snapshot for an already-enriched row publishes no second 'updated'", async () => {
    const bus = createApprovalsEventBus();
    const seen: ApprovalEvent[] = [];
    bus.subscribe(TENANT, (e) => seen.push(e));
    const enricher = createNativeApprovalEnricher(db, bus);

    await insertApproval("corr-idem-pub");
    await enricher.recordToolSnapshot({
      correlationId: "corr-idem-pub",
      callId: "call-1",
      toolName: "linear__create_issue",
      toolArguments: { title: "first" },
    });
    await enricher.recordToolSnapshot({
      correlationId: "corr-idem-pub",
      callId: "call-1",
      toolName: "linear__create_issue",
      toolArguments: { title: "second" },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("updated");
  });
});
