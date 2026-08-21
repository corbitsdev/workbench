import { describe, expect, test } from "bun:test";

import { skillVersionSavedBy } from "./skill-version-author";

describe("skillVersionSavedBy", () => {
  test("a save made through the product reads as the product, not its git identity", () => {
    expect(skillVersionSavedBy("interchange-hub")).toBe("Workbench");
  });

  test("a real person's commit keeps their name", () => {
    expect(skillVersionSavedBy("Grace Hopper")).toBe("Grace Hopper");
  });

  test("surrounding whitespace does not smuggle the internal name through", () => {
    expect(skillVersionSavedBy("  interchange-hub  ")).toBe("Workbench");
  });
});
