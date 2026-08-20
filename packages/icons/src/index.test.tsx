import { describe, expect, test } from "bun:test";

import * as icons from "./index";

describe("@corbits/icons", () => {
  test("never exports a Sparkle glyph", () => {
    const names = Object.keys(icons);
    const sparkleNames = names.filter((name) => /sparkle/i.test(name));
    expect(sparkleNames).toEqual([]);
  });

  test("re-exports the bold icon provider and icon type", () => {
    expect(typeof icons.BoldIconProvider).toBe("function");
  });
});
