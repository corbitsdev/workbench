/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  findUnresolvedToolCalls,
  parseThreadTurns,
  singleUnresolvedToolCall,
  type ThreadTurn,
} from "./unresolved-tool-call";

type PartInput = {
  type: string;
  metadata?: Record<string, unknown> | null;
};

function turn(parts: PartInput[]): ThreadTurn {
  return {
    parts: parts.map((p) => ({
      type: p.type,
      metadata: p.metadata ?? null,
    })),
  };
}

function callPart(
  callId: string,
  name: string,
  args?: Record<string, unknown>,
): PartInput {
  return {
    type: "tool",
    metadata: { kind: "call", callId, name, arguments: args ?? {} },
  };
}

function resultPart(callId: string): PartInput {
  return { type: "tool", metadata: { kind: "result", callId } };
}

describe("findUnresolvedToolCalls", () => {
  it("returns a tool call that has no matching result (a suspended call)", () => {
    const turns = [
      turn([callPart("c1", "linear__create_issue", { title: "x" })]),
    ];
    const unresolved = findUnresolvedToolCalls(turns);
    expect(unresolved).toEqual([
      { callId: "c1", name: "linear__create_issue", arguments: { title: "x" } },
    ]);
  });

  it("excludes a call whose result arrived in a later turn", () => {
    const turns = [turn([callPart("c1", "search")]), turn([resultPart("c1")])];
    expect(findUnresolvedToolCalls(turns)).toEqual([]);
  });

  it("dedupes a re-emitted call part by callId so it counts once", () => {
    const turns = [
      turn([callPart("c1", "slack__post_message", { channel: "#a" })]),
      turn([callPart("c1", "slack__post_message", { channel: "#a" })]),
    ];
    expect(findUnresolvedToolCalls(turns)).toHaveLength(1);
  });

  it("ignores tool result parts with no callId and non-object arguments", () => {
    const turns = [
      turn([
        { type: "tool", metadata: { kind: "call", callId: "c1", name: "t" } },
        { type: "text", metadata: null },
      ]),
    ];
    expect(findUnresolvedToolCalls(turns)).toEqual([
      { callId: "c1", name: "t", arguments: {} },
    ]);
  });
});

describe("singleUnresolvedToolCall", () => {
  it("returns the call when exactly one is unresolved", () => {
    const turns = [turn([callPart("c1", "mail_send", { to: "a@x.com" })])];
    expect(singleUnresolvedToolCall(turns)).toEqual({
      callId: "c1",
      name: "mail_send",
      arguments: { to: "a@x.com" },
    });
  });

  it("returns null when two calls are unresolved (no-mismatch guard)", () => {
    const turns = [
      turn([
        callPart("c1", "mail_send"),
        callPart("c2", "slack__post_message"),
      ]),
    ];
    expect(singleUnresolvedToolCall(turns)).toBeNull();
  });

  it("returns null when there are no unresolved calls", () => {
    const turns = [turn([callPart("c1", "search"), resultPart("c1")])];
    expect(singleUnresolvedToolCall(turns)).toBeNull();
  });
});

describe("parseThreadTurns", () => {
  it("parses a well-formed /turns response", () => {
    const raw = { data: [turn([callPart("c1", "mail_send")])] };
    const parsed = parseThreadTurns(raw);
    expect(parsed).toHaveLength(1);
    expect(singleUnresolvedToolCall(parsed)?.name).toBe("mail_send");
  });

  it("throws on a malformed payload rather than silently returning empty", () => {
    expect(() => parseThreadTurns({ data: "nope" })).toThrow(
      /Invalid thread turns response/,
    );
  });
});
