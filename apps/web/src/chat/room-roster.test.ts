import { describe, expect, test } from "bun:test";

import { appendRoster, stripRoster } from "./room-roster";

describe("appendRoster / stripRoster", () => {
  test("round-trips a message through append and strip", () => {
    const body = "Please pass this to the scribe.";
    const withRoster = appendRoster(body, [
      { name: "Scribe", address: "run_abc@room.example" },
      { name: "Myra", address: "run_def@room.example" },
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
});
