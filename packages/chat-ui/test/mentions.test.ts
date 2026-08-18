import { describe, expect, test } from "bun:test";

import {
  activeMentionQuery,
  bringInOptionsFromMembersAndAgents,
  filterMentionCandidates,
  filterMentionOptions,
  insertMention,
  mentionCandidatesFromParticipants,
  mentionOptionsFromChannel,
} from "../src/mentions";

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
  test("keeps only agent-address participants, keyed by their own handle", () => {
    expect(
      mentionCandidatesFromParticipants([
        { address: "researcher@agents.example", handle: "researcher" },
        { address: "user_abc123", handle: "user_abc123" },
        { address: "launch-planner@agents.example", handle: "launch-planner" },
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

  test("a handle friendlier than the local part is used verbatim", () => {
    expect(
      mentionCandidatesFromParticipants([
        { address: "ins_cd03d8e3@agents.example", handle: "echo" },
      ]),
    ).toEqual([
      { id: "ins_cd03d8e3@agents.example", handle: "echo", label: "Echo" },
    ]);
  });

  test("returns nothing when no participant is an agent address", () => {
    expect(
      mentionCandidatesFromParticipants([
        { address: "user_abc123", handle: "user_abc123" },
      ]),
    ).toEqual([]);
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

describe("bringInOptionsFromMembersAndAgents (CL-5879 mention-pulls-in)", () => {
  const participants = [
    { address: "researcher@agents.example", handle: "researcher" },
    { address: "prn_alice", handle: "alice" },
  ];

  test("a workspace member already in the channel is excluded", () => {
    const options = bringInOptionsFromMembersAndAgents(
      [
        { id: "prn_alice", displayName: "Alice" },
        { id: "prn_bob", displayName: "Bob" },
      ],
      [],
      participants,
    );
    expect(options).toEqual([
      {
        section: "people",
        candidate: { id: "prn_bob", handle: "bob", label: "Bob" },
        invite: { kind: "person", principalId: "prn_bob", name: "Bob" },
      },
    ]);
  });

  test("an invitable agent uses its name — never its description — as the label", () => {
    const options = bringInOptionsFromMembersAndAgents(
      [],
      [
        {
          id: "wfd_echo",
          name: "echo",
          description: "You turn a conversation into a website proposal…",
        },
      ],
      participants,
    );
    expect(options).toEqual([
      {
        section: "agents",
        candidate: { id: "wfd_echo", handle: "echo", label: "echo" },
        invite: { kind: "agent", definitionId: "wfd_echo" },
      },
    ]);
  });
});

describe("mentionOptionsFromChannel and filterMentionOptions (CL-5879 mention-pulls-in)", () => {
  test("lists Agents then People, in-channel ahead of bring-in within each section", () => {
    const options = mentionOptionsFromChannel(
      [
        { address: "researcher@agents.example", handle: "researcher" },
        { address: "prn_alice", handle: "alice" },
      ],
      [{ id: "prn_bob", displayName: "Bob" }],
      [{ id: "wfd_echo", name: "echo", description: "Echo" }],
    );
    expect(options.map((option) => option.section)).toEqual([
      "agents",
      "agents",
      "people",
      "people",
    ]);
    expect(options.map((option) => option.candidate.handle)).toEqual([
      "researcher",
      "echo",
      "alice",
      "bob",
    ]);
  });

  test("filterMentionOptions narrows both sections by the same prefix rule", () => {
    const options = mentionOptionsFromChannel(
      [{ address: "researcher@agents.example", handle: "researcher" }],
      [{ id: "prn_reed", displayName: "Reed" }],
      [{ id: "wfd_echo", name: "echo", description: "Echo" }],
    );
    const filtered = filterMentionOptions(options, "re");
    expect(filtered.map((option) => option.candidate.handle)).toEqual([
      "researcher",
      "reed",
    ]);
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
