import { describe, expect, test } from "bun:test";

import {
  connectorReplyContent,
  inferenceDoneBlocks,
  messageRunEnded,
  toolDoneResult,
} from "./agent-events";

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

describe("inferenceDoneBlocks", () => {
  test("splits an inference.done turn into text and tool-call blocks, in order", () => {
    expect(
      inferenceDoneBlocks({
        type: "inference.done",
        seq: 1,
        data: {
          turn: {
            content: [
              { type: "text", text: "Let me check that." },
              {
                type: "tool_call",
                id: "call_1",
                name: "web_search",
                arguments: { query: "web search browser" },
              },
              { type: "text", text: "Here's what I found." },
            ],
          },
        },
      }),
    ).toEqual([
      { kind: "text", text: "Let me check that." },
      {
        kind: "tool-call",
        callId: "call_1",
        name: "web_search",
        input: { query: "web search browser" },
      },
      { kind: "text", text: "Here's what I found." },
    ]);
  });

  test("drops block kinds with no chat-part equivalent (thinking, citations, ...)", () => {
    expect(
      inferenceDoneBlocks({
        type: "inference.done",
        seq: 1,
        data: {
          turn: {
            content: [
              { type: "thinking", thinking: "internal reasoning" },
              { type: "text", text: "Visible reply." },
            ],
          },
        },
      }),
    ).toEqual([{ kind: "text", text: "Visible reply." }]);
  });

  test("drops empty text blocks", () => {
    expect(
      inferenceDoneBlocks({
        type: "inference.done",
        seq: 1,
        data: { turn: { content: [{ type: "text", text: "" }] } },
      }),
    ).toEqual([]);
  });

  test("any other event reads as no blocks", () => {
    expect(inferenceDoneBlocks({ type: "connector.reply" })).toBeUndefined();
    expect(inferenceDoneBlocks(null)).toBeUndefined();
  });
});

describe("toolDoneResult", () => {
  test("reads a successful tool result", () => {
    expect(
      toolDoneResult({
        type: "tool.done",
        seq: 1,
        data: { result: { callId: "call_1", content: "3 results found" } },
      }),
    ).toEqual({ callId: "call_1", content: "3 results found", isError: false });
  });

  test("reads a failed tool result", () => {
    expect(
      toolDoneResult({
        type: "tool.done",
        seq: 1,
        data: {
          result: { callId: "call_1", content: "timed out", isError: true },
        },
      }),
    ).toEqual({ callId: "call_1", content: "timed out", isError: true });
  });

  test("any other event reads as no result", () => {
    expect(toolDoneResult({ type: "connector.reply" })).toBeUndefined();
    expect(toolDoneResult(undefined)).toBeUndefined();
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
