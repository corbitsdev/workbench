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
  definition("memory_search", "Recall what was remembered"),
  definition("artifact_save", "Save a note as an artifact"),
];

const CONFIG = { visible: ["mail_*"], deferred: ["memory_*", "artifact_*"] };

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

test("a search surfaces the whole namespace it matched, and no other", () => {
  const selection = new DeferredToolSelection(DEFINITIONS, CONFIG);

  // "remember" only matches memory_write's description, but memory_search
  // comes along so the server pays one cache miss instead of two.
  selection.surface("remember");

  expect(selection.tools().map((tool) => tool.name)).toEqual([
    "mail_send",
    "tool_search",
    "memory_write",
    "memory_search",
  ]);
});

test("surfacing is append-only, so each turn's tools are a prefix of the next", () => {
  const selection = new DeferredToolSelection(DEFINITIONS, CONFIG);

  selection.surface("artifact");
  const afterFirst = selection.tools().map((tool) => tool.name);
  selection.surface("remember");
  const afterSecond = selection.tools().map((tool) => tool.name);
  selection.surface("artifact");

  expect(afterSecond.slice(0, afterFirst.length)).toEqual(afterFirst);
  expect(afterSecond).toEqual([...afterFirst, "memory_write", "memory_search"]);
  // A repeat search neither reorders nor duplicates what is already surfaced.
  expect(selection.tools().map((tool) => tool.name)).toEqual(afterSecond);
});

test("an empty query surfaces every deferred tool", () => {
  const selection = new DeferredToolSelection(DEFINITIONS, CONFIG);

  selection.surface("");

  expect(selection.tools()).toHaveLength(5);
});

test("a tool no pattern names stays visible rather than disappearing", () => {
  const selection = new DeferredToolSelection([definition("posix_read", "Read a file")], CONFIG);

  expect(selection.tools().map((tool) => tool.name)).toEqual(["posix_read", "tool_search"]);
});
