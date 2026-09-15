import { describe, expect, test } from "bun:test";

import { DEFAULT_SKILLS } from "./default-skills";

describe("DEFAULT_SKILLS", () => {
  test("keeps the writing-system-prompts slug as the registry id", () => {
    expect(DEFAULT_SKILLS.map((skill) => skill.name)).toContain(
      "writing-system-prompts",
    );
  });

  test("descriptions are person-facing — no lab or intern captions", () => {
    for (const skill of DEFAULT_SKILLS) {
      const surface = `${skill.description}\n${skill.body}`.toLowerCase();
      expect(surface).not.toMatch(/\blab\b/);
      expect(surface).not.toMatch(/\bintern\b/);
    }
  });
});
