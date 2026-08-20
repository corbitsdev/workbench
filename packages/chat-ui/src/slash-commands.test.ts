import { describe, expect, test } from "bun:test";

import {
  SLASH_COMMANDS,
  activeSlashQuery,
  filterSlashCommands,
} from "./slash-commands";

describe("activeSlashQuery", () => {
  test("detects an open command right after the /", () => {
    expect(activeSlashQuery("/inv", 4)).toEqual({ start: 0, query: "inv" });
  });

  test("matches a bare / with an empty query", () => {
    expect(activeSlashQuery("/", 1)).toEqual({ start: 0, query: "" });
  });

  test("closes once whitespace follows the command token", () => {
    expect(activeSlashQuery("/invite now", 11)).toBeNull();
  });

  test("is null for a / that is not the first character", () => {
    expect(activeSlashQuery("see /invite", 11)).toBeNull();
  });

  test("is null when the caret has moved past the token onto the rest of the line", () => {
    expect(activeSlashQuery("/invite please", 8)).toBeNull();
  });

  test("is null for an empty draft", () => {
    expect(activeSlashQuery("", 0)).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  test("matches by case-insensitive prefix on the command id", () => {
    expect(filterSlashCommands("inv").map((c) => c.id)).toEqual(["invite"]);
    expect(filterSlashCommands("INV").map((c) => c.id)).toEqual(["invite"]);
  });

  test("an empty query matches every command", () => {
    expect(filterSlashCommands("")).toEqual(SLASH_COMMANDS);
  });

  test("no match returns an empty list", () => {
    expect(filterSlashCommands("zzz")).toEqual([]);
  });

  test("the catalog omits /thread, /status, and /pin — no real action behind them today", () => {
    const ids = SLASH_COMMANDS.map((c) => c.id);
    expect(ids).not.toContain("thread");
    expect(ids).not.toContain("status");
    expect(ids).not.toContain("pin");
    expect(ids).toEqual([
      "invite",
      "summarize",
      "run",
      "routine",
      "agents",
      "help",
    ]);
  });
});
