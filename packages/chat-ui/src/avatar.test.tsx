import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AVATAR_COLORS,
  CORBIT_DEFAULT_COLOR,
  CORBIT_GLINT_COLOR,
  CORBIT_VISOR_COLOR,
  CorbitAvatar,
  avatarColorForPrincipal,
  generatedAvatarStyle,
  readableTextOn,
  resolveAvatarFill,
} from "./avatar";

describe("avatarColorForPrincipal", () => {
  test("is deterministic for the same principal", () => {
    expect(avatarColorForPrincipal("prn_alice")).toBe(
      avatarColorForPrincipal("prn_alice"),
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
      expect(AVATAR_COLORS).toContain(avatarColorForPrincipal(p));
    }
  });

  test("distributes distinct principals across palette colors", () => {
    const colors = new Set(
      ["prn_alice", "prn_bob", "prn_carla", "prn_dana"].map(
        avatarColorForPrincipal,
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
    expect(AVATAR_COLORS).toContain(
      style["--avatar-identity-bg"] as (typeof AVATAR_COLORS)[number],
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
    for (const color of AVATAR_COLORS) {
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
      expect(AVATAR_COLORS).toContain(
        fill.style["--avatar-identity-bg"] as (typeof AVATAR_COLORS)[number],
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

describe("CorbitAvatar", () => {
  test("renders an SVG with an accessible name and no visible label", () => {
    const html = renderToStaticMarkup(
      <CorbitAvatar ariaLabel="Myra" size="md" />,
    );
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Myra"');
    expect(html).toContain('data-corbit="true"');
    expect(html).toContain("<svg");
    expect(html).not.toContain("title=");
    expect(html).not.toContain(">Myra<");
  });

  test("uses the selected palette color", () => {
    const defaultHtml = renderToStaticMarkup(<CorbitAvatar />);
    expect(defaultHtml).toContain(`fill="${CORBIT_DEFAULT_COLOR}"`);

    const colorHtml = renderToStaticMarkup(<CorbitAvatar color="#C1D1BE" />);
    expect(colorHtml).toContain('fill="#C1D1BE"');
  });

  test("contains the visor and glint geometry", () => {
    const html = renderToStaticMarkup(<CorbitAvatar />);
    expect(html).toContain(`fill="${CORBIT_VISOR_COLOR}"`);
    expect(html).toContain(`fill="${CORBIT_GLINT_COLOR}"`);
  });

  test("supports named and numeric sizes", () => {
    const namedHtml = renderToStaticMarkup(<CorbitAvatar size="sm" />);
    expect(namedHtml).toContain("size-6");

    const numericHtml = renderToStaticMarkup(<CorbitAvatar size={28} />);
    expect(numericHtml).toContain("width:28px");
    expect(numericHtml).toContain("height:28px");
  });
});
