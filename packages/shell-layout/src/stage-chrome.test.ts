import { describe, expect, test } from "bun:test";

import { deriveCol2Width } from "./stage-chrome";

describe("deriveCol2Width", () => {
  test("defaults to normal", () => {
    expect(
      deriveCol2Width({
        userCollapsed: false,
        canvasFocused: false,
        wideRoute: false,
      }),
    ).toBe("normal");
  });

  test("the user's collapse choice wins over normal", () => {
    expect(
      deriveCol2Width({
        userCollapsed: true,
        canvasFocused: false,
        wideRoute: false,
      }),
    ).toBe("collapsed");
  });

  test("a wide route (Talk to Myra) widens col2", () => {
    expect(
      deriveCol2Width({
        userCollapsed: false,
        canvasFocused: false,
        wideRoute: true,
      }),
    ).toBe("wide");
  });

  test("canvas focus collapses col2 even on a wide route", () => {
    expect(
      deriveCol2Width({
        userCollapsed: false,
        canvasFocused: true,
        wideRoute: true,
      }),
    ).toBe("collapsed");
  });

  test("canvas focus wins over a user collapse choice too (both mean collapsed)", () => {
    expect(
      deriveCol2Width({
        userCollapsed: true,
        canvasFocused: true,
        wideRoute: true,
      }),
    ).toBe("collapsed");
  });

  test("the user's collapse choice wins over a wide route", () => {
    expect(
      deriveCol2Width({
        userCollapsed: true,
        canvasFocused: false,
        wideRoute: true,
      }),
    ).toBe("collapsed");
  });
});
