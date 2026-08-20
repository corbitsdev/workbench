import { describe, expect, test } from "bun:test";

import { connectorReplyContent, messageRunEnded } from "./agent-events";

describe("connectorReplyContent", () => {
  test("reads the content off a connector.reply", () => {
    expect(
      connectorReplyContent({
        type: "connector.reply",
        seq: 1,
        data: { content: "All clear." },
      }),
    ).toBe("All clear.");
  });

  test("an empty reply reads as no reply", () => {
    expect(
      connectorReplyContent({
        type: "connector.reply",
        seq: 1,
        data: { content: "" },
      }),
    ).toBeUndefined();
  });

  test("any other event reads as no reply", () => {
    expect(connectorReplyContent({ type: "reactor.done" })).toBeUndefined();
    expect(connectorReplyContent(null)).toBeUndefined();
    expect(connectorReplyContent("connector.reply")).toBeUndefined();
  });
});

describe("messageRunEnded", () => {
  test("reads a completed bracket close", () => {
    expect(
      messageRunEnded({
        type: "message.run.ended",
        seq: 2,
        data: { status: "completed" },
      }),
    ).toEqual({ status: "completed", errorMessage: undefined });
  });

  test("reads a failed bracket close with its error message", () => {
    expect(
      messageRunEnded({
        type: "message.run.ended",
        seq: 2,
        data: { status: "failed", error: { message: "tool exploded" } },
      }),
    ).toEqual({ status: "failed", errorMessage: "tool exploded" });
  });

  test("an unknown status reads as no terminal signal", () => {
    expect(
      messageRunEnded({
        type: "message.run.ended",
        seq: 2,
        data: { status: "cancelled" },
      }),
    ).toBeUndefined();
  });

  test("any other event reads as no terminal signal", () => {
    expect(messageRunEnded({ type: "connector.reply" })).toBeUndefined();
    expect(messageRunEnded(undefined)).toBeUndefined();
  });
});
