import { describe, expect, mock, test } from "bun:test";
import { isToleranceEnvelopeFailure } from "@workbench/shared";
import type { HubDb } from "../db";

let deliverCalls: unknown[] = [];
let deliverResult: unknown = { delivered: [], skipped: [], errors: [] };

mock.module("../lib/inbox-deliver-batch", () => ({
  deliverInboxBatch: async (_db: HubDb, args: unknown) => {
    deliverCalls.push(args);
    return deliverResult;
  },
}));

const { createInboxDeliverBatchTools, INBOX_DELIVER_BATCH_DEFINITION } =
  await import("./inbox-deliver-batch");

// The tool is a `kind: "string"` AgentTool. Narrowing here rather than casting
// at each call site keeps the union honest.
function deliver(): (args: Record<string, unknown>) => Promise<string> {
  const [tool] = createInboxDeliverBatchTools({
    db: {} as never,
    tenantId: "ten_1",
    principalId: "prn_actor",
  });
  if (tool === undefined || tool.kind !== "string") {
    throw new Error("expected a string-kind inbox deliver tool");
  }
  const { handler } = tool;
  return (args) => handler(args, new AbortController().signal);
}

const VALID_ARGS = {
  fromLocalPart: "daily-linkedin",
  userAddress: "usr_owner@workbench.example",
  deliveries: [
    {
      refId: "alex",
      subject: "LinkedIn draft — Alex",
      body: "Draft body",
      messageKey: "linkedin-daily-mail:alex:2026-07-24",
      artifact: {
        title: "LinkedIn draft — Alex",
        body: "Draft body",
        kind: "linkedin-daily-draft",
        sourceRef: "linkedin-daily:alex:2026-07-24",
        jobLabel: "daily-linkedin",
      },
    },
  ],
};

describe("inbox_deliver_batch tool", () => {
  test("addresses deliveries by refId — the schema never asks for a principal id", () => {
    const items = (
      INBOX_DELIVER_BATCH_DEFINITION.inputSchema as {
        properties: {
          deliveries: {
            items: { required: string[]; properties: Record<string, unknown> };
          };
        };
      }
    ).properties.deliveries.items;
    expect(items.required).toEqual(["refId", "subject", "body", "messageKey"]);
    expect(items.properties.principalId).toBeUndefined();
    expect(items.properties.address).toBeUndefined();
  });

  test("passes parsed deliveries through and returns the batch result verbatim", async () => {
    deliverCalls = [];
    deliverResult = {
      delivered: [{ refId: "alex", mailWritten: true }],
      skipped: [{ refId: "pontus", reason: "no active member" }],
      errors: [],
    };
    const raw = await deliver()(VALID_ARGS);
    const parsed = JSON.parse(raw) as {
      skipped: { refId: string; reason: string }[];
    };
    // The skip survives the tool boundary intact — this is the only thing that
    // makes a departed member legible in the run output.
    expect(parsed.skipped).toEqual([
      { refId: "pontus", reason: "no active member" },
    ]);
    expect(isToleranceEnvelopeFailure(parsed)).toBe(false);

    const call = deliverCalls[0] as {
      tenantId: string;
      actorPrincipalId: string;
      deliveries: { refId: string }[];
    };
    expect(call.tenantId).toBe("ten_1");
    expect(call.actorPrincipalId).toBe("prn_actor");
    expect(call.deliveries.map((d) => d.refId)).toEqual(["alex"]);
  });

  // A native `action` step's harness throws whenever the dispatched tool's
  // OUTER ToolResult.isError is true, which kills the run. A `kind: "string"`
  // handler that throws produces exactly that. So an unusable argument object
  // must come back as a successful result whose CONTENT carries the shared
  // `{ isError: true, error }` envelope instead.
  test("a malformed call returns the tolerance envelope rather than throwing", async () => {
    deliverCalls = [];
    const cases: [string, Record<string, unknown>, RegExp][] = [
      [
        "missing fromLocalPart",
        { ...VALID_ARGS, fromLocalPart: "" },
        /fromLocalPart/,
      ],
      [
        "missing userAddress",
        { ...VALID_ARGS, userAddress: "  " },
        /userAddress/,
      ],
      [
        "empty deliveries",
        { ...VALID_ARGS, deliveries: [] },
        /non-empty array/,
      ],
      [
        "delivery without refId",
        {
          ...VALID_ARGS,
          deliveries: [{ subject: "s", body: "b", messageKey: "k" }],
        },
        /refId/,
      ],
      [
        "artifact without sourceRef",
        {
          ...VALID_ARGS,
          deliveries: [
            {
              refId: "alex",
              subject: "s",
              body: "b",
              messageKey: "k",
              artifact: { title: "t", body: "b", kind: "k" },
            },
          ],
        },
        /sourceRef/,
      ],
    ];

    for (const [label, args, pattern] of cases) {
      const raw = await deliver()(args);
      const parsed: unknown = JSON.parse(raw);
      if (!isToleranceEnvelopeFailure(parsed)) {
        throw new Error(`${label}: expected a tolerance envelope, got ${raw}`);
      }
      expect(parsed.error).toMatch(pattern);
    }
    // None of them reached the batch — they failed at the boundary.
    expect(deliverCalls).toEqual([]);
  });

  test("a thrown batch failure is also carried inside content, not on the outer result", async () => {
    deliverCalls = [];
    deliverResult = null;
    mock.module("../lib/inbox-deliver-batch", () => ({
      deliverInboxBatch: async () => {
        throw new Error("mailbox store unavailable");
      },
    }));
    const { createInboxDeliverBatchTools: rebuilt } = await import(
      "./inbox-deliver-batch"
    );
    const [tool] = rebuilt({
      db: {} as never,
      tenantId: "ten_1",
      principalId: "prn_actor",
    });
    if (tool === undefined || tool.kind !== "string") {
      throw new Error("expected a string-kind inbox deliver tool");
    }
    const raw = await tool.handler(VALID_ARGS, new AbortController().signal);
    const parsed: unknown = JSON.parse(raw);
    expect(isToleranceEnvelopeFailure(parsed)).toBe(true);
    if (isToleranceEnvelopeFailure(parsed)) {
      expect(parsed.error).toBe("mailbox store unavailable");
    }
  });
});
