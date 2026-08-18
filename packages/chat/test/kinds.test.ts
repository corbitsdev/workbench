import { expect, test } from "bun:test";
import { presetForKind } from "../src/kinds";

test("a durable workbench kind pins by default", () => {
  expect(presetForKind("workbench").pinned).toBe(true);
});

test("a throwaway chat kind does not pin by default", () => {
  expect(presetForKind("chat").pinned).toBe(false);
});

test("an unrecognized kind is accepted data with chat-like defaults", () => {
  expect(presetForKind("standup")).toEqual(presetForKind("chat"));
});
