import { describe, expect, test } from "bun:test";

import { createReplyPartsAccumulator } from "./chat-orchestrator";

const AGENT_ADDRESS = "agent@example.com";

function toolCallBlock(callId: string) {
  return {
    kind: "tool-call" as const,
    callId,
    name: "giphy_search",
    input: {},
  };
}

describe("createReplyPartsAccumulator", () => {
  test("a normal successful tool result is unaffected", () => {
    const acc = createReplyPartsAccumulator();
    acc.onInferenceDone(AGENT_ADDRESS, [toolCallBlock("call_1")]);
    acc.onToolDone(AGENT_ADDRESS, {
      callId: "call_1",
      content: "3 results found",
      isError: false,
    });

    const parts = acc.take(AGENT_ADDRESS);
    expect(parts).toEqual([
      {
        kind: "tool-trace",
        name: "giphy_search",
        input: {},
        status: "success",
        output: "3 results found",
      },
    ]);
  });

  test("a failed tool result with no structured detail is unaffected", () => {
    const acc = createReplyPartsAccumulator();
    acc.onInferenceDone(AGENT_ADDRESS, [toolCallBlock("call_1")]);
    acc.onToolDone(AGENT_ADDRESS, {
      callId: "call_1",
      content: "timed out",
      isError: true,
    });

    const parts = acc.take(AGENT_ADDRESS);
    expect(parts).toEqual([
      {
        kind: "tool-trace",
        name: "giphy_search",
        input: {},
        status: "error",
        output: "timed out",
      },
    ]);
  });

  test("a missing-credential detail renders the connect-service block naming the connector", () => {
    const acc = createReplyPartsAccumulator();
    acc.onInferenceDone(AGENT_ADDRESS, [toolCallBlock("call_1")]);
    acc.onToolDone(AGENT_ADDRESS, {
      callId: "call_1",
      content: "GitHub is not connected for this run.",
      isError: true,
      detail: { kind: "missing-credential", connectorId: "github" },
    });

    const parts = acc.take(AGENT_ADDRESS);
    expect(parts).toEqual([
      {
        kind: "tool-trace",
        name: "giphy_search",
        input: {},
        status: "error",
        output: "GitHub is not connected for this run.",
      },
      {
        kind: "block",
        block: {
          type: "connect-service",
          data: {
            connectorId: "github",
            displayName: "GitHub",
            reason: "GitHub is not connected for this run.",
          },
        },
      },
    ]);
  });

  test("a missing-credential detail on a non-error result is ignored", () => {
    const acc = createReplyPartsAccumulator();
    acc.onInferenceDone(AGENT_ADDRESS, [toolCallBlock("call_1")]);
    acc.onToolDone(AGENT_ADDRESS, {
      callId: "call_1",
      content: "3 results found",
      isError: false,
      detail: { kind: "missing-credential", connectorId: "github" },
    });

    const parts = acc.take(AGENT_ADDRESS);
    expect(parts).toEqual([
      {
        kind: "tool-trace",
        name: "giphy_search",
        input: {},
        status: "success",
        output: "3 results found",
      },
    ]);
  });
});
