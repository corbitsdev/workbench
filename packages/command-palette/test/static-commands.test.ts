import { describe, expect, test } from "bun:test";

import { buildStaticCommands, matchesQuery } from "../src/static-commands";

describe("buildStaticCommands", () => {
  test("maps real routes to commands, one per route, in order", () => {
    const commands = buildStaticCommands([
      { path: "/", label: "Home" },
      { path: "/chat", label: "Chat" },
    ]);
    expect(commands).toEqual([
      { id: "route:/", title: "Home", category: "pages", path: "/" },
      { id: "route:/chat", title: "Chat", category: "pages", path: "/chat" },
    ]);
  });

  test("never fabricates a route beyond what it is given", () => {
    const commands = buildStaticCommands([]);
    expect(commands).toEqual([]);
  });
});

describe("matchesQuery", () => {
  test("is case-insensitive and matches substrings anywhere in the title", () => {
    expect(matchesQuery("Settings", "sett")).toBe(true);
    expect(matchesQuery("Settings", "TINGS")).toBe(true);
  });

  test("an empty query matches everything", () => {
    expect(matchesQuery("Settings", "")).toBe(true);
    expect(matchesQuery("Settings", "   ")).toBe(true);
  });

  test("rejects a title that does not contain the query", () => {
    expect(matchesQuery("Settings", "zzz")).toBe(false);
  });
});
