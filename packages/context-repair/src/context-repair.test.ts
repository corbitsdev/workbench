import { describe, expect, it } from "bun:test";
import type { ConversationTurn } from "@intx/types/runtime";

import { stripUnsendableAssistantTurns } from "./context-repair";

function user(text: string): ConversationTurn {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

describe("stripUnsendableAssistantTurns", () => {
  it("removes an assistant turn with neither text nor tool calls", () => {
    // A reasoning-only turn (thinking blocks, no text, no tool call) marshals
    // to `{ content: null }` with no tool_calls — DeepSeek and other
    // OpenAI-compatible providers reject it ("content or tool_calls must be
    // set"), poisoning every replay until it is removed.
    const turns: ConversationTurn[] = [
      user("hi"),
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "hmm" }],
        timestamp: 2,
      },
      user("still there?"),
    ];

    const result = stripUnsendableAssistantTurns(turns);

    expect(result.removedCount).toBe(1);
    expect(result.turns).toHaveLength(2);
    expect(result.turns.some((t) => t.role === "assistant")).toBe(false);
  });

  it("removes an assistant turn with an empty content array", () => {
    const turns: ConversationTurn[] = [
      user("hi"),
      { role: "assistant", content: [], timestamp: 2 },
    ];

    const result = stripUnsendableAssistantTurns(turns);

    expect(result.removedCount).toBe(1);
    expect(result.turns).toHaveLength(1);
  });

  it("keeps an assistant turn that has text", () => {
    const turns: ConversationTurn[] = [
      user("hi"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "hello" },
        ],
        timestamp: 2,
      },
    ];

    const result = stripUnsendableAssistantTurns(turns);

    expect(result.removedCount).toBe(0);
    expect(result.turns).toBe(turns);
  });

  it("keeps an assistant turn that only has a tool call", () => {
    const turns: ConversationTurn[] = [
      user("look it up"),
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "tc_1",
            name: "search",
            arguments: { q: "x" },
          },
        ],
        timestamp: 2,
      },
    ];

    const result = stripUnsendableAssistantTurns(turns);

    expect(result.removedCount).toBe(0);
    expect(result.turns).toHaveLength(2);
  });

  it("removes an assistant turn holding only redacted_thinking", () => {
    // The OpenAI adapter ignores redacted_thinking when building an assistant
    // message, so a turn with only that block still marshals to a null body.
    const turns: ConversationTurn[] = [
      user("hi"),
      {
        role: "assistant",
        content: [{ type: "redacted_thinking", data: "opaque" }],
        timestamp: 2,
      },
    ];

    expect(stripUnsendableAssistantTurns(turns).removedCount).toBe(1);
  });

  it("removes an assistant turn holding only an image", () => {
    // Images are sendable on user turns but ignored on assistant turns, so an
    // image-only assistant turn is unsendable on this provider path.
    const turns: ConversationTurn[] = [
      user("hi"),
      {
        role: "assistant",
        content: [
          {
            type: "image",
            source: {
              kind: "url",
              mimeType: "image/png",
              url: "https://x/y.png",
            },
          },
        ],
        timestamp: 2,
      },
    ];

    expect(stripUnsendableAssistantTurns(turns).removedCount).toBe(1);
  });

  it("keeps a mixed refusal-plus-text assistant turn (not this fix’s failure mode)", () => {
    // A refusal block is an adapter-throw concern, deliberately out of scope.
    // Because the turn also carries text it is kept; widening the predicate to
    // strip refusals would silently drop semantic content.
    const turns: ConversationTurn[] = [
      user("do the thing"),
      {
        role: "assistant",
        content: [
          { type: "refusal", reason: "I will not" },
          { type: "text", text: "here is why" },
        ],
        timestamp: 2,
      },
    ];

    expect(stripUnsendableAssistantTurns(turns).removedCount).toBe(0);
  });

  it("never removes user or system turns even when empty", () => {
    const turns: ConversationTurn[] = [
      { role: "system", content: [], timestamp: 1 },
      { role: "user", content: [], timestamp: 2 },
    ];

    const result = stripUnsendableAssistantTurns(turns);

    expect(result.removedCount).toBe(0);
    expect(result.turns).toBe(turns);
  });

  it("returns the same array reference when nothing is removed", () => {
    const turns: ConversationTurn[] = [user("hi")];
    expect(stripUnsendableAssistantTurns(turns).turns).toBe(turns);
  });
});
