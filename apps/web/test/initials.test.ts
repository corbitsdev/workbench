// The sidebar's account affordance renders initials (never an id, never a
// network-fetched avatar), and the initials derivation holds up against
// thin accounts.

import { describe, expect, test } from "bun:test";

import { initialsOf } from "../src/shell/docks";

describe("initialsOf", () => {
  test("takes the first letters of the account name", () => {
    expect(initialsOf("Ada Lovelace", "ada@example.com")).toBe("AL");
  });

  test("falls back to the email local part when the name is blank", () => {
    expect(initialsOf("", "grace.hopper@example.com")).toBe("GH");
    expect(initialsOf("  ", "ada@example.com")).toBe("A");
  });

  test("never yields an empty avatar", () => {
    expect(initialsOf("", "@example.com")).toBe("··");
  });
});
