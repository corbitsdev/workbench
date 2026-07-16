import { describe, expect, test } from "bun:test";
import {
  catalogToolNamesForPackages,
  narrowMyraToolNamesByMemberPreference,
} from "./myra-tool-narrowing";

describe("narrowMyraToolNamesByMemberPreference", () => {
  const granted = [
    "search_tools",
    "load_tools",
    "attio__query_records",
    "linear__list_issues",
    "memory_save",
  ];

  test("absent preference (empty disables) returns full grant set", () => {
    expect(narrowMyraToolNamesByMemberPreference(granted, [], [])).toEqual(
      granted,
    );
  });

  test("disabled package removes every tool in that package", () => {
    const attioTools = [...catalogToolNamesForPackages(new Set(["attio"]))];
    expect(attioTools.length).toBeGreaterThan(0);
    const narrowed = narrowMyraToolNamesByMemberPreference(
      granted,
      ["attio"],
      [],
    );
    expect(narrowed).not.toContain("attio__query_records");
    expect(narrowed).toContain("linear__list_issues");
  });

  test("disabled individual tool within an enabled package", () => {
    const narrowed = narrowMyraToolNamesByMemberPreference(
      granted,
      [],
      ["linear__list_issues"],
    );
    expect(narrowed).not.toContain("linear__list_issues");
    expect(narrowed).toContain("attio__query_records");
  });

  test("intersection never widens grants", () => {
    const narrowed = narrowMyraToolNamesByMemberPreference(
      granted,
      [],
      ["not_in_grants__foo"],
    );
    expect(narrowed).toEqual(granted);
  });
});
