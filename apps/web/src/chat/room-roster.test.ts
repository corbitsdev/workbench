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
      { name: "Sawyer", address: "usr_sawyer@room.example", kind: "person" },
      { name: "Scribe", address: "run_abc@room.example", kind: "agent" },
    ]);
    expect(withRoster).toBe(
      "Please pass this to the scribe.\n\n" +
        "Participants:\nSawyer <usr_sawyer@room.example>\nScribe <run_abc@room.example>\n\n" +
        "Copy usr_sawyer@room.example in `to` on any mail you send another participant, so they can follow along, and give every mail a short subject.",
    );
    expect(stripRoster(withRoster)).toBe(body);
  });

  test("names every person when more than one is in the roster", () => {
    const withRoster = appendRoster("hi", [
      { name: "Sawyer", address: "usr_sawyer@room.example", kind: "person" },
      { name: "Alex", address: "usr_alex@room.example", kind: "person" },
      { name: "Scribe", address: "run_abc@room.example", kind: "agent" },
    ]);
    expect(withRoster).toContain(
      "Copy usr_sawyer@room.example, usr_alex@room.example in `to` on any mail you send another participant, so they can follow along, and give every mail a short subject.",
    );
  });
});
