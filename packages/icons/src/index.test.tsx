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

  // Regression for the oversized right-click menu / search bar: Phosphor's
  // IconContext.Provider fully replaces the context value rather than
  // merging with it, so a bare `{ weight: "bold" }` silently drops the
  // library's own `size: "1em"` default. Any glyph mounted without an
  // ancestor CSS rule or an explicit `size=` prop then renders as a bare
  // <svg> with no width/height, which the browser falls back to sizing as
  // a 300x150 replaced element.
  test("BoldIconProvider preserves Phosphor's size default alongside bold weight", () => {
    expect(icons.boldIconContextValue).toEqual({
      size: "1em",
      weight: "bold",
    });
  });
});
