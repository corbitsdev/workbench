// The Library page's domain rules, tested at the seam: parsing, sorting,
// and filtering never touch a network call, so they are exercised directly
// against fixture `ArtifactSummary` rows.

import { describe, expect, test } from "bun:test";

import { ArtifactSummary, filterArtifacts, sortArtifacts } from "../src/index";

function artifact(
  overrides: Partial<ArtifactSummary> & { readonly id: string },
): ArtifactSummary {
  return {
    title: "Untitled",
    kind: "document",
    ownerName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ArtifactSummary", () => {
  test("parses a valid wire row", () => {
    const parsed = ArtifactSummary({
      id: "art_1",
      title: "Q3 report",
      kind: "deck",
      ownerName: "Ada",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed).not.toBeInstanceOf(Error);
  });

  test("rejects a row missing a required field", () => {
    const parsed = ArtifactSummary({ id: "art_1" });
    expect(
      parsed instanceof Error || "id" in Object(parsed) === false,
    ).toBeTruthy();
  });
});

describe("sortArtifacts", () => {
  const older = artifact({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" });
  const newer = artifact({ id: "b", createdAt: "2026-02-01T00:00:00.000Z" });

  test("newest first by default ordering", () => {
    expect(sortArtifacts([older, newer], "newest").map((a) => a.id)).toEqual([
      "b",
      "a",
    ]);
  });

  test("oldest first when asked", () => {
    expect(sortArtifacts([newer, older], "oldest").map((a) => a.id)).toEqual([
      "a",
      "b",
    ]);
  });

  test("does not mutate the input array", () => {
    const input = [newer, older];
    sortArtifacts(input, "oldest");
    expect(input).toEqual([newer, older]);
  });
});

describe("filterArtifacts", () => {
  const report = artifact({ id: "a", title: "Q3 report", kind: "deck" });
  const csv = artifact({ id: "b", title: "Signups export", kind: "csv" });

  test("an empty query keeps every artifact", () => {
    expect(filterArtifacts([report, csv], "")).toEqual([report, csv]);
  });

  test("matches on title, case-insensitively", () => {
    expect(filterArtifacts([report, csv], "q3").map((a) => a.id)).toEqual([
      "a",
    ]);
  });

  test("matches on kind too", () => {
    expect(filterArtifacts([report, csv], "csv").map((a) => a.id)).toEqual([
      "b",
    ]);
  });

  test("no match empties the result rather than falling back to all", () => {
    expect(filterArtifacts([report, csv], "nonexistent")).toEqual([]);
  });
});
