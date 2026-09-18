import { describe, expect, test } from "bun:test";

import { appendRoster, stripRoster } from "./room-roster";

describe("appendRoster / stripRoster", () => {
  test("round-trips a message through append and strip", () => {
    const body = "Please pass this to the scribe.";
    const withRoster = appendRoster(body, [
      { name: "Scribe", address: "run_abc@room.example", kind: "agent" },
      { name: "Myra", address: "run_def@room.example", kind: "agent" },
    ]);
    expect(withRoster).toBe(
      "Please pass this to the scribe.\n\nParticipants:\nScribe <run_abc@room.example>\nMyra <run_def@room.example>",
    );
    expect(stripRoster(withRoster)).toBe(body);
  });

  test("is a no-op with no entries", () => {
    expect(appendRoster("hello", [])).toBe("hello");
    expect(stripRoster("hello")).toBe("hello");
  });

  test("appends a cc instruction naming the person, and strips it too", () => {
    const body = "Please pass this to the scribe.";
    const withRoster = appendRoster(body, [
      { name: "Alice", address: "alice@example.com", kind: "person" },
      { name: "Scribe", address: "run_abc@example.com", kind: "agent" },
    ]);
    expect(withRoster).toBe(
      "Please pass this to the scribe.\n\n" +
        "Participants:\nAlice <alice@example.com>\nScribe <run_abc@example.com>\n\n" +
        'When you mail another participant, pass `to` as a list with them and the person, e.g. `to: ["<their address>", "alice@example.com"]`, never one comma-joined string, and give every mail a short subject.',
    );
    expect(stripRoster(withRoster)).toBe(body);
  });

  test("names every person when more than one is in the roster", () => {
    const withRoster = appendRoster("hi", [
      { name: "Alice", address: "alice@example.com", kind: "person" },
      { name: "Bob", address: "bob@example.com", kind: "person" },
      { name: "Scribe", address: "run_abc@example.com", kind: "agent" },
    ]);
    expect(withRoster).toContain(
      '`to: ["<their address>", "alice@example.com", "bob@example.com"]`',
    );
  });
});
