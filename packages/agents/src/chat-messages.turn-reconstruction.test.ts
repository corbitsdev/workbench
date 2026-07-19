import { describe, expect, it } from "bun:test";
import type { InferenceTurnResponse } from "@intx/types";
import type { InstanceEvent } from "@intx/hub-client";
import {
  composeChatMessages,
  mergeReconstructedTurns,
  reconstructDroppedTurnEvents,
} from "./chat-messages";

/**
 * Reload hydration gap: @intx/hub-client's turnToEvent (see
 * interchange/packages/hub-client/src/transforms.ts) drops any historical
 * turn with no errors and no tool calls, assuming its text survives via an
 * echoed outbound assistant mail. Under the current workflow-host runtime,
 * single-step deployments no longer send that echo mail, so for a
 * plain-text turn the persisted inference_turn is the ONLY record of the
 * reply — turnToEvent drops it and nothing renders on reload.
 *
 * reconstructDroppedTurnEvents / mergeReconstructedTurns compensate at the
 * workbench hydration seam: they re-derive exactly the event turnToEvent
 * would have produced had it not dropped the turn, from turns the caller
 * fetched independently.
 */

const baseTurn: InferenceTurnResponse = {
  id: "turn_1",
  sessionId: "sess_1",
  instanceId: "ins_abc123",
  model: "gpt-4",
  status: "completed",
  startedAt: "2024-01-03T00:00:00Z",
  endedAt: "2024-01-03T00:00:01Z",
  parts: [],
};

function textOnlyTurn(
  id: string,
  content: string,
  startedAt: string,
): InferenceTurnResponse {
  return {
    ...baseTurn,
    id,
    startedAt,
    parts: [
      {
        id: `${id}_p1`,
        type: "text",
        content,
        metadata: null,
        ordinal: 0,
      },
    ],
  };
}

function toolCallTurn(id: string, startedAt: string): InferenceTurnResponse {
  return {
    ...baseTurn,
    id,
    startedAt,
    parts: [
      {
        id: `${id}_call`,
        type: "tool",
        content: null,
        metadata: { kind: "call", callId: "call_1", name: "crm_lookup" },
        ordinal: 0,
      },
      {
        id: `${id}_result`,
        type: "tool",
        content: null,
        metadata: {
          kind: "result",
          callId: "call_1",
          isError: false,
          content: "found",
        },
        ordinal: 1,
      },
      {
        id: `${id}_text`,
        type: "text",
        content: "Checked the records.",
        metadata: null,
        ordinal: 2,
      },
    ],
  };
}

const userMail = (
  id: string,
  content: string,
  timestamp: string,
): InstanceEvent => ({
  kind: "mail",
  id,
  role: "user",
  content,
  sender: { name: null, email: "u@example.com" },
  recipients: [],
  timestamp,
  attachments: [],
});

const assistantMail = (
  id: string,
  content: string,
  timestamp: string,
): InstanceEvent => ({
  kind: "mail",
  id,
  role: "assistant",
  content,
  sender: { name: "Agent", email: "a@example.com" },
  recipients: [],
  timestamp,
  attachments: [],
});

describe("reconstructDroppedTurnEvents", () => {
  it("reconstructs a text-only turn that turnToEvent would drop", () => {
    const reconstructed = reconstructDroppedTurnEvents([
      textOnlyTurn("t1", "Here is the final answer.", "2024-01-03T00:00:00Z"),
    ]);
    expect(reconstructed).toHaveLength(1);
    expect(reconstructed[0]).toEqual({
      kind: "turn",
      turnId: "t1",
      content: "Here is the final answer.",
      timestamp: "2024-01-03T00:00:00Z",
    });
  });

  it("does not reconstruct a turn with tool calls (turnToEvent already keeps it)", () => {
    const reconstructed = reconstructDroppedTurnEvents([
      toolCallTurn("t1", "2024-01-03T00:00:00Z"),
    ]);
    expect(reconstructed).toHaveLength(0);
  });

  it("does not reconstruct a genuinely empty turn (no text, no errors, no tool calls)", () => {
    const reconstructed = reconstructDroppedTurnEvents([
      { ...baseTurn, id: "t1", parts: [] },
    ]);
    expect(reconstructed).toHaveLength(0);
  });
});

