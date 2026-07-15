import { describe, expect, it } from "bun:test";
import {
  groupChatTurns,
  hasFailedSegment,
  isTurnLive,
  projectSettledTurn,
} from "./settled-turn-projection";
import type { ChatMessage } from "./types";

function agent(extra: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: "agent",
    content: "",
    createdAt: "2026-07-14T00:00:00Z",
    ...extra,
  };
}

function user(extra: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: "user",
    content: "",
    createdAt: "2026-07-14T00:00:00Z",
    ...extra,
  };
}

describe("groupChatTurns", () => {
  it("groups consecutive agent messages that share a turnId", () => {
    const messages = [
      user({ id: "u1", content: "hi" }),
      agent({ id: "a1", content: "Let me look into that.", turnId: "g1" }),
      agent({ id: "a2", content: "Checked the records.", turnId: "g1" }),
      agent({ id: "a3", content: "Here is the summary.", turnId: "g1" }),
      user({ id: "u2", content: "thanks" }),
    ];
    const groups = groupChatTurns(messages);
    expect(groups.map((g) => g.map((m) => m.id))).toEqual([
      ["u1"],
      ["a1", "a2", "a3"],
      ["u2"],
    ]);
  });

  it("never merges adjacent agent messages with different or missing turnIds (agent-initiated mail stays its own turn)", () => {
    // A reply's segments followed by a gate mail / brief with NO user message
    // between: the mail carries no turnId and must remain its own group.
    const messages = [
      user({ id: "u1", content: "question" }),
      agent({ id: "a1", content: "Narration.", turnId: "g1" }),
      agent({ id: "a2", content: "The real answer.", turnId: "g1" }),
      agent({ id: "m1", content: "Gate mail body." }),
      agent({ id: "m2", content: "Morning brief." }),
    ];
    const groups = groupChatTurns(messages);
    expect(groups.map((g) => g.map((m) => m.id))).toEqual([
      ["u1"],
      ["a1", "a2"],
      ["m1"],
      ["m2"],
    ]);
  });

  it("does not merge two exchanges with distinct turnIds even when adjacent", () => {
    const messages = [
      agent({ id: "a1", content: "First reply.", turnId: "g1" }),
      agent({ id: "a2", content: "Second reply.", turnId: "g2" }),
    ];
    const groups = groupChatTurns(messages);
    expect(groups.map((g) => g.map((m) => m.id))).toEqual([["a1"], ["a2"]]);
  });

  it("keeps a single agent message as its own single-element group", () => {
    const only = agent({ id: "a1", content: "Done." });
    expect(groupChatTurns([only])).toEqual([[only]]);
  });
});

describe("isTurnLive / hasFailedSegment", () => {
  it("isTurnLive is true when any segment is still sending", () => {
    const segments = [
      agent({ id: "a1", content: "First.", status: "sent", turnId: "g1" }),
      agent({ id: "a2", content: "", status: "sending", turnId: "g1" }),
    ];
    expect(isTurnLive(segments)).toBe(true);
  });

  it("isTurnLive is false when every segment has settled", () => {
    const segments = [
      agent({ id: "a1", content: "First.", status: "sent" }),
      agent({ id: "a2", content: "Second." }),
    ];
    expect(isTurnLive(segments)).toBe(false);
  });

  it("hasFailedSegment detects a failed segment inside an otherwise settled group", () => {
    const segments = [
      agent({ id: "a1", content: "First.", turnId: "g1" }),
      agent({ id: "a2", content: "Broke.", status: "failed", turnId: "g1" }),
    ];
    expect(hasFailedSegment(segments)).toBe(true);
    expect(hasFailedSegment([segments[0]!])).toBe(false);
  });
});

