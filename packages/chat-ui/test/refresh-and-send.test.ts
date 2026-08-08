// Pure-logic tests for the reviewed defects fixed on the chat surface. This
// suite runs in bun's bare test environment (no DOM), so instead of mounting
// components it exercises the pure rules the fixes turned on: exactly the
// same rules `chat-workspace.tsx`, `composer.tsx`, and
// `use-channel-stream.ts` call from inside their hooks.

import { describe, expect, test } from "bun:test";

import { canInviteAgent, nextMessagesState } from "../src/chat-workspace";
import type { MessagesState } from "../src/chat-workspace";
import { draftAfterSend } from "../src/composer";
import { shouldConnect } from "../src/use-channel-stream";

describe("nextMessagesState (B1: background refresh keeps the composer mounted)", () => {
  const ready: MessagesState = {
    kind: "ready",
    items: [
      {
        id: "m1",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: null, address: "prn_fixture1@agents.example" },
      },
    ],
  };

  test("a foreground load reflects a fresh success directly", () => {
    const next = nextMessagesState(
      { kind: "loading" },
      { kind: "success", items: [] },
      false,
    );
    expect(next).toEqual({ kind: "ready", items: [] });
  });

  test("a foreground load's failure replaces the view with an error state", () => {
    const next = nextMessagesState(
      ready,
      { kind: "error", message: "boom" },
      false,
    );
    expect(next).toEqual({ kind: "error", message: "boom" });
  });

  test("a background refresh never re-enters the loading state on success", () => {
    const next = nextMessagesState(ready, { kind: "success", items: [] }, true);
    expect(next.kind).toBe("ready");
  });

  test("a background refresh's failure leaves the previous ready items on screen", () => {
    const next = nextMessagesState(
      ready,
      { kind: "error", message: "boom" },
      true,
    );
    expect(next).toBe(ready);
    expect(next.kind).not.toBe("error");
  });

  test("a background refresh's failure never clobbers even a prior loading state", () => {
    const loading: MessagesState = { kind: "loading" };
    const next = nextMessagesState(
      loading,
      { kind: "error", message: "boom" },
      true,
    );
    expect(next).toBe(loading);
  });
});

describe("draftAfterSend (B2: a failed send keeps the draft)", () => {
  test("clears the draft once the send succeeds", () => {
    expect(draftAfterSend("hello", true)).toBe("");
  });

  test("keeps exactly what was typed when the send fails", () => {
    expect(draftAfterSend("hello there", false)).toBe("hello there");
  });
});

describe("canInviteAgent (a chat's agent is fixed at creation; the server 409s an invite into one)", () => {
  test("is false for a chat", () => {
    expect(canInviteAgent("chat")).toBe(false);
  });

  test("is true for a channel", () => {
    expect(canInviteAgent("channel")).toBe(true);
  });

  test("defaults true with no resolved channel yet", () => {
    expect(canInviteAgent(undefined)).toBe(true);
  });

  test("is true for a kind this UI doesn't otherwise recognize", () => {
    expect(canInviteAgent("archive")).toBe(true);
  });
});

describe("shouldConnect (S3: an empty channel url opens no connection)", () => {
  test("is false with no active channel", () => {
    expect(shouldConnect("")).toBe(false);
  });

  test("is true once a real stream url is known", () => {
    expect(shouldConnect("/api/tenants/tnt_1/chat/channels/c1/stream")).toBe(
      true,
    );
  });
});