describe("mergeReconstructedTurns", () => {
  it("adds a reconstructed turn absent from the hydrated events", () => {
    const events: InstanceEvent[] = [
      userMail("u1", "go", "2024-01-03T00:00:00Z"),
    ];
    const reconstructed = reconstructDroppedTurnEvents([
      textOnlyTurn("t1", "Here is the answer.", "2024-01-03T00:00:05Z"),
    ]);
    const merged = mergeReconstructedTurns(events, reconstructed);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ kind: "turn", turnId: "t1" });
  });

  it("skips a reconstructed turn whose turnId is already present (turnToEvent kept it)", () => {
    const events: InstanceEvent[] = [
      {
        kind: "turn",
        turnId: "t1",
        content: "Checked the records.",
        timestamp: "2024-01-03T00:00:00Z",
      },
    ];
    const reconstructed: InstanceEvent[] = [
      {
        kind: "turn",
        turnId: "t1",
        content: "stale duplicate",
        timestamp: "2024-01-03T00:00:00Z",
      },
    ];
    const merged = mergeReconstructedTurns(events, reconstructed);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(events[0]);
  });

  it("is a no-op (same content) when nothing to reconstruct — live-session events pass through unaffected", () => {
    const events: InstanceEvent[] = [
      userMail("u1", "go", "2024-01-03T00:00:00Z"),
      {
        kind: "turn",
        turnId: "t1",
        content: "Live reply.",
        timestamp: "2024-01-03T00:00:05Z",
      },
    ];
    const merged = mergeReconstructedTurns(events, []);
    expect(merged).toEqual(events);
  });
});

describe("reload hydration end-to-end (reconstruction feeding composeChatMessages)", () => {
  it("renders the assistant response for a reload-shaped transcript with a text-only final turn and NO echo mail", () => {
    // Shape after a REST-only reload under the current workflow-host runtime:
    // no outbound echo mail was ever sent, so the plain-text turn is the
    // ONLY record of the reply. Without reconstruction, turnToEvent already
    // dropped this turn before it ever reached composeChatMessages — this
    // events array (mail + surviving tool-call turn only) is what hydration
    // produces from @intx/hub-client today.
    const events: InstanceEvent[] = [
      userMail("u1", "look into it", "2024-01-03T00:00:00Z"),
      {
        kind: "turn",
        turnId: "t1",
        content: "Checked the records.",
        timestamp: "2024-01-03T00:00:05Z",
        toolCalls: [
          {
            name: "crm_lookup",
            arguments: {},
            result: "found",
            isError: false,
          },
        ],
      },
    ];
    const turns: InferenceTurnResponse[] = [
      toolCallTurn("t1", "2024-01-03T00:00:05Z"),
      textOnlyTurn("t2", "Here is the final answer.", "2024-01-03T00:00:10Z"),
    ];
    const reconstructed = reconstructDroppedTurnEvents(turns);
    const merged = mergeReconstructedTurns(events, reconstructed);

    const { messages } = composeChatMessages({ events: merged, streaming: "" });
    const answer = messages.find(
      (m) => m.content === "Here is the final answer.",
    );
    expect(answer).toBeDefined();
  });

  it("renders the legacy echo-mail overlap exactly once (mail + reconstructed turn share content, existing hoist dedupes)", () => {
    const events: InstanceEvent[] = [
      userMail("u1", "go", "2024-01-03T00:00:00Z"),
      assistantMail("a1", "Here is the final answer.", "2024-01-03T00:00:12Z"),
    ];
    const turns: InferenceTurnResponse[] = [
      textOnlyTurn("t2", "Here is the final answer.", "2024-01-03T00:00:10Z"),
    ];
    const reconstructed = reconstructDroppedTurnEvents(turns);
    const merged = mergeReconstructedTurns(events, reconstructed);

    const { messages } = composeChatMessages({ events: merged, streaming: "" });
    const answers = messages.filter(
      (m) => m.content === "Here is the final answer.",
    );
    expect(answers).toHaveLength(1);
    // The surviving message is the mail (server-timestamped), matching
    // composeChatMessages' existing mail-over-turn precedence.
    expect(answers[0]?.id).toBe("a1");
  });

  it("live-session shape (non-empty streaming buffer, no raw turns to reconstruct) is unaffected", () => {
    const events: InstanceEvent[] = [
      userMail("u1", "go", "2024-01-03T00:00:00Z"),
      {
        kind: "turn",
        turnId: "t1",
        content: "Checked the records.",
        timestamp: "2024-01-03T00:00:05Z",
        toolCalls: [
          {
            name: "crm_lookup",
            arguments: {},
            result: "found",
            isError: false,
          },
        ],
      },
    ];
    // No independent turns fetch result yet (still streaming) — nothing to
    // reconstruct or merge.
    const merged = mergeReconstructedTurns(events, []);
    const { messages } = composeChatMessages({
      events: merged,
      streaming: "Working on the summary",
    });
    const live = messages[messages.length - 1];
    expect(live?.status).toBe("sending");
    expect(live?.content).toBe("Working on the summary");
  });
});
