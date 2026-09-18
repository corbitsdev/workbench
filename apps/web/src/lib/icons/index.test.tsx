import { describe, expect, test } from "bun:test";

import * as icons from "./index";

describe("@/lib/icons", () => {
  test("never exports a Sparkle glyph", () => {
    const names = Object.keys(icons);
    const sparkleNames = names.filter((name) => /sparkle/i.test(name));
    expect(sparkleNames).toEqual([]);
  });

  test("re-exports the bold icon provider and icon type", () => {
    expect(typeof icons.BoldIconProvider).toBe("function");
  });

  // Regression: a bare `{ weight: "bold" }` silently drops Phosphor's own
  // `size` default, since the context value is replaced, not merged.
  test("BoldIconProvider preserves Phosphor's size default alongside bold weight", () => {
    expect(icons.boldIconContextValue).toEqual({
      size: "1em",
      weight: "bold",
    });
  });
});
