import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AVATAR_COLORS,
  CORBIT_DEFAULT_COLOR,
  CORBIT_GLINT_COLOR,
  CORBIT_VISOR_COLOR,
  CorbitAvatar,
  avatarClassForPrincipal,
  avatarColorClass,
  avatarColorForPrincipal,
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

describe("avatarClassForPrincipal", () => {
  test("is deterministic for the same principal", () => {
    expect(avatarClassForPrincipal("prn_alice")).toBe(
      avatarClassForPrincipal("prn_alice"),
    );
  });

  test("never displays the seed itself", () => {
    expect(
      avatarClassForPrincipal("prn_super_secret_internal_id"),
    ).not.toContain("prn_super_secret_internal_id");
  });
});

describe("avatar pastel tokens", () => {
  test("the palette is token references, not hardcoded hex", () => {
    expect(AVATAR_COLORS).toHaveLength(4);
    for (const color of AVATAR_COLORS) {
      expect(color.startsWith("--avatar-")).toBe(true);
      expect(color).not.toContain("#");
    }
  });

  test("every class pairs its token with the readable ink", () => {
    for (const color of AVATAR_COLORS) {
      const cls = avatarColorClass[color];
      expect(cls).toContain(`bg-(${color})`);
      expect(cls).toContain("text-black");
      expect(cls).not.toContain("#");
    }
  });
});

describe("resolveAvatarFill", () => {
  test("a principal with no explicit image gets the generated fill", () => {
    const fill = resolveAvatarFill("prn_alice");
    expect(fill.kind).toBe("generated");
    if (fill.kind === "generated") {
      expect(fill.className).toBe(avatarClassForPrincipal("prn_alice"));
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
  test("paints its field from the identity token", () => {
    const html = renderToStaticMarkup(<CorbitAvatar />);
    expect(html).toContain(`fill:var(${CORBIT_DEFAULT_COLOR})`);
    // The field's old hardcoded fill is gone. The shared visor/glint face
    // geometry keeps its fixed constants — it is identical on every agent,
    // so it was never part of the per-principal identity palette.
    expect(html).not.toContain('fill="#C5D2DE"');
  });

  test("a chosen palette token paints the field", () => {
    const html = renderToStaticMarkup(<CorbitAvatar color="--avatar-3" />);
    expect(html).toContain("fill:var(--avatar-3)");
  });
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
