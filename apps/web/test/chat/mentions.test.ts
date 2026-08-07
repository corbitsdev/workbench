import { describe, expect, test } from "bun:test";

import {
  activeMentionQuery,
  filterMentionCandidates,
  insertMention,
} from "../../src/chat/mentions";

describe("activeMentionQuery", () => {
  test("detects an open mention right after the @", () => {
    expect(activeMentionQuery("hi @re", 6)).toEqual({ start: 3, query: "re" });
  });

  test("is null with no @ before the caret", () => {
    expect(activeMentionQuery("hello there", 5)).toBeNull();
  });

  test("closes once whitespace follows the @", () => {
    expect(activeMentionQuery("hi @bot now", 11)).toBeNull();
  });

  test("ignores an email-shaped @ (preceded by a word character)", () => {
    expect(activeMentionQuery("mail me at a@b", 14)).toBeNull();
  });

  test("matches a bare @ with an empty query", () => {
    expect(activeMentionQuery("@", 1)).toEqual({ start: 0, query: "" });
  });
});

describe("filterMentionCandidates", () => {
  const agents = [
    { id: "1", name: "Researcher" },
    { id: "2", name: "Reviewer" },
    { id: "3", name: "Summarizer" },
  ];

  test("matches by case-insensitive prefix", () => {
    expect(filterMentionCandidates(agents, "re")).toEqual(
      agents.filter((agent) => agent.name.startsWith("Re")),
    );
  });

  test("an empty query matches every agent", () => {
    expect(filterMentionCandidates(agents, "")).toEqual(agents);
  });

  test("no match returns an empty list", () => {
    expect(filterMentionCandidates(agents, "zzz")).toEqual([]);
  });
});

describe("insertMention", () => {
  test("splices the mention in with a trailing space and advances the caret", () => {
    const result = insertMention(
      "hi @re",
      6,
      { start: 3, query: "re" },
      "Researcher",
    );
    expect(result.text).toBe("hi @Researcher ");
    expect(result.caret).toBe(result.text.length);
  });

  test("preserves text after the caret", () => {
    const result = insertMention(
      "hi @re please",
      6,
      { start: 3, query: "re" },
      "Researcher",
    );
    expect(result.text).toBe("hi @Researcher  please");
  });
});
