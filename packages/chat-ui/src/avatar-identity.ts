import { colorForPrincipal } from "@corbits/presence/color";

/**
 * A person's generated fallback fill for react-ui's `Avatar`, which has no
 * `style` prop — only `className` — because its own tone system is a
 * closed enum reserved for agent identity (`AvatarTone`). These two CSS
 * custom properties are meant to be set on an ancestor element (they
 * inherit down the DOM to the `Avatar`'s own root span, which reads them
 * back through the `avatar-identity-generated` class in `app.css`) rather
 * than passed as a prop react-ui doesn't accept.
 */
export type GeneratedAvatarStyle = {
  readonly "--avatar-identity-bg": string;
  readonly "--avatar-identity-fg": string;
};

/** The className that reads `GeneratedAvatarStyle`'s custom properties
 * back into an actual background/text pair. Apply to the `Avatar` itself
 * (or the bespoke `.chat-presence-avatar` chip); the style values belong
 * on an ancestor. */
export const AVATAR_IDENTITY_CLASS = "avatar-identity-generated";

const HSL_PATTERN =
  /^hsl\((\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%\)$/;

function hslToRgb(
  h: number,
  s: number,
  l: number,
): readonly [number, number, number] {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) =>
    light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [
    Math.round(f(0) * 255),
    Math.round(f(8) * 255),
    Math.round(f(4) * 255),
  ];
}

function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * The legible initials color (pure black or pure white — never a
 * mid-tone) for a `colorForPrincipal` background, chosen by WCAG
 * relative luminance so a generated avatar stays readable regardless of
 * which hue the hash lands on. `colorForPrincipal` fixes saturation and
 * lightness but the hue swings the whole 0-360 range, so no single fixed
 * text color clears contrast for every hash.
 */
export function readableTextOn(background: string): string {
  const match = HSL_PATTERN.exec(background);
  if (match === null) return "#ffffff";
  const [, h, s, l] = match;
  const [r, g, b] = hslToRgb(Number(h), Number(s), Number(l));
  return relativeLuminance(r, g, b) > 0.4 ? "#000000" : "#ffffff";
}

/**
 * A stable, per-principal fill for a human's fallback avatar. Reuses
 * `@corbits/presence`'s `colorForPrincipal` — the app's one existing
 * deterministic-identity-color function, already shipped for live
 * cursors/presence dots (CL-6328) — rather than a second hashing scheme,
 * paired with a computed readable text color. Never derived from render
 * order or `Math.random()`: the same `principalId` always resolves to
 * the same pair, in every surface, for every viewer.
 */
export function generatedAvatarStyle(
  principalId: string,
): GeneratedAvatarStyle {
  const background = colorForPrincipal(principalId);
  return {
    "--avatar-identity-bg": background,
    "--avatar-identity-fg": readableTextOn(background),
  };
}

export type AvatarFill =
  | { readonly kind: "image"; readonly url: string }
  | { readonly kind: "generated"; readonly style: GeneratedAvatarStyle };

/**
 * Which fallback an avatar should render: an explicit image always wins
 * over the generated fill, when one is on hand (e.g. `UserProfile.image`
 * from better-auth) — the generated look is a fallback, not a
 * replacement for a real picture.
 */
export function resolveAvatarFill(
  principalId: string,
  explicitImageUrl?: string | null,
): AvatarFill {
  if (
    explicitImageUrl !== undefined &&
    explicitImageUrl !== null &&
    explicitImageUrl.length > 0
  ) {
    return { kind: "image", url: explicitImageUrl };
  }
  return { kind: "generated", style: generatedAvatarStyle(principalId) };
}