describe("projectSettledTurn", () => {
  it("collapses a multi-segment turn to the final answer only, dropping narration/reasoning/tools", () => {
    const segments: ChatMessage[] = [
      agent({ id: "a1", content: "Let me look into that.", turnId: "g1" }),
      agent({
        id: "a2",
        content: "Checked the records.",
        turnId: "g1",
        toolCalls: [{ id: "c1", name: "crm_lookup", result: "found" }],
      }),
      agent({
        id: "a3",
        content: "Cross-referencing with the notes.",
        turnId: "g1",
        reasoning: "The record conflicts with the call notes; reconciling.",
      }),
      agent({ id: "a4", content: "Here is the summary.", turnId: "g1" }),
    ];
    const projected = projectSettledTurn(segments);
    expect(projected).toHaveLength(1);
    expect(projected[0]?.id).toBe("a4");
    expect(projected[0]?.content).toBe("Here is the summary.");
    expect(projected[0]?.reasoning).toBeUndefined();
    expect(projected[0]?.toolCalls).toBeUndefined();
    expect(projected[0]?.parts).toEqual([
      { type: "text", text: "Here is the summary." },
    ]);
  });

  it("carries forward file/attachment parts from any segment, not just the final one", () => {
    const segments: ChatMessage[] = [
      agent({
        id: "a1",
        content: "Generating the deck.",
        turnId: "g1",
        attachments: [
          {
            blobId: "b1",
            name: "deck.pdf",
            type: "application/pdf",
            size: 100,
          },
        ],
      }),
      agent({ id: "a2", content: "Done — here it is.", turnId: "g1" }),
    ];
    const projected = projectSettledTurn(segments);
    expect(projected).toHaveLength(1);
    expect(projected[0]?.content).toBe("Done — here it is.");
    expect(projected[0]?.attachments).toEqual([
      { blobId: "b1", name: "deck.pdf", type: "application/pdf", size: 100 },
    ]);
    expect(projected[0]?.parts?.some((p) => p.type === "file")).toBe(true);
    expect(projected[0]?.parts?.at(-1)).toEqual({
      type: "text",
      text: "Done — here it is.",
    });
  });

  it("keeps a non-final segment carrying an embedded UI block as its own outputs entry", () => {
    const blockContent = [
      "Here's the document.",
      "```ui",
      '{"kind":"document","title":"ABK Demo","source":"# Call"}',
      "```",
    ].join("\n");
    const segments: ChatMessage[] = [
      agent({ id: "a1", content: "Let me draft it.", turnId: "g1" }),
      agent({
        id: "a2",
        content: blockContent,
        turnId: "g1",
        toolCalls: [{ id: "c1", name: "doc_build", result: "ok" }],
      }),
      agent({ id: "a3", content: "Anything else?", turnId: "g1" }),
    ];
    const projected = projectSettledTurn(segments);
    expect(projected.map((m) => m.id)).toEqual(["a2", "a3"]);
    // The block segment survives with its content (block included) but no
    // process fields.
    expect(projected[0]?.content).toBe(blockContent);
    expect(projected[0]?.toolCalls).toBeUndefined();
    // Narration without a block is still dropped.
    expect(projected.some((m) => m.content === "Let me draft it.")).toBe(false);
  });

  it("falls back to the last segment when no segment carries closing text", () => {
    const segments: ChatMessage[] = [
      agent({
        id: "a1",
        content: "",
        turnId: "g1",
        toolCalls: [{ id: "c1", name: "write_file", result: "ok" }],
      }),
    ];
    const projected = projectSettledTurn(segments);
    expect(projected).toHaveLength(1);
    expect(projected[0]?.id).toBe("a1");
    expect(projected[0]?.content).toBe("");
    expect(projected[0]?.toolCalls).toBeUndefined();
    expect(projected[0]?.parts).toEqual([]);
  });

  it("preserves feedbackId from the final segment so feedback anchors to the answer", () => {
    const segments: ChatMessage[] = [
      agent({ id: "a1", content: "Working on it.", turnId: "g1" }),
      agent({ id: "a2", content: "Done.", feedbackId: "t1", turnId: "g1" }),
    ];
    const projected = projectSettledTurn(segments);
    expect(projected[0]?.feedbackId).toBe("t1");
  });
});
