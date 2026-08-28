import { describe, expect, test } from "bun:test";

import { encodeToolName } from "@intx/inference";
import type { InferenceEvent } from "@intx/types/runtime";
import type { DB } from "@intx/db";

import { createEventCollector } from "./event-collector";
import { MALFORMED_TOOL_NAME } from "./sanitize-tool-name";

// Stand-in for the drizzle call chains event-collector.ts drives, recording
// every turnPart insert so a test can inspect what actually landed in
// "history".
function createRecordingDb(): {
  db: DB["db"];
  insertedParts: { type: string; metadata?: Record<string, unknown> }[];
} {
  const insertedParts: { type: string; metadata?: Record<string, unknown> }[] =
    [];
  const chain = {
    set: () => chain,
    where: () => Promise.resolve(),
  };
  const db = {
    insert: (table: unknown) => ({
      values: (values: {
        type: string;
        metadata?: Record<string, unknown>;
      }) => {
        // inferenceTurn inserts don't carry a turnPart-shaped `type`
        // discriminant matching the ones this suite cares about, but the
        // fake table objects are opaque here, so filter on shape instead.
        if (typeof values.type === "string") {
          insertedParts.push(values);
        }
        return Promise.resolve();
      },
      ...chain,
    }),
    update: () => chain,
  } as unknown as DB["db"];
  return { db, insertedParts };
}

describe("CL-6478: malformed tool-call names never wedge the room", () => {
  const OPENAI_LIMIT = { provider: "openai", maxLength: 64 } as const;

  test("a leaked provider fragment in a tool-call name persists as a re-encodable placeholder", async () => {
    const { db, insertedParts } = createRecordingDb();
    const collector = createEventCollector({
      db,
      sessionId: "session-1",
      runId: "run-1",
      tenantId: "tenant-acme",
    });

    await collector.onEvent({
      type: "inference.start",
      seq: 1,
      data: { model: "qwen3.8:27b" },
    } as InferenceEvent);

    await collector.onEvent({
      type: "inference.done",
      seq: 2,
      data: {
        turn: {
          content: [
            {
              type: "tool_call",
              id: "call-1",
              // The CL-6478 report: qwen3.8:27b leaked this fragment into
              // the function name decodeToolName then passed through
              // verbatim.
              name: "@intx/tools-posix/sidecar-bundle:run_shell\n</parameter",
              arguments: {},
            },
          ],
        },
      },
    } as InferenceEvent);

    const toolCallPart = insertedParts.find(
      (part) => part.metadata?.kind === "call",
    );
    if (toolCallPart === undefined)
      throw new Error("expected a tool call part");
    const persistedName = toolCallPart.metadata?.name;

    // The malformed name was never written to history as-is.
    expect(persistedName).toBe(MALFORMED_TOOL_NAME);

    // The regression that matters: whatever got persisted, the next
    // turn's outbound request can put back on the wire. Before the fix,
    // persisting the raw leaked name here meant this call threw, and the
    // room could never accept another message.
    expect(() =>
      encodeToolName(persistedName as string, OPENAI_LIMIT),
    ).not.toThrow();

    // And the collector itself is unaffected: a second turn in the same
    // room proceeds normally.
    await collector.onEvent({
      type: "inference.start",
      seq: 3,
      data: { model: "qwen3.8:27b" },
    } as InferenceEvent);
    const secondTurnId = collector.getCurrentTurnId();
    expect(secondTurnId).not.toBeNull();
  });

  test("a well-formed tool-call name still persists unchanged", async () => {
    const { db, insertedParts } = createRecordingDb();
    const collector = createEventCollector({
      db,
      sessionId: "session-1",
      runId: "run-1",
      tenantId: "tenant-acme",
    });

    await collector.onEvent({
      type: "inference.start",
      seq: 1,
      data: { model: "claude-sonnet" },
    } as InferenceEvent);

    await collector.onEvent({
      type: "inference.done",
      seq: 2,
      data: {
        turn: {
          content: [
            {
              type: "tool_call",
              id: "call-1",
              name: "@intx/tools-posix/sidecar-bundle:run_shell",
              arguments: {},
            },
          ],
        },
      },
    } as InferenceEvent);

    const toolCallPart = insertedParts.find(
      (part) => part.metadata?.kind === "call",
    );
    expect(toolCallPart?.metadata?.name).toBe(
      "@intx/tools-posix/sidecar-bundle:run_shell",
    );
  });
});
