import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CorbitAvatar,
  CORBIT_DEFAULT_BACKGROUND,
  PASTEL_PALETTE,
  generatedAvatarStyle,
  pastelColorForPrincipal,
  resolveAvatarFill,
} from "../src";

describe("avatar composition and identity resolution", () => {
  test("agent Corbit avatar is distinct from human initials avatar", () => {
    const corbitHtml = renderToStaticMarkup(
      <CorbitAvatar label="Echo Agent" size="md" />,
    );
    // Agent Corbit has SVG geometry, role=img, data-corbit, and no initials text node
    expect(corbitHtml).toContain('data-corbit="true"');
    expect(corbitHtml).toContain('aria-label="Echo Agent"');
    expect(corbitHtml).toContain("<svg");
    expect(corbitHtml).toContain(CORBIT_DEFAULT_BACKGROUND);
    expect(corbitHtml).not.toContain(">EA<");
  });

  test("people without photos receive deterministic light pastel initials fallback", () => {
    const aliceColor = pastelColorForPrincipal("usr_alice");
    const bobColor = pastelColorForPrincipal("usr_bob");

    expect(PASTEL_PALETTE).toContain(aliceColor);
    expect(PASTEL_PALETTE).toContain(bobColor);

    const aliceStyle = generatedAvatarStyle("usr_alice");
    expect(aliceStyle["--avatar-identity-bg"]).toBe(aliceColor);
    expect(aliceStyle["--avatar-identity-fg"]).toBe("#000000");

    // Same user always gets the exact same pastel color
    expect(pastelColorForPrincipal("usr_alice")).toBe(aliceColor);
  });

  test("human explicit image takes precedence over pastel initials fallback", () => {
    const withImage = resolveAvatarFill(
      "usr_alice",
      "https://example.com/avatar.jpg",
    );
    expect(withImage.kind).toBe("image");
    if (withImage.kind === "image") {
      expect(withImage.url).toBe("https://example.com/avatar.jpg");
    }

    const withoutImage = resolveAvatarFill("usr_alice", null);
    expect(withoutImage.kind).toBe("generated");
    if (withoutImage.kind === "generated") {
      expect(PASTEL_PALETTE).toContain(
        withoutImage.style[
          "--avatar-identity-bg"
        ] as (typeof PASTEL_PALETTE)[number],
      );
    }
  });

  test("dense avatar context: multiple agents and humans remain visually distinct", () => {
    const participants = [
      { id: "agent_myra", name: "Myra", isAgent: true },
      { id: "agent_scout", name: "Scout", isAgent: true },
      { id: "user_carla", name: "Carla", isAgent: false },
      { id: "user_dana", name: "Dana", isAgent: false },
    ];

    const rendered = participants.map((p) => {
      if (p.isAgent) {
        return renderToStaticMarkup(<CorbitAvatar label={p.name} size="sm" />);
      }
      const style = generatedAvatarStyle(p.id);
      return renderToStaticMarkup(
        <span style={style as React.CSSProperties} data-testid="human-avatar">
          {p.name.slice(0, 1)}
        </span>,
      );
    });

    // Agents have data-corbit and svg, humans have initials and pastel style
    expect(rendered[0]).toContain('data-corbit="true"');
    expect(rendered[1]).toContain('data-corbit="true"');
    expect(rendered[2]).toContain('data-testid="human-avatar"');
    expect(rendered[2]).toContain("C");
    expect(rendered[3]).toContain('data-testid="human-avatar"');
    expect(rendered[3]).toContain("D");
  });
});
