import { describe, expect, test } from "bun:test";

import { skillDisplayName } from "./skill-display-name";

describe("skillDisplayName", () => {
  test("title-cases a kebab slug when no display title is set", () => {
    expect(skillDisplayName({ name: "writing-system-prompts" })).toBe(
      "Writing System Prompts",
    );
    expect(skillDisplayName({ name: "triage" })).toBe("Triage");
  });

  test("prefers an explicit displayTitle over the slug", () => {
    expect(
      skillDisplayName({
        name: "writing-system-prompts",
        displayTitle: "Prompt writing",
      }),
    ).toBe("Prompt writing");
  });

  test("treats a whitespace-only displayTitle as absent", () => {
    expect(skillDisplayName({ name: "triage", displayTitle: "   " })).toBe(
      "Triage",
    );
  });
});
