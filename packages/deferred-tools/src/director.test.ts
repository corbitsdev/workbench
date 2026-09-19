import { expect, test } from "bun:test";
import type { ToolDefinition } from "@intx/types/runtime";

import { DeferredToolSelection } from "./director";
import { matchesNamePattern } from "./match";

function definition(name: string, description: string): ToolDefinition {
  return { name, description, inputSchema: {} };
}

const DEFINITIONS: readonly ToolDefinition[] = [
  definition("mail_send", "Send mail"),
  definition("memory_write", "Remember a fact for later"),
  definition("artifact_save", "Save a note as an artifact"),
];

const CONFIG = { visible: ["mail_*"], deferred: ["memory_*", "artifact_save"] };

test("a pattern's star spans any run of characters and its dots stay literal", () => {
  expect(matchesNamePattern("memory_write", "memory_*")).toBe(true);
  expect(matchesNamePattern("memory", "memory_*")).toBe(false);
  expect(matchesNamePattern("exa.search", "exa.*")).toBe(true);
  expect(matchesNamePattern("exaXsearch", "exa.*")).toBe(false);
  expect(matchesNamePattern("mail_send", "mail_send")).toBe(true);
});

test("the first turn sends the non-deferred tools plus tool_search, and nothing deferred", () => {
  const selection = new DeferredToolSelection(DEFINITIONS, CONFIG);

  expect(selection.tools().map((tool) => tool.name)).toEqual(["mail_send", "tool_search"]);
});

test("a search surfaces what it matched, and only that", () => {
  const selection = new DeferredToolSelection(DEFINITIONS, CONFIG);

  selection.surface("remember");

  expect(selection.tools().map((tool) => tool.name)).toEqual([
    "mail_send",
    "tool_search",
    "memory_write",
  ]);
});

test("an empty query surfaces every deferred tool", () => {
  const selection = new DeferredToolSelection(DEFINITIONS, CONFIG);

  selection.surface("");

  expect(selection.tools()).toHaveLength(4);
});

test("a tool no pattern names stays visible rather than disappearing", () => {
  const selection = new DeferredToolSelection([definition("posix_read", "Read a file")], CONFIG);

  expect(selection.tools().map((tool) => tool.name)).toEqual(["posix_read", "tool_search"]);
});
