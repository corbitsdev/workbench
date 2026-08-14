import { describe, expect, test } from "bun:test";

import {
  col2CollapsedFromPreferences,
  COL2_COLLAPSED_PREFERENCE_KEY,
} from "./col2-preference";

describe("col2CollapsedFromPreferences", () => {
  test("hydrates collapsed when the stored preference is exactly true", () => {
    expect(
      col2CollapsedFromPreferences({ [COL2_COLLAPSED_PREFERENCE_KEY]: true }),
    ).toBe(true);
  });

  test("defaults to open when the key is absent (fresh account, no reload yet)", () => {
    expect(col2CollapsedFromPreferences({})).toBe(false);
  });

  test("defaults to open when the stored value is explicitly false", () => {
    expect(
      col2CollapsedFromPreferences({
        [COL2_COLLAPSED_PREFERENCE_KEY]: false,
      }),
    ).toBe(false);
  });

  test("defaults to open for a non-boolean stored value rather than throwing", () => {
    expect(
      col2CollapsedFromPreferences({
        [COL2_COLLAPSED_PREFERENCE_KEY]: "true",
      }),
    ).toBe(false);
  });

  test("ignores unrelated preference keys", () => {
    expect(
      col2CollapsedFromPreferences({ "shell.theme": "dark", other: 1 }),
    ).toBe(false);
  });
});
