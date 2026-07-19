import { describe, expect, it } from "bun:test";
import {
  groupChatTurns,
  hasFailedSegment,
  isTurnLive,
  projectLiveTurn,
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

describe("reloaded transcript rendering", () => {
  it("renders only the final answer for a reloaded multi-segment turn, dropping the interstitial and never showing a live indicator", () => {
    // Shape composeChatMessages now produces for a reloaded (non-live)
    // transcript once the mail-echo fix stamps the trailing assistant mail
    // with its exchange's group: a tool-call-bearing narration segment
    // sharing turnId with the final answer, both fully settled (no
    // `status: "sending"` — a reload never carries live status).
    const messages: ChatMessage[] = [
      agent({
        id: "t1",
        content: "The exact message from the system was: rate limited.",
        turnId: "g1",
        toolCalls: [{ id: "c1", name: "crm_lookup", result: "429" }],
      }),
      agent({ id: "a1", content: "Here is the final answer.", turnId: "g1" }),
    ];
    const groups = groupChatTurns(messages);
    expect(groups).toHaveLength(1);
    expect(hasFailedSegment(groups[0]!)).toBe(false);
    expect(isTurnLive(groups[0]!)).toBe(false);

    const projected = projectSettledTurn(groups[0]!);
    expect(projected).toHaveLength(1);
    expect(projected[0]?.content).toBe("Here is the final answer.");
    expect(
      projected.some((m) =>
        m.content.includes("The exact message from the system was"),
      ),
    ).toBe(false);
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

  it("re-projects a fully-settled group identically to the same messages hydrated fresh (reload parity)", () => {
    const settled: ChatMessage[] = [
      agent({ id: "a1", content: "Let me look into that.", turnId: "g1" }),
      agent({
        id: "a2",
        content: "Checked the records.",
        turnId: "g1",
        toolCalls: [{ id: "c1", name: "crm_lookup", result: "found" }],
      }),
      agent({ id: "a3", content: "Here is the summary.", turnId: "g1" }),
    ];
    const fromLiveSettle = projectSettledTurn(settled);
    const fromReload = projectSettledTurn([...settled]);
    expect(fromLiveSettle).toEqual(fromReload);
  });
});

describe("projectLiveTurn", () => {
  it("leaves the streaming segment untouched but strips settled siblings to outputs only", () => {
    const segments: ChatMessage[] = [
      agent({
        id: "a1",
        content: "Let me look into that.",
        turnId: "g1",
        reasoning: "Deciding how to look this up.",
        toolCalls: [{ id: "c1", name: "crm_lookup", result: "found" }],
      }),
      agent({
        id: "a2",
        content: "",
        status: "sending",
        turnId: "g1",
        reasoning: "Cross-referencing with the notes.",
        toolCalls: [{ id: "c2", name: "memory_search" }],
      }),
    ];
    const projected = projectLiveTurn(segments);
    expect(projected).toHaveLength(2);
    // Settled sibling: outputs only, no reasoning/toolCalls left to render.
    expect(projected[0]?.id).toBe("a1");
    expect(projected[0]?.reasoning).toBeUndefined();
    expect(projected[0]?.toolCalls).toBeUndefined();
    expect(projected[0]?.content).toBe("Let me look into that.");
    // Streaming segment: untouched, so AgentTurn still renders its activity.
    expect(projected[1]).toBe(segments[1]);
    expect(projected[1]?.reasoning).toBe("Cross-referencing with the notes.");
    expect(projected[1]?.toolCalls).toEqual([
      { id: "c2", name: "memory_search" },
    ]);
  });

  it("drops non-final settled narration, keeping only the final settled line and the streaming segment (CL-3948)", () => {
    const segments: ChatMessage[] = [
      agent({
        id: "a1",
        content: "Narration one.",
        turnId: "g1",
        reasoning: "First thought.",
      }),
      agent({
        id: "a2",
        content: "Narration two.",
        turnId: "g1",
        toolCalls: [{ id: "c1", name: "crm_lookup", result: "found" }],
      }),
      agent({
        id: "a3",
        content: "",
        status: "sending",
        turnId: "g1",
        toolCalls: [{ id: "c2", name: "doc_build" }],
      }),
    ];
    const projected = projectLiveTurn(segments);
    // The non-final interstitial "Narration one." is dropped; only the final
    // settled line survives, stripped to outputs, plus the streaming segment.
    expect(projected.map((m) => m.id)).toEqual(["a2", "a3"]);
    expect(projected.some((m) => m.content === "Narration one.")).toBe(false);
    expect(projected[0]?.toolCalls).toBeUndefined();
    expect(projected[0]?.parts).toEqual([
      { type: "text", text: "Narration two." },
    ]);
    expect(projected[1]).toBe(segments[2]);
  });

  it("collapses interstitial narration while a turn is parked on an approval, keeping only the final line and the pending action (CL-3948)", () => {
    const segments: ChatMessage[] = [
      agent({
        id: "a1",
        content: "Let me check the records.",
        status: "sent",
        turnId: "g1",
      }),
      agent({
        id: "a2",
        content: "Let me look that up.",
        status: "sent",
        turnId: "g1",
        toolCalls: [{ id: "c1", name: "crm_lookup", result: "found" }],
      }),
      agent({
        id: "a3",
        content: "Got it. Let me log this as an issue in Linear.",
        status: "sent",
        turnId: "g1",
      }),
      agent({
        id: "a4",
        content: "",
        status: "sending",
        turnId: "g1",
        toolCalls: [{ id: "c2", name: "create_issue" }],
      }),
    ];
    const projected = projectLiveTurn(segments);
    // Only the final settled line and the parked tool-call segment survive.
    expect(projected.map((m) => m.id)).toEqual(["a3", "a4"]);
    expect(projected[0]?.content).toBe(
      "Got it. Let me log this as an issue in Linear.",
    );
    expect(
      projected.some((m) => m.content === "Let me check the records."),
    ).toBe(false);
    expect(projected.some((m) => m.content === "Let me look that up.")).toBe(
      false,
    );
    // The parked segment is untouched so its pending action card still renders.
    expect(projected[1]).toBe(segments[3]);
  });

  it("keeps a non-final settled segment carrying a UI block during the live phase (CL-3948)", () => {
    const blockContent = [
      "Here's the document.",
      "```ui",
      '{"kind":"document","title":"ABK Demo","source":"# Call"}',
      "```",
    ].join("\n");
    const segments: ChatMessage[] = [
      agent({
        id: "a1",
        content: "Let me draft it.",
        status: "sent",
        turnId: "g1",
      }),
      agent({
        id: "a2",
        content: blockContent,
        status: "sent",
        turnId: "g1",
        toolCalls: [{ id: "c1", name: "doc_build", result: "ok" }],
      }),
      agent({
        id: "a3",
        content: "Anything else?",
        status: "sent",
        turnId: "g1",
      }),
      agent({
        id: "a4",
        content: "",
        status: "sending",
        turnId: "g1",
        toolCalls: [{ id: "c2", name: "create_issue" }],
      }),
    ];
    const projected = projectLiveTurn(segments);
    // Block segment (product) survives; the "Let me draft it." narration is
    // dropped; the final settled line and the streaming segment remain.
    expect(projected.map((m) => m.id)).toEqual(["a2", "a3", "a4"]);
    expect(projected.some((m) => m.content === "Let me draft it.")).toBe(false);
    expect(projected[0]?.content).toBe(blockContent);
    expect(projected[0]?.toolCalls).toBeUndefined();
  });

  it("drops a settled reasoning-only segment that projects to no output (CL-3752)", () => {
    const segments: ChatMessage[] = [
      agent({
        id: "a1",
        content: "",
        turnId: "g1",
        reasoning: "Thinking about how to answer before saying anything.",
      }),
      agent({
        id: "a2",
        content: "Here is the answer.",
        status: "sending",
        turnId: "g1",
        parts: [{ type: "text", text: "Here is the answer." }],
      }),
    ];
    const projected = projectLiveTurn(segments);
    // The output-less reasoning-only step leaves no orphan turn behind; only
    // the streaming answer remains, so no empty turn reserves whitespace.
    expect(projected).toHaveLength(1);
    expect(projected[0]?.id).toBe("a2");
  });

  it("keeps a settled segment that produced only a file, even with empty text (CL-3752)", () => {
    const segments: ChatMessage[] = [
      agent({
        id: "a1",
        content: "",
        turnId: "g1",
        reasoning: "Generating the deck.",
        parts: [
          { type: "reasoning", text: "Generating the deck." },
          { type: "file", mediaType: "application/pdf", url: "blob:deck" },
        ],
      }),
      agent({
        id: "a2",
        content: "Done — deck attached above.",
        status: "sending",
        turnId: "g1",
        parts: [{ type: "text", text: "Done — deck attached above." }],
      }),
    ];
    const projected = projectLiveTurn(segments);
    expect(projected).toHaveLength(2);
    expect(projected[0]?.id).toBe("a1");
    expect(projected[0]?.parts).toEqual([
      { type: "file", mediaType: "application/pdf", url: "blob:deck" },
    ]);
  });

  it("when the streaming segment settles, projectSettledTurn re-derives the same final shape as a reload", () => {
    const liveSegments: ChatMessage[] = [
      agent({ id: "a1", content: "Let me look into that.", turnId: "g1" }),
      agent({
        id: "a2",
        content: "",
        status: "sending",
        turnId: "g1",
        toolCalls: [{ id: "c1", name: "crm_lookup" }],
      }),
    ];
    // Mid-stream: the streaming segment still carries its process fields.
    const midStream = projectLiveTurn(liveSegments);
    expect(midStream[1]?.toolCalls).toEqual([{ id: "c1", name: "crm_lookup" }]);
    // The segment settles with a final answer — no more "sending" status.
    const settledSegments: ChatMessage[] = [
      liveSegments[0]!,
      agent({
        id: "a2",
        content: "Here is the summary.",
        turnId: "g1",
        toolCalls: [{ id: "c1", name: "crm_lookup", result: "found" }],
      }),
    ];
    const finalFromSettle = projectSettledTurn(settledSegments);
    const finalFromReload = projectSettledTurn([...settledSegments]);
    expect(finalFromSettle).toEqual(finalFromReload);
    expect(finalFromSettle[0]?.content).toBe("Here is the summary.");
    expect(finalFromSettle[0]?.toolCalls).toBeUndefined();
  });
});
