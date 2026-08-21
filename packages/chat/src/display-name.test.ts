import { describe, expect, test } from "bun:test";
import { deriveDisplayName, humanizeSlug } from "./display-name";

describe("humanizeSlug", () => {
  test("title-cases a hyphenated slug", () => {
    expect(humanizeSlug("research-analyst")).toBe("Research Analyst");
  });

  test("title-cases an underscored slug", () => {
    expect(humanizeSlug("architecture_reviewer")).toBe("Architecture Reviewer");
  });

  test("passes prose through with only case fixed up", () => {
    expect(humanizeSlug("myra")).toBe("Myra");
  });
});

describe("deriveDisplayName", () => {
  test("prefers a non-blank description over the slug", () => {
    expect(
      deriveDisplayName({
        name: "architecture-reviewer",
        description: "Architecture reviewer",
      }),
    ).toBe("Architecture reviewer");
  });

  test("humanizes the slug when description is absent or blank", () => {
    expect(deriveDisplayName({ name: "architecture-reviewer" })).toBe(
      "Architecture Reviewer",
    );
    expect(
      deriveDisplayName({ name: "architecture-reviewer", description: "   " }),
    ).toBe("Architecture Reviewer");
  });

  test("throws rather than humanizing an internal run id into a fake name (CL-6471)", () => {
    expect(() =>
      deriveDisplayName({ name: "run_737a058d48006e2bde12559576f422e0" }),
    ).toThrow(/internal identifier/);
  });

  test("throws when the description itself is an internal id", () => {
    expect(() =>
      deriveDisplayName({
        name: "architecture-reviewer",
        description: "run_737a058d48006e2bde12559576f422e0",
      }),
    ).toThrow(/internal identifier/);
  });

  test('throws on a malformed shape rather than rendering "undefined"', () => {
    expect(() => deriveDisplayName({} as { name: string })).toThrow();
  });
});
