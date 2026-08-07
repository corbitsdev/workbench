import { describe, expect, test } from "bun:test";

import {
  activeMentionQuery,
  filterMentionCandidates,
  insertMention,
  mentionCandidatesFromParticipants,
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

describe("mentionCandidatesFromParticipants", () => {
  test("keeps only agent-address participants, keyed by the local part", () => {
    expect(
      mentionCandidatesFromParticipants([
        "researcher@agents.example",
        "user_abc123",
        "launch-planner@agents.example",
      ]),
    ).toEqual([
      {
        id: "researcher@agents.example",
        handle: "researcher",
        label: "Researcher",
      },
      {
        id: "launch-planner@agents.example",
        handle: "launch-planner",
        label: "Launch Planner",
      },
    ]);
  });

  test("returns nothing when no participant is an agent address", () => {
    expect(mentionCandidatesFromParticipants(["user_abc123"])).toEqual([]);
  });
});

describe("filterMentionCandidates", () => {
  const agents = [
    { id: "1", handle: "researcher", label: "Researcher" },
    { id: "2", handle: "reviewer", label: "Reviewer" },
    { id: "3", handle: "summarizer", label: "Summarizer" },
  ];

  test("matches by case-insensitive prefix on the handle", () => {
    expect(filterMentionCandidates(agents, "re")).toEqual(
      agents.filter((agent) => agent.handle.startsWith("re")),
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
      "researcher",
    );
    expect(result.text).toBe("hi @researcher ");
    expect(result.caret).toBe(result.text.length);
  });

  test("preserves text after the caret", () => {
    const result = insertMention(
      "hi @re please",
      6,
      { start: 3, query: "re" },
      "researcher",
    );
    expect(result.text).toBe("hi @researcher  please");
  });
});
