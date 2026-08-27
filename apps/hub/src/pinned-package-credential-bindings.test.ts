import { describe, expect, test } from "bun:test";
import { bindingsForConnectedPins } from "./pinned-package-credential-bindings";

const MANUS_PIN = { name: "@corbits/manus-tools", version: "*" };
const GRANOLA_PIN = { name: "@corbits/granola-tools", version: "*" };

describe("bindingsForConnectedPins", () => {
  test("emits a manus tenant binding when manus-tools is pinned and Manus is connected", () => {
    expect(bindingsForConnectedPins([MANUS_PIN], ["manus"])).toEqual([
      {
        package: "@corbits/manus-tools",
        handle: "manus",
        provider: "manus",
        locator: "tenant",
      },
    ]);
  });

  test("returns none when manus-tools is pinned but Manus is not connected", () => {
    expect(bindingsForConnectedPins([MANUS_PIN], ["granola"])).toEqual([]);
  });

  test("returns none when Manus is connected but manus-tools is not pinned", () => {
    expect(bindingsForConnectedPins([GRANOLA_PIN], ["manus"])).toEqual([]);
  });

  test("emits a granola binding when granola-tools is pinned and Granola is connected", () => {
    expect(bindingsForConnectedPins([GRANOLA_PIN], ["granola"])).toEqual([
      {
        package: "@corbits/granola-tools",
        handle: "granola",
        provider: "granola",
        locator: "tenant",
      },
    ]);
  });

  test("returns none for empty pins even when connectors are connected", () => {
    expect(bindingsForConnectedPins([], ["manus", "granola"])).toEqual([]);
  });
});
