import { expect, test } from "bun:test";

import { findNewAgentReply } from "./real-target.ts";

function textMessage(id: string, address: string, text: string) {
  return { id, sender: { address }, parts: [{ kind: "text", text }] };
}

test("finds a fresh agent-authored text message not yet seen", () => {
  const items = [
    textMessage("m1", "user:1", "hello"),
    textMessage("m2", "agent:myra", "hi there"),
  ];
  const found = findNewAgentReply(items, "agent:myra", new Set());
  expect(found?.id).toBe("m2");
});

test("ignores a message already recorded as seen", () => {
  const items = [textMessage("m1", "agent:myra", "hi there")];
  const found = findNewAgentReply(items, "agent:myra", new Set(["m1"]));
  expect(found).toBeUndefined();
});

test("ignores a message from someone other than the agent", () => {
  const items = [textMessage("m1", "user:1", "hello again")];
  const found = findNewAgentReply(items, "agent:myra", new Set());
  expect(found).toBeUndefined();
});

test("ignores a part-less or text-less agent message (e.g. tool-only turn in flight)", () => {
  const items = [
    {
      id: "m1",
      sender: { address: "agent:myra" },
      parts: [{ kind: "tool_call" }],
    },
  ];
  const found = findNewAgentReply(items, "agent:myra", new Set());
  expect(found).toBeUndefined();
});

test("returns the first unseen agent message when several are new", () => {
  const items = [
    textMessage("m1", "agent:myra", "first"),
    textMessage("m2", "agent:myra", "second"),
  ];
  const found = findNewAgentReply(items, "agent:myra", new Set());
  expect(found?.id).toBe("m1");
});
