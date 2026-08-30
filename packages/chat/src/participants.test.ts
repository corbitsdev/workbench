import { describe, expect, test } from "bun:test";
import { addParticipant, dedupeHandle, handleFromName } from "./participants";

describe("addParticipant", () => {
  test("appends a new address and de-duplicates the handle", () => {
    const existing = [{ address: "a@x", handle: "echo" }];
    expect(addParticipant(existing, "b@x", "echo")).toEqual([
      { address: "a@x", handle: "echo" },
      { address: "b@x", handle: "echo-2" },
    ]);
  });

  test("same-address retries return the existing list by identity", () => {
    const existing = [{ address: "a@x", handle: "echo" }];
    expect(addParticipant(existing, "a@x", "echo")).toBe(existing);
  });
});

describe("handleFromName / dedupeHandle", () => {
  test("slugs a display name and falls back to the address local part", () => {
    expect(handleFromName("Content Researcher", "run_1@x")).toBe(
      "content-researcher",
    );
    expect(handleFromName("!!!", "run_scout@x")).toBe("run_scout");
  });

  test("suffixes the first free handle", () => {
    expect(dedupeHandle("echo", new Set(["echo", "echo-2"]))).toBe("echo-3");
  });
});
