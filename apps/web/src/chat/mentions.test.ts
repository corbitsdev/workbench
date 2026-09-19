import { describe, expect, test } from "bun:test";

import { activeMention, applyMention, mentionedAgents } from "./mentions";

const roster = [{ name: "Researcher" }, { name: "Writer" }, { name: "Writer Two" }];

describe("mentionedAgents", () => {
  test("resolves a name to its roster entry", () => {
    expect(mentionedAgents("@Writer reply with one word", roster)).toEqual([{ name: "Writer" }]);
  });

  test("ignores a name nothing in the roster answers to", () => {
    expect(mentionedAgents("@Nobody are you there", roster)).toEqual([]);
  });

  test("resolves several mentions, case-insensitively", () => {
    expect(mentionedAgents("@researcher and @Writer, compare notes", roster)).toEqual([
      { name: "Researcher" },
      { name: "Writer" },
    ]);
  });

  test("prefers the longest matching name", () => {
    expect(mentionedAgents("@Writer Two please draft it", roster)).toEqual([
      { name: "Writer Two" },
    ]);
  });

  test("does not treat an address local part as a mention", () => {
    expect(mentionedAgents("mail me at carol@writer.example.com", roster)).toEqual([]);
  });
});

describe("activeMention / applyMention", () => {
  test("reads the mention being typed at the caret", () => {
    expect(activeMention("hey @wri", 8)).toEqual({ start: 4, query: "wri" });
    expect(activeMention("hey there", 9)).toBeUndefined();
  });

  test("replaces the typed fragment with the full token", () => {
    const mention = activeMention("hey @wri", 8);
    expect(mention).toBeDefined();
    expect(applyMention("hey @wri", mention!, "Writer", 8)).toEqual({
      text: "hey @Writer ",
      caret: 12,
    });
  });
});
