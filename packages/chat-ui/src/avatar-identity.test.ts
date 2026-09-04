import { describe, expect, test } from "bun:test";

import {
  generatedAvatarStyle,
  pastelColorForPrincipal,
  readableTextOn,
  resolveAvatarFill,
  PASTEL_PALETTE,
} from "./avatar-identity";

describe("pastelColorForPrincipal", () => {
  test("is deterministic for the same principal", () => {
    expect(pastelColorForPrincipal("prn_alice")).toBe(
      pastelColorForPrincipal("prn_alice"),
    );
  });

  test("always returns a color from the approved pastel palette", () => {
    const principals = [
      "prn_alice",
      "prn_bob",
      "prn_carla",
      "prn_dana",
      "prn_eve",
      "prn_frank",
    ];
    for (const p of principals) {
      expect(PASTEL_PALETTE).toContain(pastelColorForPrincipal(p));
    }
  });

  test("distributes distinct principals across palette colors", () => {
    const colors = new Set(
      ["prn_alice", "prn_bob", "prn_carla", "prn_dana"].map(
        pastelColorForPrincipal,
      ),
    );
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe("generatedAvatarStyle", () => {
  test("is deterministic for the same principal", () => {
    expect(generatedAvatarStyle("prn_alice")).toEqual(
      generatedAvatarStyle("prn_alice"),
    );
  });

  test("uses pastel palette background and legible foreground", () => {
    const style = generatedAvatarStyle("prn_alice");
    expect(PASTEL_PALETTE).toContain(
      style["--avatar-identity-bg"] as (typeof PASTEL_PALETTE)[number],
    );
    expect(["#000000", "#ffffff"]).toContain(style["--avatar-identity-fg"]);
  });

  test("never displays the seed itself", () => {
    const style = generatedAvatarStyle("prn_super_secret_internal_id");
    const values = Object.values(style).join(" ");
    expect(values).not.toContain("prn_super_secret_internal_id");
  });
});

describe("readableTextOn", () => {
  test("picks a legible label color across the pastel palette", () => {
    for (const color of PASTEL_PALETTE) {
      expect(readableTextOn(color)).toBe("#000000");
    }
  });

  test("supports both hex and hsl colors", () => {
    expect(readableTextOn("#FFFFFF")).toBe("#000000");
    expect(readableTextOn("#000000")).toBe("#ffffff");
    expect(readableTextOn("hsl(0 0% 100%)")).toBe("#000000");
    expect(readableTextOn("hsl(0 0% 0%)")).toBe("#ffffff");
  });

  test("is deterministic for the same background", () => {
    const bg = "#C5D2DE";
    expect(readableTextOn(bg)).toBe(readableTextOn(bg));
  });

  test("falls back to a safe default for an unrecognized format", () => {
    expect(readableTextOn("not-a-color")).toBe("#000000");
  });
});

describe("resolveAvatarFill", () => {
  test("a principal with no explicit image gets the generated fill", () => {
    const fill = resolveAvatarFill("prn_alice");
    expect(fill.kind).toBe("generated");
    if (fill.kind === "generated") {
      expect(PASTEL_PALETTE).toContain(
        fill.style["--avatar-identity-bg"] as (typeof PASTEL_PALETTE)[number],
      );
    }
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
