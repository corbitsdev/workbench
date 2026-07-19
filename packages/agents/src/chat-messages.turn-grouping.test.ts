import { describe, expect, it } from "bun:test";
import type { InstanceEvent } from "@intx/hub-client";
import { composeChatMessages } from "./chat-messages";

/**
 * Additive turn-identity stamping: composeChatMessages marks every message it
 * derives from a committed turn with a `turnId` group key so the renderer can
 * group one exchange's segments WITHOUT merging unrelated agent messages
 * (agent-initiated mail — gate mail, triage handoffs, morning briefs — is a
 * bare role:"agent" message that must never fold into the prior reply).
 *
 * These tests are additive to the pinned composition regression spec, which
 * must keep passing unmodified.
 */

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

type TurnEvent = Extract<InstanceEvent, { kind: "turn" }>;

const textTurn = (
  turnId: string,
  content: string,
  timestamp: string,
  extra: Partial<Omit<TurnEvent, "kind">> = {},
): InstanceEvent => ({
  kind: "turn",
  turnId,
  content,
  timestamp,
  ...extra,
});

describe("turn-identity stamping for renderer grouping", () => {
  it("stamps the same turnId group on every committed segment of one exchange", () => {
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "look into it", "2024-01-01T00:00:00.000Z"),
        textTurn("t1", "Let me look into that.", "2024-01-01T00:00:10.000Z"),
        textTurn("t2", "Checked the records.", "2024-01-01T00:00:20.000Z", {
          toolCalls: [
            { name: "crm_lookup", arguments: {}, result: "r", isError: false },
          ],
        }),
        textTurn("t3", "Here is the summary.", "2024-01-01T00:00:30.000Z"),
      ],
      streaming: "",
    });
    const agentMessages = messages.filter((m) => m.role === "agent");
    expect(agentMessages).toHaveLength(3);
    const groupIds = agentMessages.map((m) => m.turnId);
    expect(groupIds[0]).toBeDefined();
    expect(new Set(groupIds).size).toBe(1);
  });

  it("gives a standalone agent-initiated mail NO shared turnId, so it can never merge with the prior reply", () => {
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "question", "2024-01-01T00:00:00.000Z"),
        textTurn("t1", "The real answer.", "2024-01-01T00:00:10.000Z", {
          toolCalls: [
            { name: "crm_lookup", arguments: {}, result: "r", isError: false },
          ],
        }),
        // Agent-initiated mail with NO user message between — a gate mail /
        // brief. It must not share the reply's group.
        assistantMail("m1", "Gate mail body.", "2024-01-01T00:01:00.000Z"),
      ],
      streaming: "",
    });
    const reply = messages.find((m) => m.content === "The real answer.");
    const gateMail = messages.find((m) => m.content === "Gate mail body.");
    expect(reply?.turnId).toBeDefined();
    expect(gateMail?.turnId).toBeUndefined();
  });

  it("stamps a hoisted assistant mail (replacing a text-only turn) with the replaced turn's group", () => {
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "go", "2024-01-01T00:00:00.000Z"),
        textTurn("t1", "Let me check.", "2024-01-01T00:00:10.000Z", {
          toolCalls: [
            { name: "crm_lookup", arguments: {}, result: "r", isError: false },
          ],
        }),
        textTurn("t2", "Final answer.", "2024-01-01T00:00:20.000Z"),
        assistantMail("a1", "Final answer.", "2024-01-01T00:00:25.000Z"),
      ],
      streaming: "",
    });
    const narration = messages.find((m) => m.content === "Let me check.");
    const answer = messages.find((m) => m.content === "Final answer.");
    expect(answer?.id).toBe("a1");
    expect(answer?.turnId).toBeDefined();
    expect(answer?.turnId).toBe(narration?.turnId as string);
  });

  it("separates two exchanges: segments after a new user mail get a different group", () => {
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "first", "2024-01-01T00:00:00.000Z"),
        textTurn("t1", "First reply.", "2024-01-01T00:00:10.000Z"),
        userMail("u2", "second", "2024-01-01T00:01:00.000Z"),
        textTurn("t2", "Second reply.", "2024-01-01T00:01:10.000Z"),
      ],
      streaming: "",
    });
    const first = messages.find((m) => m.content === "First reply.");
    const second = messages.find((m) => m.content === "Second reply.");
    expect(first?.turnId).toBeDefined();
    expect(second?.turnId).toBeDefined();
    expect(first?.turnId).not.toBe(second?.turnId as string);
  });

  it("groups a reload-shaped final mail with its exchange's tool-call turn even with no matching text-only turn to hoist against (CL-3930)", () => {
    // @intx/hub-client's turnToEvent drops a historical turn with no tool
    // calls/errors (its content is assumed to survive via the echoed mail),
    // so a reloaded transcript never carries the plain-text final turn a
    // live stream would have hoisted the mail against — only the narration
    // turn (kept because it carries tool calls) and the final assistant mail
    // arrive.
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "go", "2024-01-01T00:00:00.000Z"),
        textTurn("t1", "Let me check.", "2024-01-01T00:00:10.000Z", {
          toolCalls: [
            { name: "crm_lookup", arguments: {}, result: "r", isError: false },
          ],
        }),
        assistantMail(
          "a1",
          "Here is the final answer.",
          "2024-01-01T00:00:15.000Z",
        ),
      ],
      streaming: "",
    });
    const narration = messages.find((m) => m.content === "Let me check.");
    const answer = messages.find(
      (m) => m.content === "Here is the final answer.",
    );
    expect(narration?.turnId).toBeDefined();
    expect(answer?.turnId).toBeDefined();
    expect(answer?.turnId).toBe(narration?.turnId as string);
  });

  it("does not group an assistant mail arriving well outside the reply-echo window (gate mail / triage handoff / brief)", () => {
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "go", "2024-01-01T00:00:00.000Z"),
        textTurn("t1", "The real answer.", "2024-01-01T00:00:10.000Z", {
          toolCalls: [
            { name: "crm_lookup", arguments: {}, result: "r", isError: false },
          ],
        }),
        assistantMail("m1", "Gate mail body.", "2024-01-01T00:01:00.000Z"),
      ],
      streaming: "",
    });
    const reply = messages.find((m) => m.content === "The real answer.");
    const gateMail = messages.find((m) => m.content === "Gate mail body.");
    expect(reply?.turnId).toBeDefined();
    expect(gateMail?.turnId).toBeUndefined();
  });

  it("does not group a trailing assistant mail when the exchange already sent mail explicitly via mail_send", () => {
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "go", "2024-01-01T00:00:00.000Z"),
        textTurn("t1", "Messaging the team.", "2024-01-01T00:00:10.000Z", {
          toolCalls: [
            {
              name: "mail_send",
              arguments: {},
              result: "sent",
              isError: false,
            },
          ],
        }),
        assistantMail("m1", "Unrelated note.", "2024-01-01T00:00:12.000Z"),
      ],
      streaming: "",
    });
    const turn = messages.find((m) => m.content === "Messaging the team.");
    const mail = messages.find((m) => m.content === "Unrelated note.");
    expect(turn?.turnId).toBeDefined();
    expect(mail?.turnId).toBeUndefined();
  });

  it("stamps the live streaming bubble with the current exchange group so an in-flight turn stays grouped with its committed segments", () => {
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "go", "2024-01-01T00:00:00.000Z"),
        textTurn("t1", "Let me check.", "2024-01-01T00:00:10.000Z", {
          toolCalls: [
            { name: "crm_lookup", arguments: {}, result: "r", isError: false },
          ],
        }),
      ],
      streaming: "Working on the summary",
    });
    const narration = messages.find((m) => m.content === "Let me check.");
    const live = messages[messages.length - 1];
    expect(live?.status).toBe("sending");
    expect(live?.turnId).toBeDefined();
    expect(live?.turnId).toBe(narration?.turnId as string);
  });
});
