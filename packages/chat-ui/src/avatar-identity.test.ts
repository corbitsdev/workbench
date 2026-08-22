import { describe, expect, test } from "bun:test";

import {
  generatedAvatarStyle,
  readableTextOn,
  resolveAvatarFill,
} from "./avatar-identity";

describe("generatedAvatarStyle", () => {
  test("is deterministic for the same principal", () => {
    expect(generatedAvatarStyle("prn_alice")).toEqual(
      generatedAvatarStyle("prn_alice"),
    );
  });

  test("differs across distinct principals", () => {
    const alice = generatedAvatarStyle("prn_alice");
    const bob = generatedAvatarStyle("prn_bob");
    expect(alice["--avatar-identity-bg"]).not.toBe(bob["--avatar-identity-bg"]);
  });

  test("never displays the seed itself", () => {
    const style = generatedAvatarStyle("prn_super_secret_internal_id");
    const values = Object.values(style).join(" ");
    expect(values).not.toContain("prn_super_secret_internal_id");
  });
});

describe("readableTextOn", () => {
  test("picks a legible label color across the full hue range", () => {
    // A spread of hand-picked HSL backgrounds spanning light and dark
    // lightness at the generator's fixed saturation/lightness — every
    // one of them must resolve to pure black or pure white, never a
    // mid-tone that would read as washed out on either.
    const seeds = [
      "prn_a",
      "prn_b",
      "prn_c",
      "prn_d",
      "prn_e",
      "prn_f",
      "prn_g",
      "prn_h",
    ];
    for (const seed of seeds) {
      const { "--avatar-identity-bg": bg, "--avatar-identity-fg": fg } =
        generatedAvatarStyle(seed);
      expect(["#000000", "#ffffff"]).toContain(fg);
      expect(bg.startsWith("hsl(")).toBe(true);
    }
  });

  test("is deterministic for the same background", () => {
    const bg = "hsl(210 65% 45%)";
    expect(readableTextOn(bg)).toBe(readableTextOn(bg));
  });

  test("falls back to a safe default for an unrecognized format", () => {
    expect(readableTextOn("not-a-color")).toBe("#ffffff");
  });
});

describe("resolveAvatarFill", () => {
  test("a principal with no explicit image gets the generated fill", () => {
    const fill = resolveAvatarFill("prn_alice");
    expect(fill.kind).toBe("generated");
  });

  test("a principal with an explicit image still uses it", () => {
    const fill = resolveAvatarFill("prn_alice", "https://example.com/a.png");
    expect(fill).toEqual({
      kind: "image",
      url: "https://example.com/a.png",
    });
  });

  test("an empty image string is treated as no image", () => {
    const fill = resolveAvatarFill("prn_alice", "");
    expect(fill.kind).toBe("generated");
  });
});
